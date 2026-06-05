import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  backupDirectory,
  MemoryStore,
  restoreDirectory,
} from "@tinyagent/backup";
import type { AgentSpec } from "@tinyagent/core";
import { deriveBackupKeypair } from "@tinyagent/crypto";
import { findAgent, parseLowkeyRegistryText } from "@tinyagent/packrunner";
import { DstackSimulatorProvider } from "@tinyagent/provider-dstack";
import { main } from "./index.js";

const matrixPacks = ["openclaw", "codex-cli", "ironclaw"] as const;
const signatureHex = Buffer.from(new Uint8Array(65).fill(12)).toString("hex");

describe("TinyAgent local e2e matrix", () => {
  it.each(matrixPacks)(
    "preserves %s state across local deploy, backup, down, recover",
    async (pack) => {
      const projectDir = await mkdtemp(join(tmpdir(), "tinyagent-e2e-local-"));
      const storeDir = join(projectDir, "store");
      const stateDir = join(projectDir, "state");
      const registry = "test/fixtures/lowkey-registry.json";
      vi.spyOn(console, "log").mockImplementation(() => undefined);
      vi.spyOn(console, "error").mockImplementation(() => undefined);

      expect(
        await main([
          "--json",
          "init",
          "--project-dir",
          projectDir,
          "--agent",
          `ada-${pack}`,
          "--pack",
          pack,
          "--registry",
          registry,
          "--store-dir",
          storeDir,
          "--state-dir",
          stateDir,
        ]),
      ).toBe(0);
      expect(
        await main(["--json", "deploy", "--project-dir", projectDir]),
      ).toBe(0);

      await mkdir(join(stateDir, "memory"), { recursive: true });
      await writeFile(join(stateDir, "memory", "note.txt"), `${pack} state`);

      expect(
        await main([
          "--json",
          "backup",
          "--project-dir",
          projectDir,
          "--space",
          "space",
          "--signature-hex",
          signatureHex,
        ]),
      ).toBe(0);
      expect(await main(["--json", "down", "--project-dir", projectDir])).toBe(
        0,
      );
      await rm(join(stateDir, "memory", "note.txt"));

      expect(
        await main([
          "--json",
          "recover",
          "--project-dir",
          projectDir,
          "--space",
          "space",
          "--signature-hex",
          signatureHex,
        ]),
      ).toBe(0);

      await expect(
        readFile(join(stateDir, "memory", "note.txt"), "utf8"),
      ).resolves.toBe(`${pack} state`);
    },
  );
});

describe("TinyAgent dstack simulator e2e matrix", () => {
  it.each(matrixPacks)(
    "preserves %s state across simulator deploy, backup, down, recover",
    async (pack) => {
      const registry = parseLowkeyRegistryText(
        await readFile("test/fixtures/lowkey-registry.json", "utf8"),
        { format: "json" },
      );
      const agent = findAgent(registry, pack);
      if (agent === undefined) throw new Error(`missing test pack: ${pack}`);

      const provider = new DstackSimulatorProvider();
      const sandbox = await provider.provision(sandboxSpec(agent));
      await provider.start(sandbox);

      const remoteStatePath = "/state/memory/note.txt";
      await provider.putFiles(sandbox, [
        {
          path: remoteStatePath,
          content: new TextEncoder().encode(`${pack} simulator state`),
          mode: "0600",
        },
      ]);
      const pulled = await provider.getFiles(sandbox, [remoteStatePath]);
      expect(new TextDecoder().decode(pulled[0]!.content)).toBe(
        `${pack} simulator state`,
      );

      const sourceDir = await mkdtemp(
        join(tmpdir(), "tinyagent-e2e-dstack-src-"),
      );
      await mkdir(join(sourceDir, "memory"), { recursive: true });
      await writeFile(
        join(sourceDir, "memory", "note.txt"),
        Buffer.from(pulled[0]!.content),
      );

      const keypair = await deriveBackupKeypair(
        "space",
        new Uint8Array(Buffer.from(signatureHex, "hex")),
      );
      const store = new MemoryStore();
      const backup = await backupDirectory({
        store,
        agent: `ada-${pack}`,
        pack,
        stateDir: sourceDir,
        bpkId: keypair.publicKeyId,
        backupPublicKey: keypair.publicKey,
      });
      expect(backup.ok).toBe(true);

      await provider.stop(sandbox);
      await provider.destroy(sandbox);

      const recoveredDir = await mkdtemp(
        join(tmpdir(), "tinyagent-e2e-dstack-recovered-"),
      );
      const restored = await restoreDirectory({
        store,
        agent: `ada-${pack}`,
        targetDir: recoveredDir,
        backupPublicKey: keypair.publicKey,
        backupPrivateKey: keypair.privateKey,
      });
      expect(restored.ok).toBe(true);
      await expect(
        readFile(join(recoveredDir, "memory", "note.txt"), "utf8"),
      ).resolves.toBe(`${pack} simulator state`);

      const recoveredSandbox = await provider.provision(sandboxSpec(agent));
      try {
        await provider.start(recoveredSandbox);
        await provider.putFiles(recoveredSandbox, [
          {
            path: remoteStatePath,
            content: await readFile(join(recoveredDir, "memory", "note.txt")),
            mode: "0600",
          },
        ]);
        const verified = await provider.getFiles(recoveredSandbox, [
          remoteStatePath,
        ]);
        expect(new TextDecoder().decode(verified[0]!.content)).toBe(
          `${pack} simulator state`,
        );
      } finally {
        await provider.destroy(recoveredSandbox);
      }
    },
  );
});

function sandboxSpec(agent: AgentSpec) {
  return {
    name: `tinyagent-e2e-${agent.name}`,
    provider: "dstack-cvm" as const,
    image: "tinyagent-runner:test",
    environment: {},
    labels: {},
    mounts: [],
    agent,
  };
}
