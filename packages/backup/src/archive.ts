import {
  chmod,
  open,
  readdir,
  readFile,
  mkdir,
  stat,
  writeFile,
} from "node:fs/promises";
import { dirname, join, relative } from "node:path";

const SPARSE_SCAN_THRESHOLD = 64 * 1024 * 1024;
const SPARSE_SCAN_CHUNK = 1024 * 1024;

type ArchiveEntry = FileArchiveEntry | SparseArchiveEntry;

interface FileArchiveEntry {
  type?: "file";
  path: string;
  mode: number;
  data: string;
}

interface SparseArchiveEntry {
  type: "sparse-file";
  path: string;
  mode: number;
  size: number;
  extents: Array<{ offset: number; data: string }>;
}

async function collectFiles(root: string, dir = root): Promise<ArchiveEntry[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const out: ArchiveEntry[] = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...(await collectFiles(root, abs)));
    } else if (entry.isFile()) {
      const fileStat = await stat(abs);
      const path = relative(root, abs).split("\\").join("/");
      if (fileStat.size >= SPARSE_SCAN_THRESHOLD) {
        out.push(await collectSparseFile(abs, path, fileStat.size));
        continue;
      }
      const data = await readFile(abs);
      out.push({
        path,
        mode: 0o600,
        data: Buffer.from(data).toString("base64"),
      });
    }
  }
  return out;
}

async function collectSparseFile(
  filePath: string,
  path: string,
  size: number,
): Promise<SparseArchiveEntry> {
  const handle = await open(filePath, "r");
  const buffer = Buffer.allocUnsafe(SPARSE_SCAN_CHUNK);
  const extents: SparseArchiveEntry["extents"] = [];
  try {
    for (let offset = 0; offset < size; offset += SPARSE_SCAN_CHUNK) {
      const length = Math.min(SPARSE_SCAN_CHUNK, size - offset);
      const { bytesRead } = await handle.read(buffer, 0, length, offset);
      if (bytesRead <= 0) break;
      const extent = nonZeroExtent(buffer.subarray(0, bytesRead));
      if (extent === undefined) continue;
      extents.push({
        offset: offset + extent.start,
        data: Buffer.from(buffer.subarray(extent.start, extent.end)).toString(
          "base64",
        ),
      });
    }
  } finally {
    await handle.close();
  }
  return { type: "sparse-file", path, mode: 0o600, size, extents };
}

function nonZeroExtent(
  bytes: Buffer,
): { start: number; end: number } | undefined {
  let start = 0;
  while (start < bytes.length && bytes[start] === 0) start += 1;
  if (start === bytes.length) return undefined;

  let end = bytes.length;
  while (end > start && bytes[end - 1] === 0) end -= 1;
  return { start, end };
}

export async function archiveDirectory(root: string): Promise<Uint8Array> {
  const archive = {
    version: 1,
    entries: await collectFiles(root),
  };
  return new TextEncoder().encode(JSON.stringify(archive));
}

export async function restoreArchive(
  bytes: Uint8Array,
  targetDir: string,
): Promise<void> {
  const parsed = JSON.parse(new TextDecoder().decode(bytes)) as {
    version: number;
    entries: ArchiveEntry[];
  };
  if (parsed.version !== 1 || !Array.isArray(parsed.entries)) {
    throw new Error("unsupported archive format");
  }

  for (const entry of parsed.entries) {
    if (entry.path.startsWith("/") || entry.path.includes("..")) {
      throw new Error(`unsafe archive path: ${entry.path}`);
    }
    const target = join(targetDir, entry.path);
    await mkdir(dirname(target), { recursive: true });
    if (entry.type === "sparse-file") {
      const handle = await open(target, "w+");
      try {
        await handle.truncate(entry.size);
        for (const extent of entry.extents) {
          const bytes = Buffer.from(extent.data, "base64");
          await handle.write(bytes, 0, bytes.byteLength, extent.offset);
        }
      } finally {
        await handle.close();
      }
      await chmod(target, entry.mode);
      continue;
    }
    await writeFile(target, Buffer.from(entry.data, "base64"), {
      mode: entry.mode,
    });
  }
}
