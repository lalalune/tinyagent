import { describe, expect, it } from "vitest";
import { providerConformanceSuite } from "@tinyagent/provider-core";
import {
  DstackSimulatorProvider,
  PhalaCliProvider,
  type CommandResult,
  type CommandRunner,
} from "./index.js";

const provider = new DstackSimulatorProvider();

providerConformanceSuite("dstack simulator", {
  provider,
  remotePort: 3001,
  sandbox: {
    name: "tinyagent-dstack-sim-test",
    provider: "dstack-cvm",
    image: "tinyagent-runner:test",
    expectedComposeHash: "sha256:test-compose",
    environment: {},
    labels: {},
    mounts: [],
    agent: {
      name: "openclaw",
      dependencies: [],
      ports: [{ name: "gateway", port: 3001, protocol: "tcp" }],
      stateDirs: ["/data"],
      modelModes: [],
      secretTargets: [],
      headlessCaveats: [],
      brain: true,
    },
  },
});

describe("DstackSimulatorProvider", () => {
  it("returns nonce-bound simulated attestation", async () => {
    const sandbox = await provider.provision({
      name: "tinyagent-dstack-attest-test",
      provider: "dstack-cvm",
      image: "tinyagent-runner:test",
      expectedComposeHash: "sha256:expected",
      environment: {},
      labels: { appId: "app-test" },
      mounts: [],
      agent: {
        name: "stateless",
        dependencies: [],
        ports: [],
        stateDirs: [],
        modelModes: [],
        secretTargets: [],
        headlessCaveats: [],
        brain: false,
      },
    });

    try {
      const attestation = await provider.attest(
        sandbox,
        new Uint8Array([0xde, 0xad]),
      );
      expect(attestation).toMatchObject({
        provider: "dstack-cvm",
        composeHash: "sha256:expected",
        appId: "app-test",
        nonce: "dead",
      });
    } finally {
      await provider.destroy(sandbox);
    }
  });

  it("enforces exec timeoutMs instead of running forever", async () => {
    const sandbox = await provider.provision({
      name: "tinyagent-dstack-timeout-test",
      provider: "dstack-cvm",
      image: "tinyagent-runner:test",
      environment: {},
      labels: {},
      mounts: [],
      agent: {
        name: "stateless",
        dependencies: [],
        ports: [],
        stateDirs: [],
        modelModes: [],
        secretTargets: [],
        headlessCaveats: [],
        brain: false,
      },
    });

    try {
      const chunks = [];
      for await (const chunk of provider.exec(sandbox, {
        command: ["sh", "-lc", "sleep 1"],
        env: {},
        timeoutMs: 25,
      })) {
        chunks.push(chunk);
      }
      expect(chunks.at(-1)).toMatchObject({
        stream: "exit",
        exitCode: 124,
        timedOut: true,
        timeoutMs: 25,
      });
    } finally {
      await provider.destroy(sandbox);
    }
  });
});

describe("PhalaCliProvider", () => {
  it("provisions, controls, copies, tunnels, and attests via the Phala CLI", async () => {
    const runner = new FakePhalaRunner();
    const provider = new PhalaCliProvider({ runner, phalaBin: "phala-test" });
    const spec = {
      name: "tinyagent-openclaw",
      provider: "dstack-cvm" as const,
      image: "tinyagent-runner:test",
      expectedComposeHash: "sha256:compose",
      environment: { GATEWAY_PORT: "3001" },
      labels: { appId: "app-openclaw" },
      mounts: [{ source: "/host/state", target: "/state", readonly: false }],
      agent: {
        name: "openclaw",
        dependencies: [],
        ports: [{ name: "gateway", port: 3001, protocol: "tcp" as const }],
        stateDirs: ["/state"],
        modelModes: [],
        secretTargets: [],
        headlessCaveats: [],
        brain: true,
      },
    };

    const sandbox = await provider.provision(spec);
    expect(sandbox).toMatchObject({
      id: "cvm-123",
      provider: "dstack-cvm",
      status: "provisioned",
      metadata: { appId: "app-openclaw", composeHash: "sha256:compose" },
    });

    await provider.start(sandbox);
    expect(sandbox.status).toBe("running");

    const chunks = [];
    for await (const chunk of provider.exec(sandbox, {
      command: ["echo", "hello"],
      env: { LOWKEY_ENV: "set" },
      timeoutMs: 5000,
    })) {
      chunks.push(chunk);
    }
    expect(new TextDecoder().decode(chunks[0]?.data)).toBe("hello\n");
    expect(chunks.at(-1)).toMatchObject({ stream: "exit", exitCode: 0 });

    await provider.putFiles(sandbox, [
      {
        path: "/state/input.txt",
        content: new TextEncoder().encode("input"),
        mode: "0600",
      },
    ]);
    const files = await provider.getFiles(sandbox, ["/state/output.txt"]);
    expect(new TextDecoder().decode(files[0]!.content)).toBe("from-phala");

    const tunnel = await provider.forwardPort(sandbox, 3001, 9301);
    expect(tunnel).toMatchObject({
      id: "cvm-123:3001",
      localPort: 9301,
      remotePort: 3001,
    });
    await tunnel.close();

    const attestation = await provider.attest(
      sandbox,
      new Uint8Array([0xab, 0xcd]),
    );
    expect(attestation).toMatchObject({
      provider: "dstack-cvm",
      quote: "quote",
      composeHash: "sha256:compose",
      appId: "app-openclaw",
      nonce: "abcd",
    });

    const guestKey = await provider.getAgentKey(sandbox, "openclaw");
    expect(guestKey.path).toBe("tinycloud/agents/openclaw");
    expect(Buffer.from(guestKey.key).toString("hex")).toBe(
      "00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff",
    );

    await provider.stop(sandbox);
    await provider.destroy(sandbox);
    expect(sandbox.status).toBe("destroyed");
    expect(runner.commands).toEqual([
      [
        "phala-test",
        "deploy",
        "--json",
        "--wait",
        "--name",
        "tinyagent-openclaw",
        "--compose",
        expect.any(String),
        "--no-public-logs",
        "--no-public-sysinfo",
        "--env",
        "GATEWAY_PORT=3001",
      ],
      ["phala-test", "cvms", "start", "cvm-123", "--json"],
      [
        "phala-test",
        "ssh",
        "cvm-123",
        "--",
        "env",
        "LOWKEY_ENV=set",
        "echo",
        "hello",
      ],
      expect.arrayContaining([
        "phala-test",
        "cp",
        expect.any(String),
        "cvm-123:/state/input.txt",
      ]),
      expect.arrayContaining([
        "phala-test",
        "cp",
        "cvm-123:/state/output.txt",
        expect.any(String),
      ]),
      [
        "phala-test",
        "ssh",
        "cvm-123",
        "--",
        "sh",
        "-lc",
        "curl -fsS -X POST --unix-socket /var/run/dstack.sock -H 'Content-Type: application/json' -d '{\"reportData\":\"0xabcd\"}' http://dstack/GetQuote",
      ],
      [
        "phala-test",
        "ssh",
        "cvm-123",
        "--",
        "sh",
        "-lc",
        "curl -fsS --unix-socket /var/run/dstack.sock 'http://dstack/GetKey?path=tinycloud%2Fagents%2Fopenclaw'",
      ],
      ["phala-test", "cvms", "stop", "cvm-123", "--json"],
      ["phala-test", "cvms", "delete", "cvm-123", "--yes", "--json"],
    ]);
    expect(runner.deployCompose).toContain('image: "tinyagent-runner:test"');
    expect(runner.deployCompose).toContain('"appId": "app-openclaw"');
    expect(runner.deployCompose).toContain('- "GATEWAY_PORT=3001"');
    expect(runner.deployCompose).toContain('- "3001:3001"');
    expect(runner.deployCompose).toContain(
      '- "tinyagent-openclaw-state:/state"',
    );
    expect(runner.deployCompose).toContain(
      '- "/var/run/dstack.sock:/var/run/dstack.sock"',
    );
    expect(runner.deployCompose).toContain('"tinyagent-openclaw-state":');
    expect(runner.spawned).toEqual([
      ["phala-test", "ssh", "cvm-123", "--", "-L", "9301:localhost:3001", "-N"],
    ]);
    expect(runner.closedTunnels).toBe(1);
  });

  it("maps non-zero Phala CLI exits to TinyAgent errors", async () => {
    const runner = new FakePhalaRunner({ failStarts: true });
    const provider = new PhalaCliProvider({ runner });
    const sandbox = {
      id: "cvm-123",
      name: "agent",
      provider: "dstack-cvm" as const,
      status: "provisioned" as const,
      metadata: {},
    };

    await expect(provider.start(sandbox)).rejects.toMatchObject({
      code: "PHALA_START_FAILED",
      message: "not ready",
    });
  });

  it("supports argv-style Phala command prefixes", async () => {
    const runner = new FakePhalaRunner();
    const provider = new PhalaCliProvider({
      runner,
      phalaCommand: ["bunx", "phala"],
    });
    const sandbox = phalaSandbox();

    await provider.start(sandbox);

    expect(runner.commands).toEqual([
      ["bunx", "phala", "cvms", "start", "cvm-123", "--json"],
    ]);
  });

  it("does not return a fake tunnel when the command runner cannot spawn", async () => {
    const provider = new PhalaCliProvider({
      runner: new NoSpawnRunner(),
    });
    const sandbox = phalaSandbox();

    await expect(
      provider.forwardPort(sandbox, 3001, 9301),
    ).rejects.toMatchObject({
      code: "PHALA_TUNNEL_UNSUPPORTED",
    });
  });

  it("rejects attestations without a compose hash", async () => {
    const provider = new PhalaCliProvider({
      runner: new FakePhalaRunner({ omitAttestationComposeHash: true }),
    });

    await expect(
      provider.attest(phalaSandbox({ metadata: {} }), new Uint8Array([0xab])),
    ).rejects.toMatchObject({
      code: "PHALA_RESPONSE_INVALID",
      message: "Phala attestation response is missing composeHash",
    });
  });

  it("rejects malformed guest key responses", async () => {
    const provider = new PhalaCliProvider({
      runner: new FakePhalaRunner({ malformedGuestKey: true }),
    });

    await expect(
      provider.getAgentKey(phalaSandbox(), "openclaw"),
    ).rejects.toMatchObject({
      code: "PHALA_RESPONSE_INVALID",
    });
  });
});

class FakePhalaRunner implements CommandRunner {
  commands: string[][] = [];
  spawned: string[][] = [];
  closedTunnels = 0;
  deployCompose = "";

  constructor(
    private readonly options: {
      failStarts?: boolean;
      omitAttestationComposeHash?: boolean;
      malformedGuestKey?: boolean;
    } = {},
  ) {}

  async run(command: string[]): Promise<CommandResult> {
    this.commands.push(command);
    const text = new TextEncoder();
    const subcommandIndex = command.findIndex((value) =>
      ["deploy", "ssh", "cp", "cvms"].includes(value),
    );
    const subcommand = command[subcommandIndex];
    if (command.includes("start") && this.options.failStarts) {
      return {
        stdout: new Uint8Array(),
        stderr: text.encode("not ready"),
        exitCode: 1,
      };
    }
    if (subcommand === "deploy") {
      const composePath = command[command.indexOf("--compose") + 1]!;
      this.deployCompose = await import("node:fs/promises").then(
        ({ readFile }) => readFile(composePath, "utf8"),
      );
      return jsonResult({
        cvm: {
          id: "cvm-123",
          app_id: "app-openclaw",
          compose_hash: "sha256:compose",
        },
      });
    }
    if (
      subcommand === "ssh" &&
      command[subcommandIndex + 3] === "sh" &&
      command[subcommandIndex + 5]?.includes("GetQuote")
    ) {
      return jsonResult({
        quote: "quote",
        ...(this.options.omitAttestationComposeHash
          ? {}
          : { composeHash: "sha256:compose" }),
        appId: "app-openclaw",
        timestamp: "2026-01-01T00:00:00.000Z",
        reportData: "0xabcd",
      });
    }
    if (
      subcommand === "ssh" &&
      command[subcommandIndex + 3] === "sh" &&
      command[subcommandIndex + 5]?.includes("GetKey")
    ) {
      return jsonResult({
        key: this.options.malformedGuestKey
          ? "not-hex"
          : "00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff",
      });
    }
    if (subcommand === "ssh") {
      return {
        stdout: text.encode("hello\n"),
        stderr: new Uint8Array(),
        exitCode: 0,
      };
    }
    if (
      subcommand === "cp" &&
      command[subcommandIndex + 1]?.startsWith("cvm-123:")
    ) {
      await import("node:fs/promises").then(({ writeFile }) =>
        writeFile(command[subcommandIndex + 2]!, "from-phala"),
      );
    }
    return { stdout: new Uint8Array(), stderr: new Uint8Array(), exitCode: 0 };
  }

  async spawn(command: string[]): Promise<{ close(): Promise<void> }> {
    this.spawned.push(command);
    return {
      close: async () => {
        this.closedTunnels += 1;
      },
    };
  }
}

class NoSpawnRunner implements CommandRunner {
  async run(): Promise<CommandResult> {
    return { stdout: new Uint8Array(), stderr: new Uint8Array(), exitCode: 0 };
  }
}

function jsonResult(value: unknown): CommandResult {
  return {
    stdout: new TextEncoder().encode(JSON.stringify(value)),
    stderr: new Uint8Array(),
    exitCode: 0,
  };
}

function phalaSandbox(overrides: { metadata?: Record<string, unknown> } = {}): {
  id: string;
  name: string;
  provider: "dstack-cvm";
  status: "provisioned";
  metadata: Record<string, unknown>;
} {
  return {
    id: "cvm-123",
    name: "agent",
    provider: "dstack-cvm",
    status: "provisioned",
    metadata: overrides.metadata ?? { composeHash: "sha256:compose" },
  };
}
