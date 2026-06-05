import { chmod, mkdir, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, normalize } from "node:path";
import { parse as parseYaml } from "yaml";
import {
  AgentSpecSchema,
  type AgentSpec,
  type ExecSpec,
  type Sandbox,
  type PortSpec,
  type SecretTarget,
  TinyAgentError,
} from "@tinyagent/core";
import type { ComputeProvider } from "@tinyagent/provider-core";

export const DEFAULT_LOWKEY_REF =
  "inceptionstack/lowkey@5e18dac550f8cf0ac509e51679a6e41a6a90e528";

export interface PackRegistry {
  readonly version: number;
  readonly lowkeyRef: string;
  readonly agents: readonly AgentSpec[];
}

export interface LokiPackConfigInput {
  agent: AgentSpec;
  name: string;
  modelMode?: string;
  stateDir?: string;
  gatewayPort?: number;
  configPath?: string;
}

export interface PreparedSecretInput {
  agent: AgentSpec;
  secrets: Record<string, Uint8Array>;
  homeDir: string;
}

export interface PreparedSecrets {
  environment: Record<string, string>;
  files: Array<{ name: string; path: string; mode: string }>;
}

export interface PackInstallStep {
  pack: AgentSpec;
  command: ExecSpec;
}

export interface LowkeyInstallPlan {
  target: AgentSpec;
  installOrder: AgentSpec[];
  steps: PackInstallStep[];
}

export interface LowkeyStartPlan {
  target: AgentSpec;
  command: ExecSpec;
  source: "manifest-health-check" | "legacy-start-script";
}

export interface RunLowkeyInstallPlanInput {
  provider: ComputeProvider;
  sandbox: Sandbox;
  plan: LowkeyInstallPlan;
  environment?: Record<string, string>;
}

export interface RunLowkeyStartPlanInput {
  provider: ComputeProvider;
  sandbox: Sandbox;
  plan: LowkeyStartPlan;
  environment?: Record<string, string>;
}

export interface RunLowkeyInstallPlanResult {
  installed: string[];
}

export interface RunLowkeyStartPlanResult {
  started: string;
}

interface LowkeyRegistry {
  version?: number;
  defaults?: Record<string, unknown>;
  packs: Record<string, LowkeyPack>;
}

interface LowkeyPack {
  type?: "base" | "agent";
  description?: string;
  deps?: string[];
  ports?: Record<string, number>;
  brain?: boolean;
  data_volume_gb?: number;
  root_volume_gb?: number;
  arch?: string;
  os?: string;
  default_model?: string;
  experimental?: boolean;
  requires_docker?: boolean;
  requires_postgres?: boolean;
  requires_systemd?: boolean;
  interactive_only?: boolean;
  requires_openai_key?: boolean;
  requires_telegram_token?: boolean;
  compatible_profiles?: string[];
}

interface LowkeyManifestParam {
  name: string;
  default?: string | number | boolean;
}

interface LowkeyManifestHealthCheck {
  command?: string;
  url?: string;
  expect?: string;
  timeout?: number;
}

export interface LowkeyPackManifest {
  name: string;
  healthCheck?: LowkeyManifestHealthCheck;
  params: LowkeyManifestParam[];
}

export function parseLowkeyRegistryText(
  input: string,
  options: { format?: "json" | "yaml"; lowkeyRef?: string } = {},
): PackRegistry {
  const format = options.format ?? inferFormat(input);
  let raw: unknown;
  try {
    raw = format === "json" ? JSON.parse(input) : parseYaml(input);
  } catch (error) {
    throw new TinyAgentError(
      "LOWKEY_REGISTRY_PARSE_FAILED",
      `could not parse Lowkey registry as ${format}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  return normalizeLowkeyRegistry(
    assertLowkeyRegistry(raw),
    options.lowkeyRef ?? DEFAULT_LOWKEY_REF,
  );
}

export function normalizeLowkeyRegistry(
  raw: LowkeyRegistry,
  lowkeyRef = DEFAULT_LOWKEY_REF,
): PackRegistry {
  const agents = Object.entries(raw.packs)
    .map(([name, pack]) => normalizePack(name, pack))
    .sort((a, b) => a.name.localeCompare(b.name));
  return {
    version: raw.version ?? 1,
    lowkeyRef,
    agents,
  };
}

export function parseLowkeyManifestText(input: string): LowkeyPackManifest {
  const raw = parseYaml(input) as unknown;
  if (!isRecord(raw) || typeof raw.name !== "string") {
    throw new TinyAgentError(
      "LOWKEY_MANIFEST_INVALID",
      "Lowkey manifest must be an object with a name",
      { manifest: raw },
    );
  }
  return {
    name: raw.name,
    params: Array.isArray(raw.params)
      ? raw.params
          .filter(isRecord)
          .filter((param) => typeof param.name === "string")
          .map((param) => ({
            name: param.name as string,
            ...(param.default !== undefined
              ? { default: param.default as string | number | boolean }
              : {}),
          }))
      : [],
    ...(isRecord(raw.health_check)
      ? {
          healthCheck: {
            ...(typeof raw.health_check.command === "string"
              ? { command: raw.health_check.command }
              : {}),
            ...(typeof raw.health_check.url === "string"
              ? { url: raw.health_check.url }
              : {}),
            ...(typeof raw.health_check.expect === "string"
              ? { expect: raw.health_check.expect }
              : {}),
            ...(typeof raw.health_check.timeout === "number"
              ? { timeout: raw.health_check.timeout }
              : {}),
          },
        }
      : {}),
  };
}

export function findAgent(
  registry: PackRegistry,
  name: string,
): AgentSpec | undefined {
  return registry.agents.find((agent) => agent.name === name);
}

export function resolvePackDependencies(
  registry: PackRegistry,
  targetName: string,
): AgentSpec[] {
  const byName = new Map(registry.agents.map((agent) => [agent.name, agent]));
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const ordered: AgentSpec[] = [];

  function visit(name: string, path: string[]): void {
    const agent = byName.get(name);
    if (agent === undefined) {
      throw new Error(`missing lowkey dependency: ${name}`);
    }
    if (visited.has(name)) return;
    if (visiting.has(name)) {
      throw new Error(
        `lowkey dependency cycle: ${[...path, name].join(" -> ")}`,
      );
    }

    visiting.add(name);
    for (const dependency of agent.dependencies) {
      visit(dependency, [...path, name]);
    }
    visiting.delete(name);
    visited.add(name);
    ordered.push(agent);
  }

  visit(targetName, []);
  return ordered;
}

export function buildLowkeyInstallPlan(
  registry: PackRegistry,
  targetName: string,
  options: { lowkeyDir?: string } = {},
): LowkeyInstallPlan {
  const installOrder = resolvePackDependencies(registry, targetName);
  const lowkeyDir = options.lowkeyDir ?? "/opt/lowkey";
  const target = installOrder.at(-1);
  if (target === undefined) {
    throw new Error(`missing lowkey pack: ${targetName}`);
  }
  return {
    target,
    installOrder,
    steps: installOrder.map((pack) => ({
      pack,
      command: {
        command: [
          "bash",
          "-lc",
          `cd ${shellQuote(lowkeyDir)} && ./packs/${shellQuote(pack.name)}/install.sh`,
        ],
        env: {},
      },
    })),
  };
}

export function buildLowkeyStartPlan(
  registry: PackRegistry,
  targetName: string,
  options: { lowkeyDir?: string; manifest?: LowkeyPackManifest } = {},
): LowkeyStartPlan {
  const target = findAgent(registry, targetName);
  if (target === undefined) {
    throw new Error(`missing lowkey pack: ${targetName}`);
  }
  if (options.manifest !== undefined && options.manifest.name !== target.name) {
    throw new Error(
      `lowkey manifest name ${options.manifest.name} does not match ${target.name}`,
    );
  }
  const healthCommand = healthCheckCommand(options.manifest);
  if (healthCommand !== undefined) {
    return {
      target,
      command: healthCommand,
      source: "manifest-health-check",
    };
  }
  const lowkeyDir = options.lowkeyDir ?? "/opt/lowkey";
  return {
    target,
    command: {
      command: [
        "bash",
        "-lc",
        `cd ${shellQuote(lowkeyDir)} && ./packs/${shellQuote(target.name)}/start.sh`,
      ],
      env: {},
    },
    source: "legacy-start-script",
  };
}

export async function runLowkeyInstallPlan(
  input: RunLowkeyInstallPlanInput,
): Promise<RunLowkeyInstallPlanResult> {
  const installed: string[] = [];
  for (const step of input.plan.steps) {
    const exitCode = await runProviderCommand(input.provider, input.sandbox, {
      ...step.command,
      env: { ...step.command.env, ...(input.environment ?? {}) },
    });
    if (exitCode !== 0) {
      throw new TinyAgentError(
        "LOWKEY_INSTALL_FAILED",
        `lowkey install failed for ${step.pack.name} with exit code ${exitCode}`,
        { pack: step.pack.name, exitCode },
      );
    }
    installed.push(step.pack.name);
  }
  return { installed };
}

export async function runLowkeyStartPlan(
  input: RunLowkeyStartPlanInput,
): Promise<RunLowkeyStartPlanResult> {
  const exitCode = await runProviderCommand(input.provider, input.sandbox, {
    ...input.plan.command,
    env: { ...input.plan.command.env, ...(input.environment ?? {}) },
  });
  if (exitCode !== 0) {
    throw new TinyAgentError(
      "LOWKEY_START_FAILED",
      `lowkey start failed for ${input.plan.target.name} with exit code ${exitCode}`,
      { pack: input.plan.target.name, exitCode },
    );
  }
  return { started: input.plan.target.name };
}

export async function writeLokiPackConfig(
  input: LokiPackConfigInput,
): Promise<string> {
  const path = input.configPath ?? "/tmp/loki-pack-config.json";
  const config = {
    pack: input.agent.name,
    name: input.name,
    dependencies: input.agent.dependencies,
    ports: Object.fromEntries(
      input.agent.ports.map((port) => [port.name, port.port]),
    ),
    stateDirs: input.agent.stateDirs,
    ...(input.modelMode !== undefined ? { modelMode: input.modelMode } : {}),
    ...(input.stateDir !== undefined ? { stateDir: input.stateDir } : {}),
    ...(input.gatewayPort !== undefined
      ? { gatewayPort: input.gatewayPort }
      : {}),
  };
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(config, null, 2)}\n`, {
    mode: 0o600,
  });
  await chmod(path, 0o600);
  return path;
}

export async function writeSecretTargets(
  input: PreparedSecretInput,
): Promise<PreparedSecrets> {
  const environment: Record<string, string> = {};
  const files: PreparedSecrets["files"] = [];

  for (const target of input.agent.secretTargets) {
    const secret = input.secrets[target.name];
    if (secret === undefined) {
      throw new Error(`missing secret: ${target.name}`);
    }
    if (target.env !== undefined) {
      environment[target.env] = Buffer.from(secret).toString("utf8");
    }
    if (target.file !== undefined) {
      const path = secretTargetPath(target, input.homeDir);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, secret, { mode: parseMode(target.mode) });
      await chmod(path, parseMode(target.mode));
      files.push({ name: target.name, path, mode: target.mode });
    }
  }

  return { environment, files };
}

function normalizePack(name: string, pack: LowkeyPack): AgentSpec {
  const caveats: string[] = [];
  if (pack.experimental) caveats.push("experimental");
  if (pack.requires_docker) caveats.push("requires nested Docker");
  if (pack.requires_postgres) caveats.push("requires PostgreSQL");
  if (pack.requires_systemd) caveats.push("requires systemd");
  if (pack.interactive_only) caveats.push("interactive CLI only");
  if (pack.requires_openai_key) caveats.push("requires OpenAI API key");
  if (pack.requires_telegram_token) caveats.push("requires Telegram bot token");
  if (name === "kiro-cli")
    caveats.push("requires Kiro API key for headless mode");
  if (name === "ironclaw")
    caveats.push("routes Bedrock through bedrockify OpenAI-compatible backend");
  if (pack.compatible_profiles?.length)
    caveats.push(`compatible profiles: ${pack.compatible_profiles.join(", ")}`);

  const modelModes = new Set<string>();
  if (pack.default_model) modelModes.add(pack.default_model);
  if (pack.deps?.includes("bedrockify"))
    modelModes.add("openai-compatible-proxy");
  if (name === "openclaw") modelModes.add("api-key");

  return AgentSpecSchema.parse({
    name,
    version: "lowkey",
    dependencies: pack.deps ?? [],
    ports: normalizePorts(pack.ports ?? {}),
    stateDirs: inferStateDirs(name, pack),
    dataVolumeGb: pack.data_volume_gb,
    modelModes: [...modelModes],
    secretTargets: inferSecretTargets(name, pack),
    headlessCaveats: caveats,
    brain: pack.brain ?? false,
  });
}

function assertLowkeyRegistry(value: unknown): LowkeyRegistry {
  if (
    value === null ||
    typeof value !== "object" ||
    !("packs" in value) ||
    !isRecord((value as { packs?: unknown }).packs)
  ) {
    throw new TinyAgentError(
      "LOWKEY_REGISTRY_INVALID",
      "Lowkey registry must be an object with a packs object",
      { registry: value },
    );
  }
  return value as LowkeyRegistry;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function normalizePorts(ports: Record<string, number>): PortSpec[] {
  return Object.entries(ports).map(([name, port]) => ({
    name,
    port,
    protocol: "tcp" as const,
  }));
}

function inferStateDirs(name: string, pack: LowkeyPack): string[] {
  if (name === "openclaw") return ["~/.openclaw"];
  if (name === "ironclaw") return ["postgres://ironclaw"];
  if (name === "nemoclaw") return ["~/.nemoclaw", "docker:nemoclaw"];
  if ((pack.data_volume_gb ?? 0) > 0) return [`~/.${name}`];
  return [];
}

function inferSecretTargets(
  name: string,
  pack: LowkeyPack,
): AgentSpec["secretTargets"] {
  const targets: AgentSpec["secretTargets"] = [];
  if (name === "openclaw") {
    targets.push({
      name: "ANTHROPIC_API_KEY",
      file: "~/.openclaw/openclaw.json",
      mode: "0600",
    });
  }
  if (pack.requires_openai_key || name === "codex-cli") {
    targets.push({
      name: "OPENAI_API_KEY",
      env: "OPENAI_API_KEY",
      mode: "0600",
    });
  }
  if (pack.requires_telegram_token) {
    targets.push({
      name: "TELEGRAM_TOKEN",
      file: `~/.${name}/telegram.env`,
      mode: "0600",
    });
  }
  if (name === "kiro-cli") {
    targets.push({
      name: "KIRO_API_KEY",
      env: "KIRO_API_KEY",
      mode: "0600",
    });
  }
  return targets;
}

function inferFormat(input: string): "json" | "yaml" {
  return input.trimStart().startsWith("{") ? "json" : "yaml";
}

function secretTargetPath(target: SecretTarget, homeDir: string): string {
  if (target.file === undefined) {
    throw new Error(`secret target has no file path: ${target.name}`);
  }
  if (target.file === "~") return homeDir;
  if (target.file.startsWith("~/")) {
    return join(homeDir, target.file.slice(2));
  }
  if (isAbsolute(target.file)) return target.file;

  const path = normalize(join(homeDir, target.file));
  const root = normalize(homeDir);
  if (path !== root && !path.startsWith(`${root}/`)) {
    throw new Error(`unsafe secret file path: ${target.file}`);
  }
  return path;
}

function parseMode(mode: string): number {
  return Number.parseInt(mode, 8);
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function healthCheckCommand(
  manifest: LowkeyPackManifest | undefined,
): ExecSpec | undefined {
  if (manifest === undefined) return undefined;
  const health = manifest.healthCheck;
  if (health === undefined) return undefined;
  const timeoutMs =
    health.timeout !== undefined ? Math.ceil(health.timeout * 1000) : undefined;
  if (health.command !== undefined) {
    return {
      command: ["bash", "-lc", health.command],
      env: {},
      ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    };
  }
  if (health.url !== undefined) {
    const url = substituteManifestDefaults(health.url, manifest);
    const command =
      health.expect === undefined
        ? `curl -fsSL ${shellQuote(url)} >/dev/null`
        : `curl -fsSL ${shellQuote(url)} | grep -F -- ${shellQuote(
            health.expect,
          )} >/dev/null`;
    return {
      command: ["bash", "-lc", command],
      env: {},
      ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    };
  }
  return undefined;
}

function substituteManifestDefaults(
  value: string,
  manifest: LowkeyPackManifest,
): string {
  let out = value;
  for (const param of manifest.params) {
    if (param.default === undefined) continue;
    out = out.replaceAll(`\${${param.name}}`, String(param.default));
  }
  return out;
}

async function runProviderCommand(
  provider: ComputeProvider,
  sandbox: Sandbox,
  command: ExecSpec,
): Promise<number> {
  let exitCode = 0;
  for await (const chunk of provider.exec(sandbox, command)) {
    if (chunk.stream === "exit") exitCode = chunk.exitCode ?? 0;
  }
  return exitCode;
}
