import { mkdtemp, readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parse as parseYaml } from "yaml";
import { describe, expect, it } from "vitest";
import type {
  AttestationDoc,
  ExecChunk,
  ExecSpec,
  FileBlob,
  FileSpec,
  Sandbox,
  SandboxSpec,
  Tunnel,
} from "@tinyagent/core";
import type { ComputeProvider } from "@tinyagent/provider-core";
import {
  buildLowkeyInstallPlan,
  buildLowkeyStartPlan,
  findAgent,
  parseLowkeyManifestText,
  parseLowkeyRegistryText,
  resolvePackDependencies,
  runLowkeyInstallPlan,
  runLowkeyStartPlan,
  writeLokiPackConfig,
  writeSecretTargets,
} from "./index.js";

const registryJson = JSON.stringify({
  version: 1,
  packs: {
    bedrockify: {
      type: "base",
      description: "proxy",
    },
    openclaw: {
      type: "agent",
      description: "OpenClaw",
      deps: ["bedrockify"],
      ports: { gateway: 3001 },
      brain: true,
      data_volume_gb: 80,
      default_model: "us.anthropic.claude-opus-4-6-v1",
    },
    "codex-cli": {
      type: "agent",
      description: "Codex",
      deps: [],
      ports: {},
      requires_openai_key: true,
    },
  },
});

describe("parseLowkeyRegistryText", () => {
  it("validates metadata against the vendored pinned Lowkey registry and manifests", async () => {
    const lowkeyRoot = join(process.cwd(), "vendor", "lowkey");
    const marker = JSON.parse(
      await readFile(join(lowkeyRoot, "TINYAGENT_VENDOR.json"), "utf8"),
    );
    expect(marker.ref).toBe(
      "inceptionstack/lowkey@5e18dac550f8cf0ac509e51679a6e41a6a90e528",
    );

    const registry = parseLowkeyRegistryText(
      await readFile(join(lowkeyRoot, "packs", "registry.yaml"), "utf8"),
      { format: "yaml" },
    );
    const packDirs = (
      await readdir(join(lowkeyRoot, "packs"), { withFileTypes: true })
    )
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
    const manifestNames = await Promise.all(
      packDirs.map(async (pack) => {
        const manifest = parseYaml(
          await readFile(
            join(lowkeyRoot, "packs", pack, "manifest.yaml"),
            "utf8",
          ),
        ) as { name?: string };
        return manifest.name;
      }),
    );
    expect(manifestNames.sort()).toEqual(packDirs);
    expect(registry.agents.map((agent) => agent.name).sort()).toEqual(packDirs);

    expect(findAgent(registry, "openclaw")).toMatchObject({
      dependencies: ["bedrockify"],
      ports: [{ name: "gateway", port: 3001, protocol: "tcp" }],
      stateDirs: ["~/.openclaw"],
      modelModes: [
        "us.anthropic.claude-opus-4-6-v1",
        "openai-compatible-proxy",
        "api-key",
      ],
      secretTargets: [
        {
          name: "ANTHROPIC_API_KEY",
          file: "~/.openclaw/openclaw.json",
          mode: "0600",
        },
      ],
      brain: true,
    });
    expect(findAgent(registry, "codex-cli")).toMatchObject({
      modelModes: ["gpt-5.4"],
      secretTargets: [
        { name: "OPENAI_API_KEY", env: "OPENAI_API_KEY", mode: "0600" },
      ],
      headlessCaveats: expect.arrayContaining([
        "experimental",
        "requires OpenAI API key",
      ]),
    });
    expect(findAgent(registry, "kiro-cli")).toMatchObject({
      secretTargets: [
        { name: "KIRO_API_KEY", env: "KIRO_API_KEY", mode: "0600" },
      ],
      headlessCaveats: expect.arrayContaining([
        "experimental",
        "requires Kiro API key for headless mode",
      ]),
    });
    expect(findAgent(registry, "ironclaw")).toMatchObject({
      stateDirs: ["postgres://ironclaw"],
      headlessCaveats: expect.arrayContaining([
        "experimental",
        "routes Bedrock through bedrockify OpenAI-compatible backend",
      ]),
    });
    expect(findAgent(registry, "nemoclaw")).toMatchObject({
      stateDirs: ["~/.nemoclaw", "docker:nemoclaw"],
      headlessCaveats: expect.arrayContaining([
        "experimental",
        "requires nested Docker",
        "compatible profiles: personal_assistant",
      ]),
    });
    expect(findAgent(registry, "roundhouse")).toMatchObject({
      secretTargets: [
        {
          name: "TELEGRAM_TOKEN",
          file: "~/.roundhouse/telegram.env",
          mode: "0600",
        },
      ],
      headlessCaveats: expect.arrayContaining([
        "requires Telegram bot token",
        "compatible profiles: builder",
      ]),
    });
  });

  it("normalizes lowkey registry packs into AgentSpec records", () => {
    const registry = parseLowkeyRegistryText(registryJson, {
      format: "json",
      lowkeyRef: "lowkey@test",
    });
    expect(registry.lowkeyRef).toBe("lowkey@test");
    expect(registry.agents.map((agent) => agent.name)).toEqual([
      "bedrockify",
      "codex-cli",
      "openclaw",
    ]);

    const openclaw = findAgent(registry, "openclaw");
    expect(openclaw?.dependencies).toEqual(["bedrockify"]);
    expect(openclaw?.ports).toEqual([
      { name: "gateway", port: 3001, protocol: "tcp" },
    ]);
    expect(openclaw?.stateDirs).toContain("~/.openclaw");
    expect(openclaw?.brain).toBe(true);
  });

  it("parses yaml registries", () => {
    const registry = parseLowkeyRegistryText(
      "version: 1\npacks:\n  pi:\n    type: agent\n    deps: [bedrockify]\n",
      {
        format: "yaml",
      },
    );
    expect(findAgent(registry, "pi")?.modelModes).toContain(
      "openai-compatible-proxy",
    );
  });

  it("reports invalid registry shape with a stable TinyAgent error", () => {
    expect(() => parseLowkeyRegistryText("{}", { format: "json" })).toThrow(
      "Lowkey registry must be an object with a packs object",
    );
    expect(() =>
      parseLowkeyRegistryText("packs: []\n", { format: "yaml" }),
    ).toThrow("Lowkey registry must be an object with a packs object");
  });

  it("reports JSON parse failures with the registry format", () => {
    expect(() => parseLowkeyRegistryText("{", { format: "json" })).toThrow(
      "could not parse Lowkey registry as json",
    );
  });

  it("normalizes the pinned fixture pack matrix metadata", async () => {
    const registry = parseLowkeyRegistryText(
      await readFile("test/fixtures/lowkey-registry.json", "utf8"),
      { format: "json" },
    );

    expect(registry.agents.map((agent) => agent.name)).toEqual([
      "bedrockify",
      "claude-code",
      "codex-cli",
      "ironclaw",
      "kiro-cli",
      "nemoclaw",
      "openclaw",
    ]);
    expect(findAgent(registry, "codex-cli")).toMatchObject({
      modelModes: ["gpt-5.4"],
      secretTargets: [
        { name: "OPENAI_API_KEY", env: "OPENAI_API_KEY", mode: "0600" },
      ],
      headlessCaveats: [
        "requires OpenAI API key",
        "compatible profiles: headless, interactive-cli",
      ],
    });
    expect(findAgent(registry, "kiro-cli")).toMatchObject({
      secretTargets: [
        { name: "KIRO_API_KEY", env: "KIRO_API_KEY", mode: "0600" },
      ],
      headlessCaveats: [
        "interactive CLI only",
        "requires Kiro API key for headless mode",
        "compatible profiles: interactive-cli",
      ],
    });
    expect(findAgent(registry, "ironclaw")).toMatchObject({
      dependencies: ["bedrockify"],
      stateDirs: ["postgres://ironclaw"],
      headlessCaveats: expect.arrayContaining([
        "experimental",
        "requires PostgreSQL",
        "requires systemd",
        "routes Bedrock through bedrockify OpenAI-compatible backend",
      ]),
    });
    expect(findAgent(registry, "nemoclaw")).toMatchObject({
      stateDirs: ["~/.nemoclaw", "docker:nemoclaw"],
      headlessCaveats: ["experimental", "requires nested Docker"],
    });
  });

  it("resolves dependencies before the requested pack", () => {
    const registry = parseLowkeyRegistryText(registryJson, {
      format: "json",
    });

    expect(
      resolvePackDependencies(registry, "openclaw").map((pack) => pack.name),
    ).toEqual(["bedrockify", "openclaw"]);
  });

  it("builds lowkey install commands in dependency order", () => {
    const registry = parseLowkeyRegistryText(registryJson, {
      format: "json",
    });

    const plan = buildLowkeyInstallPlan(registry, "openclaw", {
      lowkeyDir: "/opt/lowkey checkout",
    });

    expect(plan.target.name).toBe("openclaw");
    expect(plan.steps.map((step) => step.pack.name)).toEqual([
      "bedrockify",
      "openclaw",
    ]);
    expect(plan.steps.map((step) => step.command.command)).toEqual([
      [
        "bash",
        "-lc",
        "cd '/opt/lowkey checkout' && ./packs/'bedrockify'/install.sh",
      ],
      [
        "bash",
        "-lc",
        "cd '/opt/lowkey checkout' && ./packs/'openclaw'/install.sh",
      ],
    ]);
  });

  it("executes lowkey install steps through a provider", async () => {
    const registry = parseLowkeyRegistryText(registryJson, {
      format: "json",
    });
    const plan = buildLowkeyInstallPlan(registry, "openclaw");
    const provider = new FakeProvider();
    const sandbox = fakeSandbox();

    const result = await runLowkeyInstallPlan({
      provider,
      sandbox,
      plan,
      environment: { OPENAI_API_KEY: "sk-test" },
    });

    expect(result.installed).toEqual(["bedrockify", "openclaw"]);
    expect(provider.commands.map((command) => command.command)).toEqual(
      plan.steps.map((step) => step.command.command),
    );
    expect(
      provider.commands.map((command) => command.env.OPENAI_API_KEY),
    ).toEqual(["sk-test", "sk-test"]);
  });

  it("fails install execution on non-zero provider exit", async () => {
    const registry = parseLowkeyRegistryText(registryJson, {
      format: "json",
    });
    const provider = new FakeProvider(1);

    await expect(
      runLowkeyInstallPlan({
        provider,
        sandbox: fakeSandbox(),
        plan: buildLowkeyInstallPlan(registry, "openclaw"),
      }),
    ).rejects.toThrow("lowkey install failed for bedrockify with exit code 1");
  });

  it("builds and executes a lowkey manifest health check through a provider", async () => {
    const registry = parseLowkeyRegistryText(registryJson, {
      format: "json",
    });
    const manifest = parseLowkeyManifestText(
      await readFile("vendor/lowkey/packs/openclaw/manifest.yaml", "utf8"),
    );
    const plan = buildLowkeyStartPlan(registry, "openclaw", {
      manifest,
    });
    const provider = new FakeProvider();

    const result = await runLowkeyStartPlan({
      provider,
      sandbox: fakeSandbox(),
      plan,
      environment: { OPENAI_API_KEY: "sk-test" },
    });

    expect(result.started).toBe("openclaw");
    expect(plan.source).toBe("manifest-health-check");
    expect(plan.command.command).toEqual(["bash", "-lc", "openclaw --version"]);
    expect(plan.command.timeoutMs).toBe(10000);
    expect(provider.commands).toHaveLength(1);
    expect(provider.commands[0]?.command).toEqual(plan.command.command);
    expect(provider.commands[0]?.env.OPENAI_API_KEY).toBe("sk-test");
  });

  it("builds URL health checks from manifest defaults", async () => {
    const registry = parseLowkeyRegistryText(registryJson, {
      format: "json",
    });
    const manifest = parseLowkeyManifestText(
      await readFile("vendor/lowkey/packs/bedrockify/manifest.yaml", "utf8"),
    );
    const plan = buildLowkeyStartPlan(registry, "bedrockify", { manifest });

    expect(plan.source).toBe("manifest-health-check");
    expect(plan.command.command).toEqual([
      "bash",
      "-lc",
      "curl -fsSL 'http://127.0.0.1:8090/' | grep -F -- '\"status\":\"ok\"' >/dev/null",
    ]);
    expect(plan.command.timeoutMs).toBe(15000);
  });

  it("keeps legacy start.sh fallback for synthetic packs without manifests", () => {
    const registry = parseLowkeyRegistryText(registryJson, {
      format: "json",
    });
    const plan = buildLowkeyStartPlan(registry, "openclaw", {
      lowkeyDir: "/opt/lowkey checkout",
    });

    expect(plan.source).toBe("legacy-start-script");
    expect(plan.command.command).toEqual([
      "bash",
      "-lc",
      "cd '/opt/lowkey checkout' && ./packs/'openclaw'/start.sh",
    ]);
  });

  it("rejects a mismatched lowkey manifest", async () => {
    const registry = parseLowkeyRegistryText(registryJson, {
      format: "json",
    });
    const manifest = parseLowkeyManifestText(
      await readFile("vendor/lowkey/packs/codex-cli/manifest.yaml", "utf8"),
    );

    expect(() =>
      buildLowkeyStartPlan(registry, "openclaw", { manifest }),
    ).toThrow("lowkey manifest name codex-cli does not match openclaw");
  });

  it("fails start execution on non-zero provider exit", async () => {
    const registry = parseLowkeyRegistryText(registryJson, {
      format: "json",
    });
    const provider = new FakeProvider(1);

    await expect(
      runLowkeyStartPlan({
        provider,
        sandbox: fakeSandbox(),
        plan: buildLowkeyStartPlan(registry, "openclaw"),
      }),
    ).rejects.toThrow("lowkey start failed for openclaw with exit code 1");
  });

  it("rejects missing and cyclic dependencies", () => {
    const missing = parseLowkeyRegistryText(
      JSON.stringify({
        packs: {
          a: { deps: ["missing"] },
        },
      }),
    );
    expect(() => resolvePackDependencies(missing, "a")).toThrow(
      "missing lowkey dependency: missing",
    );

    const cycle = parseLowkeyRegistryText(
      JSON.stringify({
        packs: {
          a: { deps: ["b"] },
          b: { deps: ["a"] },
        },
      }),
    );
    expect(() => resolvePackDependencies(cycle, "a")).toThrow(
      "lowkey dependency cycle: a -> b -> a",
    );
  });

  it("writes a lowkey pack config with restricted permissions", async () => {
    const registry = parseLowkeyRegistryText(registryJson, {
      format: "json",
    });
    const openclaw = findAgent(registry, "openclaw");
    if (!openclaw) throw new Error("missing openclaw");
    const dir = await mkdtemp(join(tmpdir(), "tinyagent-packrunner-"));
    const configPath = join(dir, "loki-pack-config.json");

    await writeLokiPackConfig({
      agent: openclaw,
      name: "ada",
      modelMode: "api-key",
      stateDir: "/state/ada",
      gatewayPort: 3001,
      configPath,
    });

    const parsed = JSON.parse(await readFile(configPath, "utf8"));
    expect(parsed).toEqual({
      pack: "openclaw",
      name: "ada",
      dependencies: ["bedrockify"],
      ports: { gateway: 3001 },
      stateDirs: ["~/.openclaw"],
      modelMode: "api-key",
      stateDir: "/state/ada",
      gatewayPort: 3001,
    });
    expect((await stat(configPath)).mode & 0o777).toBe(0o600);
  });

  it("writes secret files with requested modes and returns env values", async () => {
    const registry = parseLowkeyRegistryText(registryJson, {
      format: "json",
    });
    const openclaw = findAgent(registry, "openclaw");
    const codex = findAgent(registry, "codex-cli");
    if (!openclaw || !codex) throw new Error("missing agents");
    const dir = await mkdtemp(join(tmpdir(), "tinyagent-packrunner-"));

    const openclawSecrets = await writeSecretTargets({
      agent: openclaw,
      homeDir: dir,
      secrets: {
        ANTHROPIC_API_KEY: new TextEncoder().encode("sk-ant"),
      },
    });
    const openclawFile = join(dir, ".openclaw", "openclaw.json");
    expect(openclawSecrets.files).toEqual([
      {
        name: "ANTHROPIC_API_KEY",
        path: openclawFile,
        mode: "0600",
      },
    ]);
    await expect(readFile(openclawFile, "utf8")).resolves.toBe("sk-ant");
    expect((await stat(openclawFile)).mode & 0o777).toBe(0o600);

    const codexSecrets = await writeSecretTargets({
      agent: codex,
      homeDir: dir,
      secrets: {
        OPENAI_API_KEY: new TextEncoder().encode("sk-openai"),
      },
    });
    expect(codexSecrets).toEqual({
      environment: { OPENAI_API_KEY: "sk-openai" },
      files: [],
    });
  });

  it("fails when a required secret is missing", async () => {
    const registry = parseLowkeyRegistryText(registryJson, {
      format: "json",
    });
    const codex = findAgent(registry, "codex-cli");
    if (!codex) throw new Error("missing codex");
    const dir = await mkdtemp(join(tmpdir(), "tinyagent-packrunner-"));

    await expect(
      writeSecretTargets({ agent: codex, homeDir: dir, secrets: {} }),
    ).rejects.toThrow("missing secret: OPENAI_API_KEY");
  });
});

class FakeProvider implements ComputeProvider {
  readonly kind = "local-docker" as const;
  readonly commands: ExecSpec[] = [];

  constructor(private readonly exitCode = 0) {}

  async provision(spec: SandboxSpec): Promise<Sandbox> {
    return {
      id: "sandbox",
      name: spec.name,
      provider: this.kind,
      status: "provisioned",
      metadata: {},
    };
  }

  async start(): Promise<void> {
    return;
  }

  async stop(): Promise<void> {
    return;
  }

  async destroy(): Promise<void> {
    return;
  }

  async *exec(_sandbox: Sandbox, command: ExecSpec): AsyncIterable<ExecChunk> {
    this.commands.push(command);
    yield { stream: "exit", exitCode: this.exitCode };
  }

  async putFiles(_sandbox: Sandbox, _files: FileSpec[]): Promise<void> {
    return;
  }

  async getFiles(): Promise<FileBlob[]> {
    return [];
  }

  async forwardPort(
    _sandbox: Sandbox,
    remotePort: number,
    localPort: number,
  ): Promise<Tunnel> {
    return {
      id: "tunnel",
      remotePort,
      localPort,
      close: async () => undefined,
    };
  }

  async attest(): Promise<AttestationDoc | null> {
    return null;
  }
}

function fakeSandbox(): Sandbox {
  return {
    id: "sandbox",
    name: "ada",
    provider: "local-docker",
    status: "running",
    metadata: {},
  };
}
