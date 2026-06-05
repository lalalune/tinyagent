import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  BackupdController,
  startBackupdLoopbackServer,
} from "@tinyagent/backupd";
import { MemoryStore } from "@tinyagent/backup";
import { main, VERSION } from "./index.js";

describe("tinyagent cli", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("prints version", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    expect(await main(["--version"])).toBe(0);
    expect(log).toHaveBeenCalledWith(VERSION);
  });

  it("rejects unknown commands", async () => {
    const error = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    expect(await main(["unknown"])).toBe(1);
    expect(error).toHaveBeenCalledWith("Unknown command: unknown");
  });

  it("lists agents from a registry", async () => {
    const registry = await writeRegistry();
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    expect(await main(["agents", "list", "--registry", registry])).toBe(0);
    expect(log).toHaveBeenCalledWith(expect.stringContaining("openclaw"));
  });

  it("prints JSON info for a single agent", async () => {
    const registry = await writeRegistry();
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    expect(
      await main([
        "--json",
        "agents",
        "info",
        "openclaw",
        "--registry",
        registry,
      ]),
    ).toBe(0);
    const parsed = JSON.parse(String(log.mock.calls[0]?.[0]));
    expect(parsed.name).toBe("openclaw");
    expect(parsed.ports).toEqual([
      { name: "gateway", port: 3001, protocol: "tcp" },
    ]);
  });

  it("reports matrix metadata for fixture agents", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    for (const pack of ["codex-cli", "kiro-cli", "ironclaw", "nemoclaw"]) {
      expect(
        await main([
          "--json",
          "agents",
          "info",
          pack,
          "--registry",
          "test/fixtures/lowkey-registry.json",
        ]),
      ).toBe(0);
    }

    const [codex, kiro, ironclaw, nemoclaw] = log.mock.calls.map((call) =>
      JSON.parse(String(call[0])),
    );
    expect(codex.headlessCaveats).toContain("requires OpenAI API key");
    expect(kiro.headlessCaveats).toContain("interactive CLI only");
    expect(kiro.secretTargets).toEqual([
      { name: "KIRO_API_KEY", env: "KIRO_API_KEY", mode: "0600" },
    ]);
    expect(String(log.mock.calls[1]?.[0])).toContain("secretTargets");
    expect(String(log.mock.calls[1]?.[0])).toContain("KIRO_API_KEY");
    expect(ironclaw.stateDirs).toEqual(["postgres://ironclaw"]);
    expect(ironclaw.headlessCaveats).toEqual(
      expect.arrayContaining([
        "experimental",
        "requires PostgreSQL",
        "requires systemd",
        "routes Bedrock through bedrockify OpenAI-compatible backend",
      ]),
    );
    expect(nemoclaw.stateDirs).toEqual(["~/.nemoclaw", "docker:nemoclaw"]);
    expect(nemoclaw.headlessCaveats).toEqual(
      expect.arrayContaining(["experimental", "requires nested Docker"]),
    );
  });

  it("redacts structured error details in JSON mode", async () => {
    const registryPath = join(
      await mkdtemp(join(tmpdir(), "tinyagent-cli-registry-")),
      "registry.json",
    );
    await writeFile(
      registryPath,
      JSON.stringify({
        packs: [],
        apiKey: "sk-live",
        nested: { privateKey: "wallet-secret" },
      }),
    );
    const error = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);

    expect(
      await main(["--json", "agents", "list", "--registry", registryPath]),
    ).toBe(1);

    const output = String(error.mock.calls[0]?.[0]);
    expect(output).not.toContain("sk-live");
    expect(output).not.toContain("wallet-secret");
    expect(JSON.parse(output)).toMatchObject({
      ok: false,
      code: "LOWKEY_REGISTRY_INVALID",
      details: {
        registry: {
          apiKey: "[REDACTED]",
          nested: { privateKey: "[REDACTED]" },
        },
      },
    });
  });

  it("initializes a local project and reports status", async () => {
    const projectDir = await mkdtemp(join(tmpdir(), "tinyagent-cli-project-"));
    const storeDir = join(projectDir, "store");
    const stateDir = join(projectDir, "state");
    const registry = await writeRegistry();
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    expect(
      await main([
        "--json",
        "init",
        "--project-dir",
        projectDir,
        "--agent",
        "ada",
        "--pack",
        "openclaw",
        "--registry",
        registry,
        "--store-dir",
        storeDir,
        "--state-dir",
        stateDir,
        "--runner-image",
        "tinyagent-runner:test-fixture",
      ]),
    ).toBe(0);
    await vi.waitFor(() => expect(log).toHaveBeenCalledTimes(1));

    expect(await main(["--json", "status", "--project-dir", projectDir])).toBe(
      0,
    );
    await vi.waitFor(() => expect(log).toHaveBeenCalledTimes(2));

    const config = JSON.parse(
      await readFile(join(projectDir, ".tinyagent", "project.json"), "utf8"),
    );
    const initResult = JSON.parse(String(log.mock.calls[0]?.[0]));
    const statusResult = JSON.parse(String(log.mock.calls[1]?.[0]));
    expect(config).toMatchObject({
      version: 1,
      agent: "ada",
      pack: "openclaw",
      provider: "local-docker",
      storeDir,
      stateDir,
      registryPath: registry,
    });
    expect(initResult.project.agent).toBe("ada");
    expect(statusResult).toMatchObject({
      ok: true,
      project: { agent: "ada", pack: "openclaw" },
      sandbox: { provider: "local-docker", status: "not-deployed" },
      backup: { latest: null },
      secrets: [],
    });
  });

  it("rejects init with an unknown registry pack", async () => {
    const projectDir = await mkdtemp(join(tmpdir(), "tinyagent-cli-project-"));
    const registry = await writeRegistry();
    const error = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);

    expect(
      await main([
        "--json",
        "init",
        "--project-dir",
        projectDir,
        "--agent",
        "ada",
        "--pack",
        "missing",
        "--registry",
        registry,
      ]),
    ).toBe(1);
    await vi.waitFor(() => expect(error).toHaveBeenCalled());
    expect(String(error.mock.calls[0]?.[0])).toContain("unknown agent pack");
  });

  it("runs local shell commands in the project state dir and records logs", async () => {
    const projectDir = await mkdtemp(join(tmpdir(), "tinyagent-cli-project-"));
    const storeDir = join(projectDir, "store");
    const stateDir = join(projectDir, "state");
    const registry = await writeRegistry();
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    expect(
      await main([
        "--json",
        "init",
        "--project-dir",
        projectDir,
        "--agent",
        "ada",
        "--pack",
        "openclaw",
        "--registry",
        registry,
        "--store-dir",
        storeDir,
        "--state-dir",
        stateDir,
      ]),
    ).toBe(0);
    expect(
      await main([
        "--json",
        "shell",
        "--project-dir",
        projectDir,
        "--",
        process.execPath,
        "-e",
        "require('node:fs').writeFileSync('shell.txt', 'ran'); console.log(process.cwd())",
      ]),
    ).toBe(0);
    expect(await main(["--json", "logs", "--project-dir", projectDir])).toBe(0);

    await expect(readFile(join(stateDir, "shell.txt"), "utf8")).resolves.toBe(
      "ran",
    );
    const shellResult = JSON.parse(String(log.mock.calls[1]?.[0]));
    const logsResult = JSON.parse(String(log.mock.calls[2]?.[0]));
    expect(shellResult).toMatchObject({
      ok: true,
      cwd: stateDir,
      exitCode: 0,
    });
    expect(shellResult.stdout).toContain(stateDir);
    expect(logsResult.lines.join("\n")).toContain("shell");
    expect(logsResult.lines.join("\n")).toContain("exit=0");
  });

  it("redacts incidental secrets from shell output and stored logs", async () => {
    const projectDir = await mkdtemp(join(tmpdir(), "tinyagent-cli-project-"));
    const storeDir = join(projectDir, "store");
    const stateDir = join(projectDir, "state");
    const registry = await writeRegistry();
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    expect(
      await main([
        "--json",
        "init",
        "--project-dir",
        projectDir,
        "--agent",
        "ada",
        "--pack",
        "openclaw",
        "--registry",
        registry,
        "--store-dir",
        storeDir,
        "--state-dir",
        stateDir,
      ]),
    ).toBe(0);
    expect(
      await main([
        "--json",
        "shell",
        "--project-dir",
        projectDir,
        "--",
        process.execPath,
        "-e",
        "console.log('OPENAI_API_KEY=sk-test-secret'); console.error('Authorization: Bearer abc123')",
      ]),
    ).toBe(0);
    expect(await main(["--json", "logs", "--project-dir", projectDir])).toBe(0);

    const shellResultText = String(log.mock.calls[1]?.[0]);
    const logsResultText = String(log.mock.calls[2]?.[0]);
    expect(shellResultText).not.toContain("sk-test-secret");
    expect(shellResultText).not.toContain("abc123");
    expect(logsResultText).not.toContain("sk-test-secret");
    expect(logsResultText).not.toContain("abc123");
    expect(logsResultText).toContain("[REDACTED]");
  });

  it("runs the local deploy backup down recover lifecycle", async () => {
    const projectDir = await mkdtemp(join(tmpdir(), "tinyagent-cli-project-"));
    const storeDir = join(projectDir, "store");
    const stateDir = join(projectDir, "state");
    const registry = await writeRegistry();
    const signatureHex = Buffer.from(new Uint8Array(65).fill(7)).toString(
      "hex",
    );
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const error = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);

    expect(
      await main([
        "--json",
        "init",
        "--project-dir",
        projectDir,
        "--agent",
        "ada",
        "--pack",
        "openclaw",
        "--registry",
        registry,
        "--runner-image",
        "tinyagent-runner:test-fixture",
        "--store-dir",
        storeDir,
        "--state-dir",
        stateDir,
      ]),
    ).toBe(0);
    expect(await main(["--json", "deploy", "--project-dir", projectDir])).toBe(
      0,
    );
    expect(await main(["--json", "status", "--project-dir", projectDir])).toBe(
      0,
    );
    expect(await main(["--json", "tunnel", "--project-dir", projectDir])).toBe(
      0,
    );
    expect(await main(["--json", "stop", "--project-dir", projectDir])).toBe(0);
    expect(await main(["--json", "tunnel", "--project-dir", projectDir])).toBe(
      1,
    );
    expect(await main(["--json", "start", "--project-dir", projectDir])).toBe(
      0,
    );

    await mkdir(join(stateDir, "memory"), { recursive: true });
    await writeFile(join(stateDir, "memory", "note.txt"), "deployed state");
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
    expect(await main(["--json", "down", "--project-dir", projectDir])).toBe(0);
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
    expect(await main(["--json", "rm", "--project-dir", projectDir])).toBe(0);

    await expect(
      readFile(join(stateDir, "memory", "note.txt"), "utf8"),
    ).resolves.toBe("deployed state");
    const outputs = log.mock.calls.map((call) => JSON.parse(String(call[0])));
    const deployResult = outputs.find(
      (output) => output.sandbox?.status === "running",
    );
    const statusResult = outputs.find(
      (output) => output.sandbox?.deployedAt !== undefined,
    );
    const tunnelResult = outputs.find((output) => output.tunnel !== undefined);
    const stopResult = outputs.find(
      (output) => output.sandbox?.status === "stopped",
    );
    const downResult = outputs.find(
      (output) => output.sandbox?.status === "destroyed",
    );
    const rmResult = outputs.find((output) => output.removed === true);
    expect(deployResult.sandbox.status).toBe("running");
    expect(deployResult.sandbox.runnerSpec).toMatchObject({
      name: "tinyagent-ada",
      provider: "local-docker",
      image: "tinyagent-runner:test-fixture",
      environment: {
        TINYAGENT_AGENT: "ada",
        TINYAGENT_PACK: "openclaw",
        TINYAGENT_STATE_DIR: "/state",
        GATEWAY_PORT: "3001",
      },
      mounts: [{ source: stateDir, target: "/state", readonly: false }],
      labels: {
        "tinyagent.agent": "ada",
        "tinyagent.pack": "openclaw",
        "tinyagent.provider": "local-docker",
      },
    });
    expect(deployResult.sandbox.runnerSpec.expectedComposeHash).toMatch(
      /^sha256:/,
    );
    expect(statusResult.sandbox.status).toBe("running");
    expect(statusResult.sandbox.runnerSpec).toEqual(
      deployResult.sandbox.runnerSpec,
    );
    expect(tunnelResult.tunnel).toMatchObject({
      localPort: 3001,
      remotePort: 3001,
      portName: "gateway",
    });
    expect(stopResult.sandbox.status).toBe("stopped");
    expect(downResult.sandbox.status).toBe("destroyed");
    expect(rmResult.removed).toBe(true);
    expect(error).toHaveBeenCalledTimes(1);
  });

  it("requires production attestation verification for dstack deploy", async () => {
    const projectDir = await mkdtemp(join(tmpdir(), "tinyagent-cli-dstack-"));
    const storeDir = join(projectDir, "store");
    const stateDir = join(projectDir, "state");
    const registry = await writeRegistry();
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const error = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);

    expect(
      await main([
        "--json",
        "init",
        "--project-dir",
        projectDir,
        "--provider",
        "dstack-cvm",
        "--agent",
        "ada",
        "--pack",
        "openclaw",
        "--registry",
        registry,
        "--store-dir",
        storeDir,
        "--state-dir",
        stateDir,
      ]),
    ).toBe(0);
    await writeFile(
      join(projectDir, ".tinyagent", "deployment.json"),
      JSON.stringify(
        {
          version: 1,
          sandboxId: "dstack-sim:missing-attestation",
          provider: "dstack-cvm",
          agent: "ada",
          pack: "openclaw",
          status: "running",
          ports: [{ name: "gateway", remotePort: 3001, localPort: 3001 }],
          deployedAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
        null,
        2,
      ),
    );
    expect(await main(["--json", "tunnel", "--project-dir", projectDir])).toBe(
      1,
    );

    expect(
      await main([
        "--json",
        "deploy",
        "--project-dir",
        projectDir,
        "--execute-provider",
      ]),
    ).toBe(2);

    expect(String(error.mock.calls[0]?.[0])).toContain(
      "dstack tunnel requires a successful attestation verdict",
    );
    expect(String(error.mock.calls[1]?.[0])).toContain(
      "dstack-cvm deploy requires production attestation verification",
    );
  });

  it("deploys dstack-cvm through the real Phala CLI provider path", async () => {
    const projectDir = await mkdtemp(join(tmpdir(), "tinyagent-cli-dstack-"));
    const storeDir = join(projectDir, "store");
    const stateDir = join(projectDir, "state");
    const registry = await writeRegistry();
    const commandLog = join(projectDir, "phala-commands.jsonl");
    const composeHash = (
      await readFile("runner/app-compose.sha256", "utf8")
    ).trim();
    const phalaBin = await writeFakePhalaBin({
      commandLog,
      composeHash,
    });
    const verifyServer = createServer((request, response) => {
      expect(request.method).toBe("POST");
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ verified: true }));
    });
    await listen(verifyServer);
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    try {
      const verifyPort = (verifyServer.address() as AddressInfo).port;
      expect(
        await main([
          "--json",
          "init",
          "--project-dir",
          projectDir,
          "--provider",
          "dstack-cvm",
          "--agent",
          "ada",
          "--pack",
          "openclaw",
          "--registry",
          registry,
          "--store-dir",
          storeDir,
          "--state-dir",
          stateDir,
          "--runner-image",
          "tinyagent-runner:test-fixture",
        ]),
      ).toBe(0);
      expect(
        await main([
          "--json",
          "deploy",
          "--project-dir",
          projectDir,
          "--phala-bin",
          phalaBin,
          "--phala-verify-url",
          `http://127.0.0.1:${verifyPort}/verify`,
        ]),
      ).toBe(0);
      expect(
        await main(["--json", "status", "--project-dir", projectDir]),
      ).toBe(0);
      expect(
        await main(["--json", "tunnel", "--project-dir", projectDir]),
      ).toBe(0);
      expect(
        await main([
          "--json",
          "down",
          "--project-dir",
          projectDir,
          "--phala-bin",
          phalaBin,
        ]),
      ).toBe(0);

      const outputs = log.mock.calls.map((call) => JSON.parse(String(call[0])));
      const deployResult = outputs[1];
      const statusResult = outputs[2];
      const tunnelResult = outputs[3];
      expect(deployResult).toMatchObject({
        ok: true,
        sandbox: {
          sandboxId: "cvm-123",
          provider: "dstack-cvm",
          status: "running",
          attestation: {
            ok: true,
            checks: { productionDcap: true },
          },
        },
        providerExecution: {
          provider: "dstack-cvm",
          installed: "openclaw",
          started: "openclaw",
          attested: true,
        },
      });
      expect(statusResult.sandbox.attestation.ok).toBe(true);
      expect(tunnelResult.tunnel).toMatchObject({
        id: "cvm-123:3001",
        remotePort: 3001,
        localPort: 3001,
      });

      const commands = (await readFile(commandLog, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as string[]);
      expect(commands[0]).toEqual([
        phalaBin,
        "deploy",
        "--json",
        "--wait",
        "--name",
        "tinyagent-ada",
        "--compose",
        expect.any(String),
        "--no-public-logs",
        "--no-public-sysinfo",
        "--env",
        "TINYAGENT_AGENT=ada",
        "--env",
        "TINYAGENT_PACK=openclaw",
        "--env",
        "TINYAGENT_STATE_DIR=/state",
      ]);
      expect(stateDir).toBeTruthy();
      expect(commands).toContainEqual([
        phalaBin,
        "cvms",
        "start",
        "cvm-123",
        "--json",
      ]);
      expect(commands).toContainEqual([
        phalaBin,
        "ssh",
        "cvm-123",
        "--",
        "sh",
        "-lc",
        expect.stringMatching(/0x[0-9a-f]{64}.*GetQuote/),
      ]);
      expect(commands).toContainEqual([
        phalaBin,
        "cvms",
        "delete",
        "cvm-123",
        "--yes",
        "--json",
      ]);
      expect(commands.some((command) => command[1] === "ssh")).toBe(true);
    } finally {
      log.mockRestore();
      await closeServer(verifyServer);
    }
  }, 15_000);

  it("preflights the current Phala CLI and production verifier before live dstack", async () => {
    const projectDir = await mkdtemp(
      join(tmpdir(), "tinyagent-cli-preflight-"),
    );
    const commandLog = join(projectDir, "phala-commands.jsonl");
    const phalaBin = await writeFakePhalaBin({
      commandLog,
      composeHash: "sha256:compose",
    });
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    try {
      expect(
        await main([
          "--json",
          "preflight",
          "dstack",
          "--phala-bin",
          phalaBin,
          "--phala-verify-url",
          "http://127.0.0.1:1234/verify",
        ]),
      ).toBe(0);

      const output = JSON.parse(String(log.mock.calls[0]?.[0]));
      expect(output).toMatchObject({
        ok: true,
        preflight: {
          target: "dstack-cvm",
          phalaBin,
          commandSurface: { deploy: true, cvms: true },
          authenticated: true,
          productionVerifierConfigured: true,
          runnerComposeHash: expect.stringMatching(/^sha256:/),
        },
      });
      const commands = (await readFile(commandLog, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as string[]);
      expect(commands).toEqual([
        [phalaBin, "--help"],
        [phalaBin, "whoami", "--json"],
      ]);
    } finally {
      log.mockRestore();
    }
  });

  it("preflight accepts an argv-style Phala command prefix", async () => {
    const projectDir = await mkdtemp(
      join(tmpdir(), "tinyagent-cli-preflight-"),
    );
    const commandLog = join(projectDir, "phala-commands.jsonl");
    const phalaBin = await writeFakePhalaBin({
      commandLog,
      composeHash: "sha256:compose",
    });
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    try {
      expect(
        await main([
          "--json",
          "preflight",
          "dstack",
          "--phala-command",
          `${phalaBin} --profile ci`,
          "--phala-verify-url",
          "http://127.0.0.1:1234/verify",
        ]),
      ).toBe(0);

      const commands = (await readFile(commandLog, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as string[]);
      expect(commands).toEqual([
        [phalaBin, "--profile", "ci", "--help"],
        [phalaBin, "--profile", "ci", "whoami", "--json"],
      ]);
    } finally {
      log.mockRestore();
    }
  });

  it("preflight fails before live dstack when Phala is unauthenticated", async () => {
    const projectDir = await mkdtemp(
      join(tmpdir(), "tinyagent-cli-preflight-"),
    );
    const commandLog = join(projectDir, "phala-commands.jsonl");
    const phalaBin = await writeFakePhalaBin({
      commandLog,
      composeHash: "sha256:compose",
      authenticated: false,
    });
    const error = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);

    try {
      expect(
        await main([
          "--json",
          "preflight",
          "dstack",
          "--phala-bin",
          phalaBin,
          "--phala-verify-url",
          "http://127.0.0.1:1234/verify",
        ]),
      ).toBe(1);
      const output = JSON.parse(String(error.mock.calls[0]?.[0]));
      expect(output).toMatchObject({
        ok: false,
        code: "DSTACK_PREFLIGHT_PHALA_AUTH_FAILED",
      });
    } finally {
      error.mockRestore();
    }
  });

  it("preflight reports a missing Phala CLI as a preflight failure", async () => {
    const error = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);

    expect(
      await main([
        "--json",
        "preflight",
        "dstack",
        "--phala-bin",
        "tinyagent-missing-phala-bin",
        "--phala-verify-url",
        "http://127.0.0.1:1234/verify",
      ]),
    ).toBe(1);
    const output = JSON.parse(String(error.mock.calls[0]?.[0]));
    expect(output).toMatchObject({
      ok: false,
      code: "DSTACK_PREFLIGHT_PHALA_CLI_INVALID",
      details: {
        phalaBin: "tinyagent-missing-phala-bin",
        exitCode: 127,
      },
    });
  });

  it("sends chat prompts to the running deployment gateway", async () => {
    const server = createServer((request, response) => {
      let body = "";
      request.setEncoding("utf8");
      request.on("data", (chunk) => {
        body += chunk;
      });
      request.on("end", () => {
        const parsed = JSON.parse(body);
        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: `echo:${parsed.messages[0].content}`,
                },
              },
            ],
          }),
        );
      });
    });
    await listen(server);
    try {
      const port = (server.address() as AddressInfo).port;
      const projectDir = await mkdtemp(
        join(tmpdir(), "tinyagent-cli-project-"),
      );
      const registry = await writeRegistry(port);
      const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

      expect(
        await main([
          "--json",
          "init",
          "--project-dir",
          projectDir,
          "--agent",
          "ada",
          "--pack",
          "openclaw",
          "--registry",
          registry,
        ]),
      ).toBe(0);
      expect(
        await main(["--json", "deploy", "--project-dir", projectDir]),
      ).toBe(0);
      expect(
        await main([
          "--json",
          "chat",
          "--project-dir",
          projectDir,
          "--message",
          "hello gateway",
          "--model",
          "test-model",
        ]),
      ).toBe(0);

      const chatResult = JSON.parse(String(log.mock.calls[2]?.[0]));
      expect(chatResult).toMatchObject({
        ok: true,
        model: "test-model",
        message: "hello gateway",
        response: "echo:hello gateway",
      });
      expect(chatResult.endpoint).toBe(
        `http://127.0.0.1:${port}/v1/chat/completions`,
      );
    } finally {
      await closeServer(server);
    }
  });

  it("redacts chat gateway error bodies before printing them", async () => {
    const server = createServer((_request, response) => {
      response.writeHead(500, { "content-type": "text/plain" });
      response.end(
        "OPENAI_API_KEY=sk-test-secret Authorization: Bearer abc123",
      );
    });
    await listen(server);
    try {
      const port = (server.address() as AddressInfo).port;
      const error = vi
        .spyOn(console, "error")
        .mockImplementation(() => undefined);

      expect(
        await main([
          "--json",
          "chat",
          "--url",
          `http://127.0.0.1:${port}/v1/chat/completions`,
          "--message",
          "hello",
        ]),
      ).toBe(1);

      const output = String(error.mock.calls[0]?.[0]);
      expect(output).not.toContain("sk-test-secret");
      expect(output).not.toContain("abc123");
      expect(output).toContain("[REDACTED]");
    } finally {
      await closeServer(server);
    }
  });

  it("migrates a source state directory into the project state", async () => {
    const projectDir = await mkdtemp(join(tmpdir(), "tinyagent-cli-project-"));
    const sourceDir = await mkdtemp(join(tmpdir(), "tinyagent-cli-source-"));
    const stateDir = join(projectDir, "state");
    const storeDir = join(projectDir, "store");
    const registry = await writeRegistry();
    const signatureHex = Buffer.from(new Uint8Array(65).fill(8)).toString(
      "hex",
    );
    await mkdir(join(sourceDir, "memory"), { recursive: true });
    await writeFile(join(sourceDir, "memory", "note.txt"), "migrated state");
    await mkdir(join(stateDir, "memory"), { recursive: true });
    await writeFile(join(stateDir, "memory", "note.txt"), "old state");
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    expect(
      await main([
        "--json",
        "init",
        "--project-dir",
        projectDir,
        "--agent",
        "ada",
        "--pack",
        "openclaw",
        "--registry",
        registry,
        "--store-dir",
        storeDir,
        "--state-dir",
        stateDir,
      ]),
    ).toBe(0);
    expect(
      await main([
        "--json",
        "migrate",
        "--project-dir",
        projectDir,
        "--source-dir",
        sourceDir,
        "--space",
        "space",
        "--signature-hex",
        signatureHex,
      ]),
    ).toBe(0);

    await expect(
      readFile(join(stateDir, "memory", "note.txt"), "utf8"),
    ).resolves.toBe("migrated state");
    const migrateResult = JSON.parse(String(log.mock.calls[1]?.[0]));
    expect(migrateResult).toMatchObject({
      ok: true,
      agent: "ada",
      pack: "openclaw",
      sourceDir,
      targetDir: stateDir,
      chunks: expect.any(Number),
    });
  });

  it("verifies an attestation document from disk", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tinyagent-cli-attest-"));
    const docPath = join(dir, "attestation.json");
    await writeFile(
      docPath,
      JSON.stringify({
        provider: "dstack-cvm",
        quote: "quote",
        composeHash: "sha256:compose",
        timestamp: "2026-01-01T00:00:00.000Z",
        nonce: "nonce-123",
      }),
    );

    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    expect(
      await main([
        "--json",
        "attest",
        "verify",
        "--doc",
        docPath,
        "--expected-compose-hash",
        "sha256:compose",
        "--nonce",
        "nonce-123",
      ]),
    ).toBe(0);
    await vi.waitFor(() => expect(log).toHaveBeenCalled());
    const parsed = JSON.parse(String(log.mock.calls[0]?.[0]));
    expect(parsed.ok).toBe(true);
    expect(parsed.checks.composeHash).toBe(true);
  });

  it("verifies an attestation against the committed runner compose hash", async () => {
    const composeHash = (
      await readFile("runner/app-compose.sha256", "utf8")
    ).trim();
    const dir = await mkdtemp(join(tmpdir(), "tinyagent-cli-attest-"));
    const docPath = join(dir, "attestation.json");
    await writeFile(
      docPath,
      JSON.stringify({
        provider: "dstack-cvm",
        quote: "quote",
        composeHash,
        timestamp: "2026-01-01T00:00:00.000Z",
      }),
    );

    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    expect(
      await main([
        "--json",
        "attest",
        "verify",
        "--doc",
        docPath,
        "--expected-runner-compose",
      ]),
    ).toBe(0);
    const parsed = JSON.parse(String(log.mock.calls[0]?.[0]));
    expect(parsed.ok).toBe(true);
    expect(parsed.checks.composeHash).toBe(true);
  });

  it("rejects conflicting attestation compose-hash inputs", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tinyagent-cli-attest-"));
    const docPath = join(dir, "attestation.json");
    await writeFile(
      docPath,
      JSON.stringify({
        provider: "dstack-cvm",
        quote: "quote",
        composeHash: "sha256:compose",
        timestamp: "2026-01-01T00:00:00.000Z",
      }),
    );

    const error = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    expect(
      await main([
        "--json",
        "attest",
        "verify",
        "--doc",
        docPath,
        "--expected-compose-hash",
        "sha256:compose",
        "--expected-runner-compose",
      ]),
    ).toBe(2);
    expect(String(error.mock.calls[0]?.[0])).toContain(
      "only one of --expected-compose-hash or --expected-runner-compose",
    );
  });

  it("verifies the attestation persisted in deployment state", async () => {
    const projectDir = await mkdtemp(join(tmpdir(), "tinyagent-cli-attest-"));
    await mkdir(join(projectDir, ".tinyagent"), { recursive: true });
    await writeFile(
      join(projectDir, ".tinyagent", "deployment.json"),
      JSON.stringify({
        version: 1,
        sandboxId: "cvm-123",
        provider: "dstack-cvm",
        agent: "ada",
        pack: "openclaw",
        status: "running",
        ports: [],
        attestation: {
          ok: true,
          doc: {
            provider: "dstack-cvm",
            quote: "quote",
            composeHash: "sha256:compose",
            timestamp: "2026-01-01T00:00:00.000Z",
          },
          errors: [],
          warnings: [],
          checks: {
            schema: true,
            composeHash: true,
            nonce: true,
            timestamp: true,
            productionDcap: false,
            rtmrReplay: true,
            gatewayBinding: true,
          },
        },
        deployedAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      }),
    );

    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    expect(
      await main([
        "--json",
        "attest",
        "verify",
        "--deployment",
        "--project-dir",
        projectDir,
        "--expected-compose-hash",
        "sha256:compose",
      ]),
    ).toBe(0);
    const parsed = JSON.parse(String(log.mock.calls[0]?.[0]));
    expect(parsed.ok).toBe(true);
    expect(parsed.doc.composeHash).toBe("sha256:compose");
  });

  it("rejects conflicting attestation document sources", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tinyagent-cli-attest-"));
    const docPath = join(dir, "attestation.json");
    await writeFile(
      docPath,
      JSON.stringify({
        provider: "dstack-cvm",
        quote: "quote",
        composeHash: "sha256:compose",
        timestamp: "2026-01-01T00:00:00.000Z",
      }),
    );

    const error = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    expect(
      await main([
        "--json",
        "attest",
        "verify",
        "--doc",
        docPath,
        "--deployment",
      ]),
    ).toBe(2);
    expect(String(error.mock.calls[0]?.[0])).toContain(
      "only one of --doc or --deployment",
    );
  });

  it("surfaces the dcap-qvl production verifier when requested", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tinyagent-cli-attest-"));
    const docPath = join(dir, "attestation.json");
    await writeFile(
      docPath,
      JSON.stringify({
        provider: "dstack-cvm",
        quote: "quote",
        composeHash: "sha256:compose",
        timestamp: "2026-01-01T00:00:00.000Z",
      }),
    );

    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    expect(
      await main([
        "--json",
        "attest",
        "verify",
        "--doc",
        docPath,
        "--dcap-qvl",
      ]),
    ).toBe(1);
    const parsed = JSON.parse(String(log.mock.calls[0]?.[0]));
    expect(parsed.checks.productionDcap).toBe(false);
    expect(parsed.errors.join(" ")).toContain("DCAP backend not available");
  });

  it("verifies an attestation document through a Phala-compatible endpoint", async () => {
    const server = createServer((request, response) => {
      expect(request.method).toBe("POST");
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ verified: true, rtmrs: { 1: "0xAB" } }));
    });
    await listen(server);
    try {
      const dir = await mkdtemp(join(tmpdir(), "tinyagent-cli-attest-"));
      const docPath = join(dir, "attestation.json");
      await writeFile(
        docPath,
        JSON.stringify({
          provider: "dstack-cvm",
          quote: "quote",
          composeHash: "sha256:compose",
          timestamp: "2026-01-01T00:00:00.000Z",
        }),
      );

      const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
      const port = (server.address() as AddressInfo).port;
      expect(
        await main([
          "--json",
          "attest",
          "verify",
          "--doc",
          docPath,
          "--phala-verify-url",
          `http://127.0.0.1:${port}/verify`,
        ]),
      ).toBe(0);
      const parsed = JSON.parse(String(log.mock.calls[0]?.[0]));
      expect(parsed.ok).toBe(true);
      expect(parsed.checks.productionDcap).toBe(true);
    } finally {
      await closeServer(server);
    }
  });

  it("backs up and recovers a local state directory", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "tinyagent-cli-state-"));
    const storeDir = await mkdtemp(join(tmpdir(), "tinyagent-cli-store-"));
    const targetDir = await mkdtemp(join(tmpdir(), "tinyagent-cli-recover-"));
    await mkdir(join(stateDir, "memory"), { recursive: true });
    await writeFile(join(stateDir, "memory", "note.txt"), "state survives");
    const signatureHex = Buffer.from(new Uint8Array(65).fill(7)).toString(
      "hex",
    );

    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    expect(
      await main([
        "--json",
        "backup",
        "--agent",
        "ada",
        "--pack",
        "openclaw",
        "--state-dir",
        stateDir,
        "--store-dir",
        storeDir,
        "--space",
        "space",
        "--signature-hex",
        signatureHex,
      ]),
    ).toBe(0);
    await vi.waitFor(() => expect(log).toHaveBeenCalledTimes(1));

    expect(
      await main([
        "--json",
        "backups",
        "list",
        "--agent",
        "ada",
        "--store-dir",
        storeDir,
      ]),
    ).toBe(0);
    await vi.waitFor(() => expect(log).toHaveBeenCalledTimes(2));

    await writeFile(join(stateDir, "memory", "note.txt"), "state survives v2");
    await delay(5);
    expect(
      await main([
        "--json",
        "backup",
        "--agent",
        "ada",
        "--pack",
        "openclaw",
        "--state-dir",
        stateDir,
        "--store-dir",
        storeDir,
        "--space",
        "space",
        "--signature-hex",
        signatureHex,
      ]),
    ).toBe(0);
    await vi.waitFor(() => expect(log).toHaveBeenCalledTimes(3));

    expect(
      await main([
        "--json",
        "backups",
        "gc",
        "--agent",
        "ada",
        "--store-dir",
        storeDir,
        "--keep-last",
        "1",
      ]),
    ).toBe(0);
    await vi.waitFor(() => expect(log).toHaveBeenCalledTimes(4));

    expect(
      await main([
        "--json",
        "recover",
        "--agent",
        "ada",
        "--target-dir",
        targetDir,
        "--store-dir",
        storeDir,
        "--space",
        "space",
        "--signature-hex",
        signatureHex,
      ]),
    ).toBe(0);
    await vi.waitFor(() => expect(log).toHaveBeenCalledTimes(5));

    await expect(
      readFile(join(targetDir, "memory", "note.txt"), "utf8"),
    ).resolves.toBe("state survives v2");
    const backupResult = JSON.parse(String(log.mock.calls[0]?.[0]));
    const listResult = JSON.parse(String(log.mock.calls[1]?.[0]));
    const gcResult = JSON.parse(String(log.mock.calls[3]?.[0]));
    const recoverResult = JSON.parse(String(log.mock.calls[4]?.[0]));
    expect(backupResult.ok).toBe(true);
    expect(listResult.backups).toEqual([
      expect.objectContaining({
        pack: "openclaw",
        chunks: expect.any(Number),
        latest: true,
      }),
    ]);
    expect(gcResult.deletedSnapshots).toHaveLength(1);
    expect(gcResult.keptSnapshots).toHaveLength(1);
    expect(gcResult.retainedBytes).toBeGreaterThan(0);
    expect(recoverResult.ok).toBe(true);
  });

  it("backs up and recovers using wallet signing instead of raw signature hex", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "tinyagent-cli-state-"));
    const storeDir = await mkdtemp(join(tmpdir(), "tinyagent-cli-store-"));
    const targetDir = await mkdtemp(join(tmpdir(), "tinyagent-cli-recover-"));
    const wrongTargetDir = await mkdtemp(
      join(tmpdir(), "tinyagent-cli-recover-wrong-"),
    );
    await mkdir(join(stateDir, "memory"), { recursive: true });
    await writeFile(join(stateDir, "memory", "note.txt"), "wallet state");

    const walletPrivateKey = `0x${Buffer.from(new Uint8Array(32).fill(11)).toString("hex")}`;
    const wrongWalletPrivateKey = `0x${Buffer.from(new Uint8Array(32).fill(12)).toString("hex")}`;
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    expect(
      await main([
        "--json",
        "backup",
        "--agent",
        "ada",
        "--pack",
        "openclaw",
        "--state-dir",
        stateDir,
        "--store-dir",
        storeDir,
        "--space",
        "space",
        "--wallet-private-key",
        walletPrivateKey,
      ]),
    ).toBe(0);

    expect(
      await main([
        "--json",
        "recover",
        "--agent",
        "ada",
        "--target-dir",
        targetDir,
        "--store-dir",
        storeDir,
        "--space",
        "space",
        "--wallet-private-key",
        walletPrivateKey,
      ]),
    ).toBe(0);

    expect(
      await main([
        "--json",
        "recover",
        "--agent",
        "ada",
        "--target-dir",
        wrongTargetDir,
        "--store-dir",
        storeDir,
        "--space",
        "space",
        "--wallet-private-key",
        wrongWalletPrivateKey,
      ]),
    ).toBe(1);

    await expect(
      readFile(join(targetDir, "memory", "note.txt"), "utf8"),
    ).resolves.toBe("wallet state");
    const backupResult = JSON.parse(String(log.mock.calls[0]?.[0]));
    const recoverResult = JSON.parse(String(log.mock.calls[1]?.[0]));
    expect(backupResult.backupPublicKeyId).toMatch(/^bpk_/);
    expect(recoverResult.ok).toBe(true);
  });

  it("manages local secrets without printing plaintext in JSON mode", async () => {
    const storeDir = await mkdtemp(join(tmpdir(), "tinyagent-cli-secrets-"));
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    expect(
      await main([
        "--json",
        "secrets",
        "set",
        "OPENAI_API_KEY",
        "--store-dir",
        storeDir,
        "--value",
        "sk-test",
      ]),
    ).toBe(0);
    await vi.waitFor(() => expect(log).toHaveBeenCalledTimes(1));

    expect(
      await main(["--json", "secrets", "list", "--store-dir", storeDir]),
    ).toBe(0);
    await vi.waitFor(() => expect(log).toHaveBeenCalledTimes(2));

    expect(
      await main([
        "--json",
        "secrets",
        "get",
        "OPENAI_API_KEY",
        "--store-dir",
        storeDir,
      ]),
    ).toBe(0);
    await vi.waitFor(() => expect(log).toHaveBeenCalledTimes(3));

    expect(
      await main([
        "--json",
        "secrets",
        "delete",
        "OPENAI_API_KEY",
        "--store-dir",
        storeDir,
      ]),
    ).toBe(0);
    await vi.waitFor(() => expect(log).toHaveBeenCalledTimes(4));

    const listed = JSON.parse(String(log.mock.calls[1]?.[0]));
    const fetched = JSON.parse(String(log.mock.calls[2]?.[0]));
    expect(listed.secrets).toEqual(["OPENAI_API_KEY"]);
    expect(fetched).toEqual({
      ok: true,
      name: "OPENAI_API_KEY",
      valueHex: Buffer.from("sk-test").toString("hex"),
    });
    expect(String(log.mock.calls[2]?.[0])).not.toContain("sk-test");
  });

  it("rejects unsafe local secret names", async () => {
    const storeDir = await mkdtemp(join(tmpdir(), "tinyagent-cli-secrets-"));
    const error = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);

    expect(
      await main([
        "--json",
        "secrets",
        "set",
        "../TOKEN",
        "--store-dir",
        storeDir,
        "--value",
        "secret",
      ]),
    ).toBe(1);
    await vi.waitFor(() => expect(error).toHaveBeenCalled());
    expect(String(error.mock.calls[0]?.[0])).toContain("unsafe secret name");
  });

  it("rejects malformed hex inputs before deriving keys or writing secrets", async () => {
    const storeDir = await mkdtemp(join(tmpdir(), "tinyagent-cli-secrets-"));
    const error = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);

    expect(
      await main([
        "--json",
        "secrets",
        "set",
        "TOKEN",
        "--store-dir",
        storeDir,
        "--value-hex",
        "abc",
      ]),
    ).toBe(2);
    expect(
      await main([
        "--json",
        "derive-backup-key",
        "--space",
        "space",
        "--signature-hex",
        "not-hex",
      ]),
    ).toBe(2);

    expect(String(error.mock.calls[0]?.[0])).toContain(
      "--value-hex must be even-length hex",
    );
    expect(String(error.mock.calls[1]?.[0])).toContain(
      "--signature-hex must be even-length hex",
    );
  });

  it("controls backupd over a loopback or forwarded URL", async () => {
    const keypair = {
      publicKeyId: "bpk_test",
      publicKey: new Uint8Array(32),
    };
    const controller = new BackupdController({
      store: new MemoryStore(),
      agent: "ada",
      pack: "openclaw",
      stateDir: await mkdtemp(join(tmpdir(), "tinyagent-backupd-cli-")),
      bpkId: keypair.publicKeyId,
      backupPublicKey: keypair.publicKey,
      backup: async () => ({
        ok: true,
        value: {
          version: 1,
          agent: "ada",
          pack: "openclaw",
          timestamp: "2026-01-01T00:00:00.000Z",
          stateDir: "/state",
          chunks: [],
          sealedContentKey: {
            version: 1,
            algorithm: "x25519-xsalsa20-poly1305-sealedbox",
            ciphertext: "ciphertext",
            backupPublicKeyId: "bpk_test",
          },
          backupPublicKeyId: "bpk_test",
          integrity: { algorithm: "blake3", digest: "digest" },
          runnerImageDigest: "local-test",
          metadata: {},
        },
      }),
      renewDelegation: async () => ({ ok: true }),
    });
    const server = await startBackupdLoopbackServer(controller);
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    try {
      expect(
        await main(["--json", "backupd", "status", "--url", server.url]),
      ).toBe(0);
      expect(
        await main(["--json", "backupd", "backup-now", "--url", server.url]),
      ).toBe(0);
      expect(
        await main([
          "--json",
          "backupd",
          "prepare-restore",
          "--url",
          server.url,
          "--version",
          "snapshot.manifest",
        ]),
      ).toBe(0);
      expect(
        await main([
          "--json",
          "backupd",
          "renew-delegation",
          "--url",
          server.url,
        ]),
      ).toBe(0);

      const outputs = log.mock.calls.map((call) => JSON.parse(String(call[0])));
      expect(outputs[0]).toMatchObject({
        ok: true,
        status: { agent: "ada", state: "idle" },
      });
      expect(outputs[1]).toMatchObject({
        ok: true,
        status: {
          agent: "ada",
          state: "idle",
          lastBackupAt: "2026-01-01T00:00:00.000Z",
        },
      });
      expect(outputs[2]).toMatchObject({
        ok: true,
        status: {
          agent: "ada",
          state: "restoring",
          error: "restore prepared for snapshot snapshot.manifest",
        },
      });
      expect(outputs[3]).toMatchObject({
        ok: true,
        status: { agent: "ada", state: "idle" },
      });
    } finally {
      await server.close();
    }
  });
});

async function writeRegistry(gatewayPort = 3001): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "tinyagent-cli-"));
  const path = join(dir, "registry.json");
  await writeFile(
    path,
    JSON.stringify({
      version: 1,
      packs: {
        bedrockify: {
          type: "base",
        },
        openclaw: {
          type: "agent",
          deps: ["bedrockify"],
          ports: { gateway: gatewayPort },
          brain: true,
          data_volume_gb: 80,
        },
      },
    }),
  );
  return path;
}

async function writeFakePhalaBin(input: {
  commandLog: string;
  composeHash: string;
  authenticated?: boolean;
}): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "tinyagent-fake-phala-"));
  const path = join(dir, "phala");
  await writeFile(
    path,
    [
      "#!/usr/bin/env node",
      "const { appendFileSync, readFileSync } = require('node:fs');",
      "const args = process.argv.slice(2);",
      `appendFileSync(${JSON.stringify(input.commandLog)}, JSON.stringify([process.argv[1], ...args]) + '\\n');`,
      `const composeHash = ${JSON.stringify(input.composeHash)};`,
      `const authenticated = ${JSON.stringify(input.authenticated ?? true)};`,
      "while (args[0] === '--profile') args.splice(0, 2);",
      "if (args[0] === '--help') {",
      "  console.log('Usage: phala <command> [options]\\nDeploy:\\n  deploy\\nManage:\\n  cvms');",
      "  process.exit(0);",
      "}",
      "if (args[0] === 'whoami') {",
      "  if (!authenticated) {",
      "    console.error(JSON.stringify({ success: false, error: 'Not authenticated. Run \"phala login\" first.' }));",
      "    process.exit(1);",
      "  }",
      "  console.log(JSON.stringify({ success: true, user: { id: 'user-123' } }));",
      "  process.exit(0);",
      "}",
      "if (args[0] === 'deploy') {",
      "  const compose = readFileSync(args[args.indexOf('--compose') + 1], 'utf8');",
      "  if (!compose.includes('tinyagent-runner:test-fixture')) process.exit(9);",
      "  if (!compose.includes('tinyagent-ada-state:/state')) process.exit(10);",
      "  if (!compose.includes('/var/run/dstack.sock:/var/run/dstack.sock')) process.exit(11);",
      "  console.log(JSON.stringify({ cvm: { id: 'cvm-123', app_id: 'app-123', compose_hash: composeHash } }));",
      "  process.exit(0);",
      "}",
      "if (args[0] === 'ssh' && args.join(' ').includes('GetQuote')) {",
      "  const joined = args.join(' ');",
      "  const match = joined.match(/0x[0-9a-f]{64}/);",
      "  console.log(JSON.stringify({ quote: 'quote', composeHash, appId: 'app-123', timestamp: '2026-01-01T00:00:00.000Z', reportData: match ? match[0] : undefined }));",
      "  process.exit(0);",
      "}",
      "if (args[0] === 'ssh' && args.join(' ').includes('GetKey')) {",
      "  console.log(JSON.stringify({ key: '00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff' }));",
      "  process.exit(0);",
      "}",
      "if (args[0] === 'ssh') {",
      "  console.log('ok');",
      "  process.exit(0);",
      "}",
      "process.exit(0);",
    ].join("\n"),
  );
  await chmod(path, 0o755);
  return path;
}

function listen(server: ReturnType<typeof createServer>): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
}

function closeServer(server: ReturnType<typeof createServer>): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
