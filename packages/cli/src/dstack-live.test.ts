import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { main } from "./index.js";

const live = process.env.TINYAGENT_DSTACK_LIVE === "1";
const describeLive = live ? describe : describe.skip;

describeLive("TinyAgent live dstack production workflow", () => {
  it(
    "deploys, attests, backs up, destroys, and recovers on Phala Cloud",
    async () => {
      const phalaCliArgs = readLivePhalaCliArgs();
      const verifyUrl = requireLiveEnv("TINYAGENT_PHALA_VERIFY_URL");
      const runnerImage =
        process.env.TINYAGENT_DSTACK_RUNNER_IMAGE ?? "tinyagent-runner:test";
      const pack = process.env.TINYAGENT_DSTACK_PACK ?? "codex-cli";
      const signatureHex = requireLiveEnv("TINYAGENT_DSTACK_SIGNATURE_HEX");
      const packEnv = readLivePackEnv();
      const tunnelPort = process.env.TINYAGENT_DSTACK_TUNNEL_PORT;

      expect(
        await main([
          "--json",
          "preflight",
          "dstack",
          ...phalaCliArgs,
          "--phala-verify-url",
          verifyUrl,
        ]),
      ).toBe(0);

      const projectDir = await mkdtemp(
        join(tmpdir(), "tinyagent-live-dstack-"),
      );
      const storeDir = join(projectDir, "store");
      const stateDir = join(projectDir, "state");
      const logSpy = vi
        .spyOn(console, "log")
        .mockImplementation(() => undefined);
      const errorSpy = vi
        .spyOn(console, "error")
        .mockImplementation(() => undefined);

      await mkdir(join(stateDir, "memory"), { recursive: true });
      await writeFile(
        join(stateDir, "memory", "note.txt"),
        "live dstack state",
      );

      try {
        expect(
          await main([
            "--json",
            "init",
            "--project-dir",
            projectDir,
            "--provider",
            "dstack-cvm",
            "--agent",
            "ada-live",
            "--pack",
            pack,
            "--registry",
            "test/fixtures/lowkey-registry.json",
            "--store-dir",
            storeDir,
            "--state-dir",
            stateDir,
            "--runner-image",
            runnerImage,
          ]),
        ).toBe(0);

        expect(
          await main([
            "--json",
            "deploy",
            "--project-dir",
            projectDir,
            ...phalaCliArgs,
            "--phala-verify-url",
            verifyUrl,
            ...packEnv.flatMap((entry) => ["--env", entry]),
          ]),
        ).toBe(0);
        const deployment = JSON.parse(
          await readFile(
            join(projectDir, ".tinyagent", "deployment.json"),
            "utf8",
          ),
        ) as {
          attestation?: {
            ok?: boolean;
            checks?: { composeHash?: boolean; productionDcap?: boolean };
            doc?: { composeHash?: string };
          };
        };
        const expectedComposeHash = await readExpectedComposeHash();
        expect(deployment.attestation?.ok).toBe(true);
        expect(deployment.attestation?.checks?.productionDcap).toBe(true);
        expect(deployment.attestation?.checks?.composeHash).toBe(true);
        expect(deployment.attestation?.doc?.composeHash).toBe(
          expectedComposeHash,
        );
        await writeLiveEvidenceBundle({
          projectDir,
          pack,
          runnerImage,
          expectedComposeHash,
          deployment,
        });

        expect(
          await main(["--json", "status", "--project-dir", projectDir]),
        ).toBe(0);
        if (tunnelPort !== undefined) {
          expect(
            await main([
              "--json",
              "tunnel",
              "--project-dir",
              projectDir,
              "--port",
              tunnelPort,
            ]),
          ).toBe(0);
        }
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

        await rm(join(stateDir, "memory", "note.txt"), { force: true });
        expect(
          await main([
            "--json",
            "down",
            "--project-dir",
            projectDir,
            ...phalaCliArgs,
          ]),
        ).toBe(0);
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
        ).resolves.toBe("live dstack state");
      } finally {
        await main([
          "--json",
          "down",
          "--project-dir",
          projectDir,
          ...phalaCliArgs,
        ]).catch(() => 1);
        logSpy.mockRestore();
        errorSpy.mockRestore();
      }
    },
    15 * 60_000,
  );
});

function requireLiveEnv(name: string): string {
  const value = process.env[name];
  expect(value, `${name} must be set for live dstack validation`).toBeTruthy();
  return value!;
}

function readLivePhalaCliArgs(): string[] {
  const command = process.env.TINYAGENT_PHALA_COMMAND;
  if (command !== undefined && command.trim().length > 0) {
    return ["--phala-command", command];
  }
  return ["--phala-bin", process.env.TINYAGENT_PHALA_BIN ?? "phala"];
}

function readLivePackEnv(): string[] {
  const raw = process.env.TINYAGENT_DSTACK_ENV;
  if (raw === undefined || raw.trim().length === 0) return [];
  return raw
    .split(/[\n,]/)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

async function readExpectedComposeHash(): Promise<string> {
  return (await readFile(join("runner", "app-compose.sha256"), "utf8")).trim();
}

async function writeLiveEvidenceBundle(input: {
  projectDir: string;
  pack: string;
  runnerImage: string;
  expectedComposeHash: string;
  deployment: {
    attestation?: {
      ok?: boolean;
      checks?: { composeHash?: boolean; productionDcap?: boolean };
      doc?: { composeHash?: string };
    };
  };
}): Promise<void> {
  const evidenceDir = process.env.TINYAGENT_DSTACK_EVIDENCE_DIR;
  if (evidenceDir === undefined || evidenceDir.trim().length === 0) return;

  await mkdir(evidenceDir, { recursive: true });
  const evidence = {
    generatedAt: new Date().toISOString(),
    projectDir: input.projectDir,
    pack: input.pack,
    runnerImage: input.runnerImage,
    expectedComposeHash: input.expectedComposeHash,
    attestation: input.deployment.attestation,
  };
  await writeFile(
    join(evidenceDir, "tinyagent-dstack-live-evidence.json"),
    `${JSON.stringify(evidence, null, 2)}\n`,
    { mode: 0o600 },
  );
}

describe("live dstack evidence helpers", () => {
  it("writes an optional evidence bundle without requiring live credentials", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tinyagent-dstack-evidence-"));
    const previous = process.env.TINYAGENT_DSTACK_EVIDENCE_DIR;
    process.env.TINYAGENT_DSTACK_EVIDENCE_DIR = dir;
    try {
      await writeLiveEvidenceBundle({
        projectDir: "/tmp/project",
        pack: "codex-cli",
        runnerImage: "tinyagent-runner:test",
        expectedComposeHash: "sha256:compose",
        deployment: {
          attestation: {
            ok: true,
            checks: { composeHash: true, productionDcap: true },
            doc: { composeHash: "sha256:compose" },
          },
        },
      });

      await expect(
        readFile(join(dir, "tinyagent-dstack-live-evidence.json"), "utf8"),
      ).resolves.toContain('"expectedComposeHash": "sha256:compose"');
    } finally {
      if (previous === undefined)
        delete process.env.TINYAGENT_DSTACK_EVIDENCE_DIR;
      else process.env.TINYAGENT_DSTACK_EVIDENCE_DIR = previous;
      await rm(dir, { recursive: true, force: true });
    }
  });
});
