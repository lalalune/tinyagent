import {
  lstat,
  mkdir,
  mkdtemp,
  open,
  readdir,
  readFile,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { join, relative } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { ok, tinyagentKvPath, type Store } from "@tinyagent/core";
import { deriveBackupKeypair } from "@tinyagent/crypto";
import { backupDirectory, gcBackups, restoreDirectory } from "./backup.js";
import { MemoryStore } from "./memory-store.js";

describe("backupDirectory/restoreDirectory", () => {
  it("backs up, seals, and restores a directory", async () => {
    const root = await mkdtemp(join(tmpdir(), "tinyagent-src-"));
    const target = await mkdtemp(join(tmpdir(), "tinyagent-dst-"));
    await mkdir(join(root, "memory"), { recursive: true });
    await writeFile(join(root, "memory", "note.txt"), "agent remembers this\n");
    await writeFile(
      join(root, "config.json"),
      JSON.stringify({ token: "redacted-in-real-pack" }),
    );

    const keypair = await deriveBackupKeypair(
      "space",
      new Uint8Array(65).fill(4),
    );
    const store = new MemoryStore();

    const backup = await backupDirectory({
      store,
      agent: "ada",
      pack: "fake-pack",
      stateDir: root,
      bpkId: keypair.publicKeyId,
      backupPublicKey: keypair.publicKey,
      chunkSize: 32,
    });
    expect(backup.ok).toBe(true);
    if (!backup.ok) throw backup.error;
    expect(backup.value.chunks.length).toBeGreaterThan(1);

    const restored = await restoreDirectory({
      store,
      agent: "ada",
      targetDir: target,
      backupPublicKey: keypair.publicKey,
      backupPrivateKey: keypair.privateKey,
    });
    if (!restored.ok) throw restored.error;
    expect(restored.ok).toBe(true);

    await expect(
      readFile(join(target, "memory", "note.txt"), "utf8"),
    ).resolves.toBe("agent remembers this\n");
    await expect(treeBytes(target)).resolves.toEqual(await treeBytes(root));
  });

  it("refuses restore with the wrong wallet key", async () => {
    const root = await mkdtemp(join(tmpdir(), "tinyagent-src-"));
    const target = await mkdtemp(join(tmpdir(), "tinyagent-dst-"));
    await writeFile(join(root, "state.txt"), "state");

    const keypair = await deriveBackupKeypair(
      "space",
      new Uint8Array(65).fill(4),
    );
    const wrong = await deriveBackupKeypair(
      "space",
      new Uint8Array(65).fill(5),
    );
    const store = new MemoryStore();

    const backup = await backupDirectory({
      store,
      agent: "ada",
      pack: "fake-pack",
      stateDir: root,
      bpkId: keypair.publicKeyId,
      backupPublicKey: keypair.publicKey,
    });
    expect(backup.ok).toBe(true);

    const restored = await restoreDirectory({
      store,
      agent: "ada",
      targetDir: target,
      backupPublicKey: wrong.publicKey,
      backupPrivateKey: wrong.privateKey,
    });
    expect(restored.ok).toBe(false);
  });

  it("does not archive symlinked state entries", async () => {
    const root = await mkdtemp(join(tmpdir(), "tinyagent-src-"));
    const target = await mkdtemp(join(tmpdir(), "tinyagent-dst-"));
    await writeFile(join(root, "state.txt"), "state");
    await symlink("state.txt", join(root, "state-link"));

    const keypair = await deriveBackupKeypair(
      "space",
      new Uint8Array(65).fill(4),
    );
    const store = new MemoryStore();

    const backup = await backupDirectory({
      store,
      agent: "ada",
      pack: "fake-pack",
      stateDir: root,
      bpkId: keypair.publicKeyId,
      backupPublicKey: keypair.publicKey,
    });
    expect(backup.ok).toBe(true);

    const restored = await restoreDirectory({
      store,
      agent: "ada",
      targetDir: target,
      backupPublicKey: keypair.publicKey,
      backupPrivateKey: keypair.privateKey,
    });
    expect(restored.ok).toBe(true);

    await expect(readFile(join(target, "state.txt"), "utf8")).resolves.toBe(
      "state",
    );
    await expect(lstat(join(target, "state-link"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("backs up and restores a sparse file over 1 GiB", async () => {
    const root = await mkdtemp(join(tmpdir(), "tinyagent-src-"));
    const target = await mkdtemp(join(tmpdir(), "tinyagent-dst-"));
    const sourcePath = join(root, "large-sparse.bin");
    const restoredPath = join(target, "large-sparse.bin");
    const size = 1024 * 1024 * 1024 + 4096;
    const marker = Buffer.from("tinyagent-large-file-marker");
    const markerOffset = size - marker.byteLength;

    const source = await open(sourcePath, "w");
    try {
      await source.truncate(size);
      await source.write(marker, 0, marker.byteLength, markerOffset);
    } finally {
      await source.close();
    }

    const keypair = await deriveBackupKeypair(
      "space",
      new Uint8Array(65).fill(4),
    );
    const store = new MemoryStore();
    const backup = await backupDirectory({
      store,
      agent: "ada",
      pack: "fake-pack",
      stateDir: root,
      bpkId: keypair.publicKeyId,
      backupPublicKey: keypair.publicKey,
    });
    expect(backup.ok).toBe(true);
    if (!backup.ok) throw backup.error;

    const restored = await restoreDirectory({
      store,
      agent: "ada",
      targetDir: target,
      backupPublicKey: keypair.publicKey,
      backupPrivateKey: keypair.privateKey,
    });
    if (!restored.ok) throw restored.error;
    expect(restored.ok).toBe(true);

    await expect(stat(restoredPath)).resolves.toMatchObject({ size });
    await expect(
      readAt(restoredPath, markerOffset, marker.byteLength),
    ).resolves.toEqual(marker);
    await expect(readAt(restoredPath, 128 * 1024 * 1024, 32)).resolves.toEqual(
      Buffer.alloc(32),
    );
  }, 120000);

  it("does not rewrite unchanged chunks", async () => {
    const root = await mkdtemp(join(tmpdir(), "tinyagent-src-"));
    await writeFile(join(root, "state.txt"), "same state".repeat(20));

    const keypair = await deriveBackupKeypair(
      "space",
      new Uint8Array(65).fill(4),
    );
    const backing = new MemoryStore();
    const store = new CountingStore(backing);
    const input = {
      store,
      agent: "ada",
      pack: "fake-pack",
      stateDir: root,
      bpkId: keypair.publicKeyId,
      backupPublicKey: keypair.publicKey,
      chunkSize: 24,
    };

    const first = await backupDirectory(input);
    expect(first.ok).toBe(true);
    const firstChunkWrites = store.chunkPuts;

    const second = await backupDirectory(input);
    expect(second.ok).toBe(true);
    expect(store.chunkPuts).toBe(firstChunkWrites);
  });

  it("rejects a corrupt manifest", async () => {
    const root = await mkdtemp(join(tmpdir(), "tinyagent-src-"));
    const target = await mkdtemp(join(tmpdir(), "tinyagent-dst-"));
    await writeFile(join(root, "state.txt"), "state");

    const keypair = await deriveBackupKeypair(
      "space",
      new Uint8Array(65).fill(4),
    );
    const store = new MemoryStore();
    const backup = await backupDirectory({
      store,
      agent: "ada",
      pack: "fake-pack",
      stateDir: root,
      bpkId: keypair.publicKeyId,
      backupPublicKey: keypair.publicKey,
    });
    expect(backup.ok).toBe(true);

    const latest = await store.get(tinyagentKvPath("ada", "latest"));
    if (!latest.ok) throw latest.error;
    await store.put({
      key: tinyagentKvPath(
        "ada",
        `snapshots/${new TextDecoder().decode(latest.value)}`,
      ),
      bytes: new TextEncoder().encode("{"),
    });

    const restored = await restoreDirectory({
      store,
      agent: "ada",
      targetDir: target,
      backupPublicKey: keypair.publicKey,
      backupPrivateKey: keypair.privateKey,
    });
    expect(restored.ok).toBe(false);
  });

  it("rejects corrupt stored chunk data", async () => {
    const root = await mkdtemp(join(tmpdir(), "tinyagent-src-"));
    const target = await mkdtemp(join(tmpdir(), "tinyagent-dst-"));
    await writeFile(join(root, "state.txt"), "state");

    const keypair = await deriveBackupKeypair(
      "space",
      new Uint8Array(65).fill(4),
    );
    const store = new MemoryStore();
    const backup = await backupDirectory({
      store,
      agent: "ada",
      pack: "fake-pack",
      stateDir: root,
      bpkId: keypair.publicKeyId,
      backupPublicKey: keypair.publicKey,
    });
    if (!backup.ok) throw backup.error;

    await store.put({
      key: tinyagentKvPath("ada", `chunks/${backup.value.chunks[0]!.hash}`),
      bytes: new Uint8Array([1, 2, 3, 4]),
    });

    const restored = await restoreDirectory({
      store,
      agent: "ada",
      targetDir: target,
      backupPublicKey: keypair.publicKey,
      backupPrivateKey: keypair.privateKey,
    });
    expect(restored.ok).toBe(false);
  });

  it("garbage-collects old snapshots and unreferenced chunks", async () => {
    const root = await mkdtemp(join(tmpdir(), "tinyagent-src-"));
    const target = await mkdtemp(join(tmpdir(), "tinyagent-dst-"));
    await writeFile(join(root, "state.txt"), "first");

    const keypair = await deriveBackupKeypair(
      "space",
      new Uint8Array(65).fill(4),
    );
    const store = new MemoryStore();

    const first = await backupAt(
      store,
      root,
      keypair,
      "2026-06-01T00:00:00.000Z",
    );
    await writeFile(join(root, "state.txt"), "second");
    const second = await backupAt(
      store,
      root,
      keypair,
      "2026-06-02T00:00:00.000Z",
    );
    await writeFile(join(root, "state.txt"), "third");
    const third = await backupAt(
      store,
      root,
      keypair,
      "2026-06-03T00:00:00.000Z",
    );

    const gc = await gcBackups({ store, agent: "ada", keepLast: 1 });
    expect(gc.ok).toBe(true);
    if (!gc.ok) throw gc.error;
    expect(gc.value.keptSnapshots).toEqual([
      "2026-06-03T00:00:00.000Z.manifest",
    ]);
    expect(gc.value.deletedSnapshots).toEqual([
      "2026-06-02T00:00:00.000Z.manifest",
      "2026-06-01T00:00:00.000Z.manifest",
    ]);
    expect(gc.value.deletedChunks.length).toBeGreaterThan(0);

    const removed = await restoreDirectory({
      store,
      agent: "ada",
      targetDir: target,
      backupPublicKey: keypair.publicKey,
      backupPrivateKey: keypair.privateKey,
      version: `${first.timestamp}.manifest`,
    });
    expect(removed.ok).toBe(false);

    const restoredLatest = await restoreDirectory({
      store,
      agent: "ada",
      targetDir: target,
      backupPublicKey: keypair.publicKey,
      backupPrivateKey: keypair.privateKey,
      version: `${third.timestamp}.manifest`,
    });
    expect(restoredLatest.ok).toBe(true);
    await expect(readFile(join(target, "state.txt"), "utf8")).resolves.toBe(
      "third",
    );

    expect(second.timestamp).toBe("2026-06-02T00:00:00.000Z");
  });

  it("keeps shared chunks referenced by retained snapshots", async () => {
    const root = await mkdtemp(join(tmpdir(), "tinyagent-src-"));
    await writeFile(join(root, "state.txt"), "same state");

    const keypair = await deriveBackupKeypair(
      "space",
      new Uint8Array(65).fill(4),
    );
    const store = new MemoryStore();

    const first = await backupAt(
      store,
      root,
      keypair,
      "2026-06-01T00:00:00.000Z",
    );
    const second = await backupAt(
      store,
      root,
      keypair,
      "2026-06-02T00:00:00.000Z",
    );
    expect(first.chunks.map((chunk) => chunk.hash)).toEqual(
      second.chunks.map((chunk) => chunk.hash),
    );

    const gc = await gcBackups({ store, agent: "ada", keepLast: 1 });
    expect(gc.ok).toBe(true);
    if (!gc.ok) throw gc.error;
    expect(gc.value.deletedSnapshots).toEqual([
      "2026-06-01T00:00:00.000Z.manifest",
    ]);
    expect(gc.value.deletedChunks).toEqual([]);
  });

  it("keeps newest snapshots that fit within a chunk-byte quota", async () => {
    const root = await mkdtemp(join(tmpdir(), "tinyagent-src-"));
    await writeFile(join(root, "state.txt"), "first-state".repeat(20));

    const keypair = await deriveBackupKeypair(
      "space",
      new Uint8Array(65).fill(4),
    );
    const store = new MemoryStore();

    await backupAt(store, root, keypair, "2026-06-01T00:00:00.000Z");
    await writeFile(join(root, "state.txt"), "second-state".repeat(20));
    const second = await backupAt(
      store,
      root,
      keypair,
      "2026-06-02T00:00:00.000Z",
    );
    await writeFile(join(root, "state.txt"), "third-state".repeat(20));
    const third = await backupAt(
      store,
      root,
      keypair,
      "2026-06-03T00:00:00.000Z",
    );

    const quotaBytes = await encryptedChunkBytes(store, [
      ...second.chunks.map((chunk) => chunk.hash),
      ...third.chunks.map((chunk) => chunk.hash),
    ]);
    const gc = await gcBackups({
      store,
      agent: "ada",
      keepLast: 1,
      maxBytes: quotaBytes,
    });

    expect(gc.ok).toBe(true);
    if (!gc.ok) throw gc.error;
    expect(gc.value.quotaBytes).toBe(quotaBytes);
    expect(gc.value.retainedBytes).toBeLessThanOrEqual(quotaBytes);
    expect(gc.value.keptSnapshots).toEqual([
      "2026-06-03T00:00:00.000Z.manifest",
      "2026-06-02T00:00:00.000Z.manifest",
    ]);
    expect(gc.value.deletedSnapshots).toEqual([
      "2026-06-01T00:00:00.000Z.manifest",
    ]);
  });

  it("rejects quotas that cannot retain the required latest snapshot", async () => {
    const root = await mkdtemp(join(tmpdir(), "tinyagent-src-"));
    await writeFile(join(root, "state.txt"), "state".repeat(20));

    const keypair = await deriveBackupKeypair(
      "space",
      new Uint8Array(65).fill(4),
    );
    const store = new MemoryStore();

    await backupAt(store, root, keypair, "2026-06-01T00:00:00.000Z");
    const gc = await gcBackups({
      store,
      agent: "ada",
      keepLast: 1,
      maxBytes: 0,
    });

    expect(gc.ok).toBe(false);
    expect(!gc.ok && "code" in gc.error && gc.error.code).toBe(
      "BACKUP_GC_QUOTA_TOO_SMALL",
    );
  });
});

async function backupAt(
  store: Store,
  stateDir: string,
  keypair: Awaited<ReturnType<typeof deriveBackupKeypair>>,
  timestamp: string,
) {
  const backup = await backupDirectory({
    store,
    agent: "ada",
    pack: "fake-pack",
    stateDir,
    bpkId: keypair.publicKeyId,
    backupPublicKey: keypair.publicKey,
    now: () => new Date(timestamp),
  });
  if (!backup.ok) throw backup.error;
  return backup.value;
}

async function encryptedChunkBytes(
  store: Store,
  hashes: string[],
): Promise<number> {
  const unique = new Set(hashes);
  let bytes = 0;
  for (const hash of unique) {
    const head = await store.head(tinyagentKvPath("ada", `chunks/${hash}`));
    if (!head.ok || head.value === null) {
      throw new Error(`missing chunk head: ${hash}`);
    }
    bytes += head.value.size;
  }
  return bytes;
}

class CountingStore implements Store {
  chunkPuts = 0;

  constructor(private readonly inner: Store) {}

  async put(input: Parameters<Store["put"]>[0]) {
    if (input.key.includes("/chunks/")) this.chunkPuts += 1;
    return this.inner.put(input);
  }

  async get(key: string) {
    return this.inner.get(key);
  }

  async head(key: string) {
    return this.inner.head(key);
  }

  async list(prefix: string) {
    return this.inner.list(prefix);
  }

  async delete(key: string) {
    return this.inner.delete?.(key) ?? ok(undefined);
  }
}

async function treeBytes(root: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  await collectTreeBytes(root, root, out);
  return out;
}

async function readAt(
  path: string,
  offset: number,
  length: number,
): Promise<Buffer> {
  const handle = await open(path, "r");
  const buffer = Buffer.alloc(length);
  try {
    const { bytesRead } = await handle.read(buffer, 0, length, offset);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

async function collectTreeBytes(
  root: string,
  dir: string,
  out: Record<string, string>,
): Promise<void> {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      await collectTreeBytes(root, path, out);
    } else if (entry.isFile()) {
      out[relative(root, path).split("\\").join("/")] = Buffer.from(
        await readFile(path),
      ).toString("base64");
    }
  }
}
