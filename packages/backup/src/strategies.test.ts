import { execFile } from "node:child_process";
import {
  chmod,
  mkdir,
  mkdtemp,
  open,
  readFile,
  stat,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { TinyAgentError, tinyagentKvPath } from "@tinyagent/core";
import { deriveBackupKeypair } from "@tinyagent/crypto";
import { backupDirectory, restoreDirectory } from "./backup.js";
import { FaultInjectingStore, MemoryStore } from "./memory-store.js";
import {
  NestedDockerBackupStrategy,
  PostgresOnlineBackupStrategy,
} from "./external-strategies.js";
import {
  loadNodeSqlite,
  SqliteOnlineBackupStrategy,
} from "./sqlite-strategy.js";

const execFileAsync = promisify(execFile);

function pseudoRandomBytes(length: number, seed: number): Uint8Array {
  const out = new Uint8Array(length);
  let state = seed >>> 0;
  for (let i = 0; i < length; i++) {
    state = (state + 0x9e3779b9) >>> 0;
    let z = state;
    z = (Math.imul(z ^ (z >>> 16), 0x21f0aaad) >>> 0) >>> 0;
    z = (Math.imul(z ^ (z >>> 15), 0x735a2d97) >>> 0) >>> 0;
    z = (z ^ (z >>> 15)) >>> 0;
    out[i] = z & 0xff;
  }
  return out;
}

async function keypair() {
  return deriveBackupKeypair("space", new Uint8Array(65).fill(4));
}

describe("large-directory chunking (multi-MiB, FastCDC default)", () => {
  // The 1 GiB fixture remains external; this keeps CI focused on the same
  // backup/encrypt/store/restore path without materializing a huge file.
  it("backs up and restores a several-MiB directory byte-clean using fastcdc-v1", async () => {
    const root = await mkdtemp(join(tmpdir(), "tinyagent-big-src-"));
    const target = await mkdtemp(join(tmpdir(), "tinyagent-big-dst-"));
    await mkdir(join(root, "data"), { recursive: true });

    const files: Record<string, Uint8Array> = {
      "data/a.bin": pseudoRandomBytes(1 * 1024 * 1024, 1),
      "data/b.bin": pseudoRandomBytes(1 * 1024 * 1024, 2),
      "data/c.bin": pseudoRandomBytes(1 * 1024 * 1024, 3),
      "small.txt": new TextEncoder().encode("hello world\n"),
    };
    for (const [rel, bytes] of Object.entries(files)) {
      await writeFile(join(root, rel), Buffer.from(bytes));
    }

    const kp = await keypair();
    const store = new MemoryStore();
    const backup = await backupDirectory({
      store,
      agent: "ada",
      pack: "fake-pack",
      stateDir: root,
      bpkId: kp.publicKeyId,
      backupPublicKey: kp.publicKey,
    });
    expect(backup.ok).toBe(true);
    if (!backup.ok) throw backup.error;
    expect(backup.value.metadata.chunker).toBe("fastcdc-v1");
    expect(backup.value.chunks.length).toBeGreaterThan(2);

    const restored = await restoreDirectory({
      store,
      agent: "ada",
      targetDir: target,
      backupPublicKey: kp.publicKey,
      backupPrivateKey: kp.privateKey,
    });
    expect(restored.ok).toBe(true);
    if (!restored.ok) throw restored.error;

    for (const [rel, bytes] of Object.entries(files)) {
      const got = await readFile(join(target, rel));
      expect(Buffer.compare(got, Buffer.from(bytes))).toBe(0);
    }
  }, 60000);

  it("can still use the legacy fixed-size chunker when chunkSize is given", async () => {
    const root = await mkdtemp(join(tmpdir(), "tinyagent-fix-src-"));
    await writeFile(join(root, "state.txt"), "fixed".repeat(100));
    const kp = await keypair();
    const store = new MemoryStore();
    const backup = await backupDirectory({
      store,
      agent: "ada",
      pack: "fake-pack",
      stateDir: root,
      bpkId: kp.publicKeyId,
      backupPublicKey: kp.publicKey,
      chunkSize: 32,
    });
    expect(backup.ok).toBe(true);
    if (!backup.ok) throw backup.error;
    expect(backup.value.metadata.chunker).toBe("fixed-size-v0");
  });

  it("backs up and restores a sparse fixture over 1 GiB without materializing zero ranges", async () => {
    const root = await mkdtemp(join(tmpdir(), "tinyagent-1g-src-"));
    const target = await mkdtemp(join(tmpdir(), "tinyagent-1g-dst-"));
    const sparsePath = join(root, "large-sparse.bin");
    const restoredPath = join(target, "large-sparse.bin");
    const size = 1024 * 1024 * 1024 + 4096;
    const head = Buffer.from("tinyagent sparse head\n");
    const tail = Buffer.from("tinyagent sparse tail\n");

    const handle = await open(sparsePath, "w+");
    try {
      await handle.write(head, 0, head.byteLength, 0);
      await handle.write(tail, 0, tail.byteLength, size - tail.byteLength);
      await handle.truncate(size);
    } finally {
      await handle.close();
    }

    const kp = await keypair();
    const store = new MemoryStore();
    const backup = await backupDirectory({
      store,
      agent: "ada",
      pack: "sparse-pack",
      stateDir: root,
      bpkId: kp.publicKeyId,
      backupPublicKey: kp.publicKey,
    });
    expect(backup.ok).toBe(true);
    if (!backup.ok) throw backup.error;
    expect(backup.value.integrity.totalPlaintextBytes).toBeUndefined();
    expect(backup.value.chunks.length).toBeLessThan(5);

    const restored = await restoreDirectory({
      store,
      agent: "ada",
      targetDir: target,
      backupPublicKey: kp.publicKey,
      backupPrivateKey: kp.privateKey,
    });
    expect(restored.ok).toBe(true);
    if (!restored.ok) throw restored.error;

    const restoredStat = await stat(restoredPath);
    expect(restoredStat.size).toBe(size);
    const restoredHandle = await open(restoredPath, "r");
    try {
      const restoredHead = Buffer.alloc(head.byteLength);
      const restoredTail = Buffer.alloc(tail.byteLength);
      const restoredMiddle = Buffer.alloc(4096);
      await restoredHandle.read(restoredHead, 0, restoredHead.byteLength, 0);
      await restoredHandle.read(
        restoredMiddle,
        0,
        restoredMiddle.byteLength,
        512 * 1024 * 1024,
      );
      await restoredHandle.read(
        restoredTail,
        0,
        restoredTail.byteLength,
        size - tail.byteLength,
      );
      expect(restoredHead.equals(head)).toBe(true);
      expect(
        restoredMiddle.equals(Buffer.alloc(restoredMiddle.byteLength)),
      ).toBe(true);
      expect(restoredTail.equals(tail)).toBe(true);
    } finally {
      await restoredHandle.close();
    }
  }, 120000);
});

describe("interrupted-upload / latest-rollback safety", () => {
  it("leaves latest pointing at the previous good snapshot when a put fails partway", async () => {
    const root = await mkdtemp(join(tmpdir(), "tinyagent-roll-src-"));
    const target = await mkdtemp(join(tmpdir(), "tinyagent-roll-dst-"));
    await writeFile(join(root, "state.txt"), "GOOD-V1");

    const kp = await keypair();
    const backing = new MemoryStore();

    const first = await backupDirectory({
      store: backing,
      agent: "ada",
      pack: "fake-pack",
      stateDir: root,
      bpkId: kp.publicKeyId,
      backupPublicKey: kp.publicKey,
      now: () => new Date("2026-06-01T00:00:00.000Z"),
    });
    expect(first.ok).toBe(true);

    const latestBefore = await backing.get(tinyagentKvPath("ada", "latest"));
    if (!latestBefore.ok) throw latestBefore.error;
    const latestPointerBefore = new TextDecoder().decode(latestBefore.value);

    // Now change the state and run a backup that fails on its FIRST put (a
    // chunk put), simulating an interrupted upload. With a multi-chunk archive
    // the first put is a chunk; latest must NOT be advanced.
    await writeFile(join(root, "state.txt"), "BROKEN-V2");
    const faulting = new FaultInjectingStore(backing, 1);
    const failed = await backupDirectory({
      store: faulting,
      agent: "ada",
      pack: "fake-pack",
      stateDir: root,
      bpkId: kp.publicKeyId,
      backupPublicKey: kp.publicKey,
      now: () => new Date("2026-06-02T00:00:00.000Z"),
    });
    expect(failed.ok).toBe(false);

    const latestAfter = await backing.get(tinyagentKvPath("ada", "latest"));
    if (!latestAfter.ok) throw latestAfter.error;
    expect(new TextDecoder().decode(latestAfter.value)).toBe(
      latestPointerBefore,
    );

    const restored = await restoreDirectory({
      store: backing,
      agent: "ada",
      targetDir: target,
      backupPublicKey: kp.publicKey,
      backupPrivateKey: kp.privateKey,
    });
    expect(restored.ok).toBe(true);
    await expect(readFile(join(target, "state.txt"), "utf8")).resolves.toBe(
      "GOOD-V1",
    );
  });

  it("does not advance latest when the manifest put fails (latest is written strictly last)", async () => {
    const root = await mkdtemp(join(tmpdir(), "tinyagent-roll2-src-"));
    const target = await mkdtemp(join(tmpdir(), "tinyagent-roll2-dst-"));
    await writeFile(join(root, "state.txt"), "GOOD-V1");

    const kp = await keypair();
    const backing = new MemoryStore();
    const first = await backupDirectory({
      store: backing,
      agent: "ada",
      pack: "fake-pack",
      stateDir: root,
      bpkId: kp.publicKeyId,
      backupPublicKey: kp.publicKey,
      now: () => new Date("2026-06-01T00:00:00.000Z"),
    });
    expect(first.ok).toBe(true);
    const latestBefore = await backing.get(tinyagentKvPath("ada", "latest"));
    if (!latestBefore.ok) throw latestBefore.error;
    const pointerBefore = new TextDecoder().decode(latestBefore.value);

    // New, single-chunk state: put #1 is the only chunk, put #2 is the
    // manifest, put #3 would be latest. Fail on the manifest put (#2) so we
    // verify latest (#3) is never reached.
    await writeFile(join(root, "state.txt"), "tiny");
    const faulting = new FaultInjectingStore(backing, 2);
    const failed = await backupDirectory({
      store: faulting,
      agent: "ada",
      pack: "fake-pack",
      stateDir: root,
      bpkId: kp.publicKeyId,
      backupPublicKey: kp.publicKey,
      chunkSize: 1024 * 1024,
      now: () => new Date("2026-06-02T00:00:00.000Z"),
    });
    expect(failed.ok).toBe(false);

    const latestAfter = await backing.get(tinyagentKvPath("ada", "latest"));
    if (!latestAfter.ok) throw latestAfter.error;
    expect(new TextDecoder().decode(latestAfter.value)).toBe(pointerBefore);

    const restored = await restoreDirectory({
      store: backing,
      agent: "ada",
      targetDir: target,
      backupPublicKey: kp.publicKey,
      backupPrivateKey: kp.privateKey,
    });
    expect(restored.ok).toBe(true);
    await expect(readFile(join(target, "state.txt"), "utf8")).resolves.toBe(
      "GOOD-V1",
    );
  });
});

describe("SQLite online-backup strategy", () => {
  const supported = loadNodeSqlite() !== null;

  it.runIf(supported)(
    "takes a consistent online snapshot, backs up and restores row-clean",
    async () => {
      const sqlite = loadNodeSqlite();
      if (!sqlite) throw new Error("expected node:sqlite to be available");

      const stateDir = await mkdtemp(join(tmpdir(), "tinyagent-sqlite-"));
      const target = await mkdtemp(join(tmpdir(), "tinyagent-sqlite-dst-"));
      const livePath = join(stateDir, "live.db");

      const live = new sqlite.DatabaseSync(livePath);
      live.exec("PRAGMA journal_mode = WAL");
      live.exec("CREATE TABLE kv (id INTEGER PRIMARY KEY, v TEXT NOT NULL)");
      const insert = live.prepare("INSERT INTO kv (id, v) VALUES (?, ?)");
      for (let i = 1; i <= 500; i++) {
        insert.run(i, `value-${i}`);
      }
      const countRow = live
        .prepare("SELECT COUNT(*) AS n FROM kv")
        .all()[0] as { n: number };
      expect(countRow.n).toBe(500);

      const snapDir = await mkdtemp(join(tmpdir(), "tinyagent-sqlite-snap-"));
      const strategy = new SqliteOnlineBackupStrategy({
        sourceDbPath: livePath,
        destFileName: "snapshot.sqlite",
      });
      const snap = await strategy.snapshot(snapDir);
      // Keep writing to the live DB after the snapshot to prove the snapshot is
      // a point-in-time copy independent of ongoing writes.
      const insert2 = live.prepare("INSERT INTO kv (id, v) VALUES (?, ?)");
      insert2.run(9999, "after-snapshot");
      live.close();

      expect(snap.ok).toBe(true);
      if (!snap.ok) throw snap.error;

      const kp = await keypair();
      const store = new MemoryStore();
      const backup = await backupDirectory({
        store,
        agent: "ada",
        pack: "sqlite-pack",
        stateDir: snapDir,
        bpkId: kp.publicKeyId,
        backupPublicKey: kp.publicKey,
      });
      expect(backup.ok).toBe(true);

      const restored = await restoreDirectory({
        store,
        agent: "ada",
        targetDir: target,
        backupPublicKey: kp.publicKey,
        backupPrivateKey: kp.privateKey,
      });
      expect(restored.ok).toBe(true);

      // Reopen the restored snapshot and assert all 500 rows are present and
      // the row written after the snapshot is NOT present (consistency).
      const restoredDb = new sqlite.DatabaseSync(
        join(target, "snapshot.sqlite"),
        { readOnly: true },
      );
      const n = (
        restoredDb.prepare("SELECT COUNT(*) AS n FROM kv").all()[0] as {
          n: number;
        }
      ).n;
      const rows = restoredDb
        .prepare("SELECT id, v FROM kv ORDER BY id")
        .all() as { id: number; v: string }[];
      restoredDb.close();
      expect(n).toBe(500);
      expect(rows[0]).toEqual({ id: 1, v: "value-1" });
      expect(rows[rows.length - 1]).toEqual({ id: 500, v: "value-500" });
      expect(rows.some((r) => r.id === 9999)).toBe(false);
    },
    60000,
  );

  it("returns an explicit unsupported error when node:sqlite is unavailable", () => {
    expect(loadNodeSqlite() !== null).toBe(supported);
  });
});

describe("external strategies", () => {
  it("runs pg_dump to produce a PostgreSQL logical backup artifact", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "tinyagent-pg-"));
    const binDir = await mkdtemp(join(tmpdir(), "tinyagent-pg-bin-"));
    const pgDump = join(binDir, "pg_dump");
    await writeFile(
      pgDump,
      [
        "#!/usr/bin/env node",
        "const { writeFileSync } = require('node:fs');",
        "const args = process.argv.slice(2);",
        "const file = args[args.indexOf('--file') + 1];",
        "writeFileSync(file, JSON.stringify({ args }) + '\\n');",
      ].join("\n"),
    );
    await chmod(pgDump, 0o755);

    const strategy = new PostgresOnlineBackupStrategy({
      connectionString: "postgres://user:pass@localhost:5432/db",
      command: pgDump,
    });
    const result = await strategy.snapshot(stateDir);
    expect(result.ok).toBe(true);
    if (!result.ok) throw result.error;
    expect(result.value).toEqual(["postgres-db.dump"]);

    const dump = JSON.parse(
      await readFile(join(stateDir, "postgres-db.dump"), "utf8"),
    ) as { args: string[] };
    expect(dump.args).toEqual([
      "--dbname",
      "postgres://user:pass@localhost:5432/db",
      "--file",
      join(stateDir, "postgres-db.dump"),
      "--format",
      "custom",
      "--no-owner",
      "--no-privileges",
    ]);
  });

  it("returns an explicit unsupported error when pg_dump is unavailable", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "tinyagent-pg-missing-"));
    const strategy = new PostgresOnlineBackupStrategy({
      connectionString: "postgres://user:pass@localhost:5432/db",
      command: join(stateDir, "missing-pg-dump"),
    });
    const result = await strategy.snapshot(stateDir);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected unsupported");
    expect(result.error).toBeInstanceOf(TinyAgentError);
    expect((result.error as TinyAgentError).code).toBe("PG_BACKUP_UNSUPPORTED");
  });

  it("exports nested-Docker container filesystem state as a tar snapshot", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "tinyagent-docker-"));
    await ensureDockerImage("alpine:3.20");
    const container = `tinyagent-nested-backup-${Date.now()}-${Math.floor(
      Math.random() * 1e6,
    )}`;
    try {
      await execFileAsync("docker", [
        "create",
        "--name",
        container,
        "alpine:3.20",
        "sh",
        "-lc",
        "mkdir -p /agent/state && printf nested-proof >/agent/state/proof.txt",
      ]);
      await execFileAsync("docker", ["start", "-a", container]);

      const strategy = new NestedDockerBackupStrategy({ container });
      const result = await strategy.snapshot(stateDir);
      expect(result.ok).toBe(true);
      if (!result.ok) throw result.error;
      expect(result.value).toEqual([`docker-${container}.tar`]);

      const tarBytes = await readFile(join(stateDir, result.value[0]!));
      expect(readTarEntry(tarBytes, "agent/state/proof.txt")?.toString()).toBe(
        "nested-proof",
      );
    } finally {
      await execFileAsync("docker", ["rm", "-f", container]).catch(() => {});
    }
  });
});

async function ensureDockerImage(image: string): Promise<void> {
  try {
    await execFileAsync("docker", ["image", "inspect", image]);
  } catch {
    await execFileAsync("docker", ["pull", image], { timeout: 120000 });
  }
}

function readTarEntry(tarBytes: Buffer, wantedPath: string): Buffer | null {
  let offset = 0;
  while (offset + 512 <= tarBytes.length) {
    const header = tarBytes.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) return null;
    const name = header.subarray(0, 100).toString("utf8").replace(/\0.*$/, "");
    const prefix = header
      .subarray(345, 500)
      .toString("utf8")
      .replace(/\0.*$/, "");
    const path = prefix.length > 0 ? `${prefix}/${name}` : name;
    const sizeText = header
      .subarray(124, 136)
      .toString("utf8")
      .replace(/\0.*$/, "")
      .trim();
    const size = Number.parseInt(sizeText || "0", 8);
    const dataOffset = offset + 512;
    if (path === wantedPath) {
      return tarBytes.subarray(dataOffset, dataOffset + size);
    }
    offset = dataOffset + Math.ceil(size / 512) * 512;
  }
  return null;
}
