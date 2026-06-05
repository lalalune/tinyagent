import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { MemoryStore } from "@tinyagent/backup";
import { deriveBackupKeypair } from "@tinyagent/crypto";
import {
  err,
  tinyagentKvPath,
  TinyAgentError,
  type Result,
  type StoreHead,
} from "@tinyagent/core";
import {
  BackupdController,
  isLoopbackAddress,
  startBackupdLoopbackServer,
} from "./index.js";

describe("BackupdController", () => {
  it("runs an immediate encrypted backup and updates status", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "tinyagent-backupd-"));
    await mkdir(join(stateDir, "memory"), { recursive: true });
    await writeFile(join(stateDir, "memory", "note.txt"), "remember this");

    const keypair = await deriveBackupKeypair(
      "space",
      new Uint8Array(65).fill(8),
    );
    const store = new MemoryStore();
    const controller = new BackupdController({
      store,
      agent: "ada",
      pack: "openclaw",
      stateDir,
      bpkId: keypair.publicKeyId,
      backupPublicKey: keypair.publicKey,
      chunkSize: 16,
    });

    const status = await controller.handle({ type: "backupNow" });
    expect(status.state).toBe("idle");
    expect(status.lastBackupAt).toBeDefined();

    const latest = await store.get(tinyagentKvPath("ada", "latest"));
    expect(latest.ok).toBe(true);
  });

  it("reports backup failures without hiding the error", async () => {
    const keypair = await deriveBackupKeypair(
      "space",
      new Uint8Array(65).fill(9),
    );
    const controller = new BackupdController({
      store: new MemoryStore(),
      agent: "ada",
      pack: "openclaw",
      stateDir: "/does/not/exist",
      bpkId: keypair.publicKeyId,
      backupPublicKey: keypair.publicKey,
      backup: async () =>
        err(new TinyAgentError("BACKUP_FAILED", "disk unavailable")),
    });

    const status = await controller.handle({ type: "backupNow" });
    expect(status).toMatchObject({
      agent: "ada",
      state: "error",
      error: "disk unavailable",
    });
  });

  it("tracks the next scheduled backup time while running", () => {
    let callback: (() => void) | undefined;
    const controller = new BackupdController({
      store: new MemoryStore(),
      agent: "ada",
      pack: "openclaw",
      stateDir: "/tmp",
      bpkId: "bpk_test",
      backupPublicKey: new Uint8Array(32),
      intervalMs: 60_000,
      now: () => new Date("2026-01-01T00:00:00.000Z"),
      setInterval: (next) => {
        callback = next;
        return 1 as unknown as ReturnType<typeof setInterval>;
      },
      clearInterval: () => {
        callback = undefined;
      },
    });

    const started = controller.start();
    expect(started.nextBackupAt).toBe("2026-01-01T00:01:00.000Z");
    expect(callback).toBeDefined();

    const stopped = controller.stop();
    expect(stopped.nextBackupAt).toBeUndefined();
    expect(callback).toBeUndefined();
  });

  it("runs a scheduled backup when the interval fires", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "tinyagent-backupd-"));
    await mkdir(join(stateDir, "memory"), { recursive: true });
    await writeFile(join(stateDir, "memory", "note.txt"), "scheduled backup");
    const keypair = await deriveBackupKeypair(
      "space",
      new Uint8Array(65).fill(11),
    );
    let callback: (() => void) | undefined;
    const store = new MemoryStore();
    const controller = new BackupdController({
      store,
      agent: "ada",
      pack: "openclaw",
      stateDir,
      bpkId: keypair.publicKeyId,
      backupPublicKey: keypair.publicKey,
      intervalMs: 60_000,
      setInterval: (next) => {
        callback = next;
        return 1 as unknown as ReturnType<typeof setInterval>;
      },
      clearInterval: () => {
        callback = undefined;
      },
    });

    controller.start();
    callback?.();

    await vi.waitFor(() =>
      expect(controller.status().lastBackupAt).toBeDefined(),
    );
    const latest = await store.get(tinyagentKvPath("ada", "latest"));
    expect(latest.ok).toBe(true);
    controller.stop();
  });

  it("renews delegation when a renewal callback is configured", async () => {
    let renewals = 0;
    const controller = new BackupdController({
      store: new MemoryStore(),
      agent: "ada",
      pack: "openclaw",
      stateDir: "/tmp",
      bpkId: "bpk_test",
      backupPublicKey: new Uint8Array(32),
      renewDelegation: async () => {
        renewals += 1;
        return { ok: true };
      },
    });

    const status = await controller.handle({ type: "renewDelegation" });
    expect(status).toMatchObject({ agent: "ada", state: "idle" });
    expect(status.error).toBeUndefined();
    expect(renewals).toBe(1);
  });

  it("reports delegation renewal failures", async () => {
    const controller = new BackupdController({
      store: new MemoryStore(),
      agent: "ada",
      pack: "openclaw",
      stateDir: "/tmp",
      bpkId: "bpk_test",
      backupPublicKey: new Uint8Array(32),
      renewDelegation: async () => ({
        ok: false,
        error: new Error("delegation expired"),
      }),
    });

    const status = await controller.handle({ type: "renewDelegation" });
    expect(status).toMatchObject({
      agent: "ada",
      state: "error",
      error: "delegation expired",
    });
  });

  it("renews an expired delegated store and retries the backup once", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "tinyagent-backupd-"));
    await mkdir(join(stateDir, "memory"), { recursive: true });
    await writeFile(join(stateDir, "memory", "note.txt"), "renewed backup");
    const keypair = await deriveBackupKeypair(
      "space",
      new Uint8Array(65).fill(12),
    );
    const renewedStore = new MemoryStore();
    let renewals = 0;
    const controller = new BackupdController({
      store: new ExpiredDelegatedStore(),
      agent: "ada",
      pack: "openclaw",
      stateDir,
      bpkId: keypair.publicKeyId,
      backupPublicKey: keypair.publicKey,
      renewDelegation: async () => {
        renewals += 1;
        return { ok: true, store: renewedStore };
      },
    });

    const status = await controller.handle({ type: "backupNow" });

    expect(status.state).toBe("idle");
    expect(status.error).toBeUndefined();
    expect(renewals).toBe(1);
    const latest = await renewedStore.get(tinyagentKvPath("ada", "latest"));
    expect(latest.ok).toBe(true);
  });

  it("serves the control API on loopback and dispatches validated commands", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "tinyagent-backupd-"));
    await mkdir(join(stateDir, "memory"), { recursive: true });
    await writeFile(join(stateDir, "memory", "note.txt"), "loopback backup");
    const keypair = await deriveBackupKeypair(
      "space",
      new Uint8Array(65).fill(10),
    );
    const store = new MemoryStore();
    const controller = new BackupdController({
      store,
      agent: "ada",
      pack: "openclaw",
      stateDir,
      bpkId: keypair.publicKeyId,
      backupPublicKey: keypair.publicKey,
    });
    const server = await startBackupdLoopbackServer(controller);

    try {
      const initial = await fetch(`${server.url}/status`);
      expect(initial.status).toBe(200);
      await expect(initial.json()).resolves.toMatchObject({
        ok: true,
        status: { agent: "ada", state: "idle" },
      });

      const backup = await fetch(`${server.url}/control`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ type: "backupNow" }),
      });
      expect(backup.status).toBe(200);
      const backupBody = (await backup.json()) as {
        status: { lastBackupAt?: string };
      };
      expect(backupBody).toMatchObject({
        ok: true,
        status: { agent: "ada", state: "idle" },
      });
      expect(backupBody.status.lastBackupAt).toBeDefined();

      const latest = await store.get(tinyagentKvPath("ada", "latest"));
      expect(latest.ok).toBe(true);

      const invalid = await fetch(`${server.url}/control`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ type: "notACommand" }),
      });
      expect(invalid.status).toBe(400);
      await expect(invalid.json()).resolves.toMatchObject({
        ok: false,
        error: "invalid backupd command",
      });

      const missing = await fetch(`${server.url}/missing`);
      expect(missing.status).toBe(404);
    } finally {
      await server.close();
    }
  });

  it("keeps the control API restricted to loopback client addresses", () => {
    expect(isLoopbackAddress("127.0.0.1")).toBe(true);
    expect(isLoopbackAddress("::1")).toBe(true);
    expect(isLoopbackAddress("::ffff:127.0.0.1")).toBe(true);
    expect(isLoopbackAddress("0.0.0.0")).toBe(false);
    expect(isLoopbackAddress("192.168.1.5")).toBe(false);
    expect(isLoopbackAddress(undefined)).toBe(false);
  });
});

class ExpiredDelegatedStore extends MemoryStore {
  override async head(_key: string): Promise<Result<StoreHead | null>> {
    return err(new TinyAgentError("DELEGATION_EXPIRED", "delegation expired"));
  }
}
