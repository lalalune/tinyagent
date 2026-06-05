import { mkdir, rm } from "node:fs/promises";
import { blake3 } from "@noble/hashes/blake3";
import {
  BackupManifestSchema,
  backupKvPaths,
  err,
  ok,
  TinyAgentError,
  tinyagentKvPath,
  type BackupManifest,
  type Result,
  type Store,
} from "@tinyagent/core";
import {
  decryptChunk,
  encryptChunk,
  openContentKey,
  randomBytes,
  sealContentKey,
} from "@tinyagent/crypto";
import { archiveDirectory, restoreArchive } from "./archive.js";
import {
  fastCdcChunks,
  fixedSizeChunks,
  type FastCdcOptions,
  type PlainChunk,
} from "./chunk.js";

export type ChunkerName = "fastcdc-v1" | "fixed-size-v0";

export interface BackupInput {
  store: Store;
  agent: string;
  pack: string;
  stateDir: string;
  bpkId: string;
  backupPublicKey: Uint8Array;
  chunker?: ChunkerName;
  chunkSize?: number;
  fastCdc?: FastCdcOptions;
  runnerImageDigest?: string;
  now?: () => Date;
}

export interface RestoreInput {
  store: Store;
  agent: string;
  targetDir: string;
  backupPublicKey: Uint8Array;
  backupPrivateKey: Uint8Array;
  version?: string;
}

export interface BackupGcInput {
  store: Store;
  agent: string;
  keepLast: number;
  maxBytes?: number;
}

export interface BackupGcResult {
  keptSnapshots: string[];
  deletedSnapshots: string[];
  deletedChunks: string[];
  retainedBytes: number;
  quotaBytes?: number;
}

function hashHex(bytes: Uint8Array): string {
  return Buffer.from(blake3(bytes)).toString("hex");
}

export async function backupDirectory(
  input: BackupInput,
): Promise<Result<BackupManifest>> {
  try {
    const archive = await archiveDirectory(input.stateDir);
    const contentKey = await randomBytes(32);
    const chunker: ChunkerName =
      input.chunker ??
      (input.chunkSize !== undefined ? "fixed-size-v0" : "fastcdc-v1");
    let chunks: PlainChunk[];
    if (chunker === "fixed-size-v0") {
      chunks = fixedSizeChunks(archive, input.chunkSize);
    } else {
      chunks = fastCdcChunks(archive, input.fastCdc);
    }
    const manifestChunks: BackupManifest["chunks"] = [];

    for (const chunk of chunks) {
      const plaintextHash = hashHex(chunk.bytes);
      const encrypted = await encryptChunk(chunk.bytes, contentKey);
      const key = tinyagentKvPath(input.agent, `chunks/${plaintextHash}`);
      const exists = await input.store.head(key);
      if (!exists.ok) return exists;
      if (!exists.value) {
        const put = await input.store.put({
          key,
          bytes: encrypted.ciphertext,
          contentType: "application/octet-stream",
        });
        if (!put.ok) return put;
      }
      manifestChunks.push({
        hash: plaintextHash,
        length: chunk.bytes.byteLength,
        nonce: encrypted.nonce,
      });
    }

    const timestamp = (input.now?.() ?? new Date()).toISOString();
    const manifest: BackupManifest = {
      version: 1,
      agent: input.agent,
      timestamp,
      pack: input.pack,
      stateDir: input.stateDir,
      chunks: manifestChunks,
      sealedContentKey: await sealContentKey(
        contentKey,
        input.backupPublicKey,
        input.bpkId,
      ),
      backupPublicKeyId: input.bpkId,
      integrity: {
        algorithm: "blake3",
        digest: hashHex(archive),
      },
      runnerImageDigest: input.runnerImageDigest ?? "local-unpinned",
      metadata: {
        chunker,
      },
    };

    BackupManifestSchema.parse(manifest);
    const manifestName = `${timestamp}.manifest`;
    const manifestPut = await input.store.put({
      key: tinyagentKvPath(input.agent, `snapshots/${manifestName}`),
      bytes: new TextEncoder().encode(JSON.stringify(manifest)),
      contentType: "application/json",
    });
    if (!manifestPut.ok) return manifestPut;
    const latestPut = await input.store.put({
      key: tinyagentKvPath(input.agent, "latest"),
      bytes: new TextEncoder().encode(manifestName),
      contentType: "text/plain",
    });
    if (!latestPut.ok) return latestPut;

    return ok(manifest);
  } catch (error) {
    return err(
      error instanceof Error
        ? error
        : new TinyAgentError("BACKUP_FAILED", String(error)),
    );
  }
}

export async function gcBackups(
  input: BackupGcInput,
): Promise<Result<BackupGcResult>> {
  try {
    if (input.keepLast < 1 || !Number.isInteger(input.keepLast)) {
      return err(
        new TinyAgentError(
          "BACKUP_GC_BAD_KEEP_LAST",
          "keepLast must be a positive integer",
        ),
      );
    }
    if (!input.store.delete) {
      return err(
        new TinyAgentError(
          "BACKUP_GC_DELETE_UNSUPPORTED",
          "store does not support delete",
        ),
      );
    }
    if (
      input.maxBytes !== undefined &&
      (!Number.isInteger(input.maxBytes) || input.maxBytes < 0)
    ) {
      return err(
        new TinyAgentError(
          "BACKUP_GC_BAD_MAX_BYTES",
          "maxBytes must be a non-negative integer",
        ),
      );
    }

    const paths = backupKvPaths(input.agent);
    const snapshotEntries = await input.store.list(paths.snapshotsPrefix);
    if (!snapshotEntries.ok) return snapshotEntries;

    const snapshots = await Promise.all(
      snapshotEntries.value
        .filter((entry) => entry.key.endsWith(".manifest"))
        .map(async (entry) => {
          const manifestBytes = await input.store.get(entry.key);
          if (!manifestBytes.ok) throw manifestBytes.error;
          const manifest = BackupManifestSchema.parse(
            JSON.parse(new TextDecoder().decode(manifestBytes.value)),
          );
          return {
            key: entry.key,
            version: entry.key.slice(paths.snapshotsPrefix.length),
            manifest,
          };
        }),
    );
    snapshots.sort((a, b) =>
      b.manifest.timestamp.localeCompare(a.manifest.timestamp),
    );

    const latest = await input.store.get(paths.latest);
    const latestVersion = latest.ok
      ? new TextDecoder().decode(latest.value)
      : undefined;
    const chunkEntries = await input.store.list(paths.chunksPrefix);
    if (!chunkEntries.ok) return chunkEntries;
    const chunkSizes = new Map(
      chunkEntries.value.map((entry) => [entry.key, entry.size]),
    );

    const keep = chooseSnapshotsToKeep({
      snapshots,
      chunksPrefix: paths.chunksPrefix,
      keepLast: input.keepLast,
      chunkSizes,
      ...(latestVersion !== undefined ? { latestVersion } : {}),
      ...(input.maxBytes !== undefined ? { maxBytes: input.maxBytes } : {}),
    });
    if (!keep.ok) return keep;

    const kept = snapshots.filter((snapshot) =>
      keep.value.versions.has(snapshot.version),
    );
    const removed = snapshots.filter(
      (snapshot) => !keep.value.versions.has(snapshot.version),
    );
    const referencedChunks = new Set(
      kept.flatMap((snapshot) =>
        snapshot.manifest.chunks.map(
          (chunk) => `${paths.chunksPrefix}${chunk.hash}`,
        ),
      ),
    );

    const deletedSnapshots: string[] = [];
    for (const snapshot of removed) {
      const deleted = await input.store.delete(snapshot.key);
      if (!deleted.ok) return deleted;
      deletedSnapshots.push(snapshot.version);
    }

    const deletedChunks: string[] = [];
    for (const chunk of chunkEntries.value) {
      if (referencedChunks.has(chunk.key)) continue;
      const deleted = await input.store.delete(chunk.key);
      if (!deleted.ok) return deleted;
      deletedChunks.push(chunk.key.slice(paths.chunksPrefix.length));
    }

    return ok({
      keptSnapshots: kept.map((snapshot) => snapshot.version),
      deletedSnapshots,
      deletedChunks,
      retainedBytes: keep.value.bytes,
      ...(input.maxBytes !== undefined ? { quotaBytes: input.maxBytes } : {}),
    });
  } catch (error) {
    return err(
      error instanceof Error
        ? error
        : new TinyAgentError("BACKUP_GC_FAILED", String(error)),
    );
  }
}

type SnapshotForGc = {
  version: string;
  manifest: BackupManifest;
};

function chooseSnapshotsToKeep(input: {
  snapshots: SnapshotForGc[];
  chunksPrefix: string;
  keepLast: number;
  latestVersion?: string;
  maxBytes?: number;
  chunkSizes: Map<string, number>;
}): Result<{ versions: Set<string>; bytes: number }> {
  const keep = new Set<string>();
  const mandatory = input.latestVersion ?? input.snapshots[0]?.version;
  if (mandatory !== undefined) keep.add(mandatory);

  for (const snapshot of input.snapshots) {
    if (keep.size >= input.keepLast) break;
    keep.add(snapshot.version);
  }

  let bytes = retainedChunkBytes(input.snapshots, keep, {
    chunksPrefix: input.chunksPrefix,
    chunkSizes: input.chunkSizes,
  });
  if (input.maxBytes === undefined) return ok({ versions: keep, bytes });

  if (bytes > input.maxBytes) {
    return err(
      new TinyAgentError(
        "BACKUP_GC_QUOTA_TOO_SMALL",
        "maxBytes cannot retain the required latest/keepLast snapshots",
        { retainedBytes: bytes, quotaBytes: input.maxBytes },
      ),
    );
  }

  for (const snapshot of input.snapshots) {
    if (keep.has(snapshot.version)) continue;
    keep.add(snapshot.version);
    const nextBytes = retainedChunkBytes(input.snapshots, keep, {
      chunksPrefix: input.chunksPrefix,
      chunkSizes: input.chunkSizes,
    });
    if (nextBytes > input.maxBytes) {
      keep.delete(snapshot.version);
    } else {
      bytes = nextBytes;
    }
  }

  return ok({ versions: keep, bytes });
}

function retainedChunkBytes(
  snapshots: SnapshotForGc[],
  versions: Set<string>,
  input: { chunksPrefix: string; chunkSizes: Map<string, number> },
): number {
  const chunks = new Set<string>();
  for (const snapshot of snapshots) {
    if (!versions.has(snapshot.version)) continue;
    for (const chunk of snapshot.manifest.chunks) {
      chunks.add(`${input.chunksPrefix}${chunk.hash}`);
    }
  }
  let bytes = 0;
  for (const key of chunks) {
    bytes += input.chunkSizes.get(key) ?? 0;
  }
  return bytes;
}

export async function restoreDirectory(
  input: RestoreInput,
): Promise<Result<BackupManifest>> {
  try {
    const version =
      input.version ?? (await readLatestPointer(input.store, input.agent));
    const manifestBytes = await input.store.get(
      tinyagentKvPath(input.agent, `snapshots/${version}`),
    );
    if (!manifestBytes.ok) return manifestBytes;
    const manifest = BackupManifestSchema.parse(
      JSON.parse(new TextDecoder().decode(manifestBytes.value)),
    );
    const contentKey = await openContentKey(
      manifest.sealedContentKey,
      input.backupPublicKey,
      input.backupPrivateKey,
    );
    const parts: Uint8Array[] = [];

    for (const chunk of manifest.chunks) {
      const encrypted = await input.store.get(
        tinyagentKvPath(input.agent, `chunks/${chunk.hash}`),
      );
      if (!encrypted.ok) return encrypted;
      const plaintext = await decryptChunk(
        { nonce: chunk.nonce, ciphertext: encrypted.value },
        contentKey,
      );
      if (hashHex(plaintext) !== chunk.hash) {
        return err(
          new TinyAgentError(
            "RESTORE_CHUNK_HASH_MISMATCH",
            `chunk failed integrity: ${chunk.hash}`,
          ),
        );
      }
      parts.push(plaintext);
    }

    const archive = concat(parts);
    if (hashHex(archive) !== manifest.integrity.digest) {
      return err(
        new TinyAgentError(
          "RESTORE_ARCHIVE_HASH_MISMATCH",
          "archive failed integrity",
        ),
      );
    }
    await rm(input.targetDir, { recursive: true, force: true });
    await mkdir(input.targetDir, { recursive: true });
    await restoreArchive(archive, input.targetDir);
    return ok(manifest);
  } catch (error) {
    return err(
      error instanceof Error
        ? error
        : new TinyAgentError("RESTORE_FAILED", String(error)),
    );
  }
}

async function readLatestPointer(store: Store, agent: string): Promise<string> {
  const latest = await store.get(tinyagentKvPath(agent, "latest"));
  if (!latest.ok) throw latest.error;
  return new TextDecoder().decode(latest.value);
}

function concat(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.byteLength, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.byteLength;
  }
  return out;
}
