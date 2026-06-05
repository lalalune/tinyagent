#!/usr/bin/env node
import { randomBytes as nodeRandomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { appendFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  createDcapQvlVerifier,
  createPhalaVerifier,
  verifyAttestation,
} from "@tinyagent/attest";
import type { AttestationPolicy, AttestationVerdict } from "@tinyagent/attest";
import {
  backupDirectory,
  gcBackups,
  restoreDirectory,
} from "@tinyagent/backup";
import {
  type AgentSpec,
  type AttestationDoc,
  AttestationDocSchema,
  type BackupdCommand,
  BackupdCommandSchema,
  BackupdStatusSchema,
  BackupManifestSchema,
  SandboxSpecSchema,
  TinyAgentError,
  type Sandbox,
  backupKvPaths,
  redactObject,
  redactText,
  redactValue,
  type SandboxSpec,
  tinyagentKvPath,
} from "@tinyagent/core";
import {
  BACKUP_MESSAGE_PREFIX,
  deriveBackupKeypair,
  encodeBackupPublicKey,
} from "@tinyagent/crypto";
import {
  buildLowkeyInstallPlan,
  buildLowkeyStartPlan,
  findAgent,
  parseLowkeyManifestText,
  parseLowkeyRegistryText,
  runLowkeyInstallPlan,
  runLowkeyStartPlan,
  type PackRegistry,
} from "@tinyagent/packrunner";
import { DockerProvider } from "@tinyagent/provider-docker";
import { PhalaCliProvider } from "@tinyagent/provider-dstack";
import { createLocalTinyCloudPlane } from "@tinyagent/tc";
import { PrivateKeySigner } from "@tinycloud/node-sdk";

export const VERSION = "0.1.0";

export async function main(argv = process.argv.slice(2)): Promise<number> {
  const json = argv.includes("--json");
  const args = argv.filter((arg) => arg !== "--json");
  const command = args[0];

  if (!command || command === "--help" || command === "-h") {
    console.log(
      "tinyagent commands: init secrets agents deploy status backup restore recover attest preflight tunnel",
    );
    return 0;
  }

  if (command === "--version" || command === "-V" || command === "version") {
    console.log(VERSION);
    return 0;
  }

  if (command === "derive-backup-key") {
    return catchCommand(
      () => deriveBackupKeyCommand(args.slice(1), json),
      json,
    );
  }

  if (command === "agents") {
    return agentsCommand(args.slice(1), json);
  }

  if (command === "init") {
    return catchCommand(() => initCommand(args.slice(1), json), json);
  }

  if (command === "status") {
    return catchCommand(() => statusCommand(args.slice(1), json), json);
  }

  if (command === "deploy") {
    return catchCommand(() => deployCommand(args.slice(1), json), json);
  }

  if (command === "start") {
    return catchCommand(
      () => lifecycleCommand(args.slice(1), json, "running"),
      json,
    );
  }

  if (command === "stop") {
    return catchCommand(
      () => lifecycleCommand(args.slice(1), json, "stopped"),
      json,
    );
  }

  if (command === "down") {
    return catchCommand(
      () => lifecycleCommand(args.slice(1), json, "destroyed"),
      json,
    );
  }

  if (command === "rm") {
    return catchCommand(() => removeCommand(args.slice(1), json), json);
  }

  if (command === "tunnel") {
    return catchCommand(() => tunnelCommand(args.slice(1), json), json);
  }

  if (command === "chat") {
    return catchCommand(() => chatCommand(args.slice(1), json), json);
  }

  if (command === "secrets") {
    return catchCommand(() => secretsCommand(args.slice(1), json), json);
  }

  if (command === "attest") {
    return catchCommand(() => attestCommand(args.slice(1), json), json);
  }

  if (command === "preflight") {
    return catchCommand(() => preflightCommand(args.slice(1), json), json);
  }

  if (command === "backup") {
    return catchCommand(() => backupCommand(args.slice(1), json), json);
  }

  if (command === "migrate") {
    return catchCommand(() => migrateCommand(args.slice(1), json), json);
  }

  if (command === "backups") {
    return catchCommand(() => backupsCommand(args.slice(1), json), json);
  }

  if (command === "backupd") {
    return catchCommand(() => backupdCommand(args.slice(1), json), json);
  }

  if (command === "logs") {
    return catchCommand(() => logsCommand(args.slice(1), json), json);
  }

  if (command === "shell") {
    return catchCommand(() => shellCommand(args.slice(1), json), json);
  }

  if (command === "recover" || command === "restore") {
    return catchCommand(() => recoverCommand(args.slice(1), json), json);
  }

  const known = new Set(["ls"]);

  if (known.has(command)) {
    printError(
      `${command} is not implemented yet; see TINYAGENT_REMAINING_TODOS.md`,
      json,
    );
    return 2;
  }

  console.error(`Unknown command: ${command}`);
  return 1;
}

interface ProjectConfig {
  version: 1;
  agent: string;
  pack: string;
  provider: "local-docker" | "dstack-cvm" | "lightning";
  storeDir: string;
  stateDir: string;
  runnerImage: string;
  registryPath?: string;
  createdAt: string;
}

interface DeploymentState {
  version: 1;
  sandboxId: string;
  provider: ProjectConfig["provider"];
  agent: string;
  pack: string;
  status: "running" | "stopped" | "destroyed";
  ports: Array<{ name: string; remotePort: number; localPort: number }>;
  runnerSpec?: SandboxSpec;
  attestation?: StoredAttestationVerdict;
  deployedAt: string;
  updatedAt: string;
}

type StoredAttestationVerdict = Pick<
  AttestationVerdict,
  "ok" | "doc" | "errors" | "warnings" | "checks"
>;

async function initCommand(args: string[], json: boolean): Promise<number> {
  const required = requireOptions(args, ["--agent", "--pack"]);
  if (!required.ok) {
    printError(`init requires ${required.missing.join(", ")}`, json);
    return 2;
  }

  const projectDir = readOption(args, "--project-dir") ?? process.cwd();
  const configPath = projectConfigPath(projectDir);
  if (existsSync(configPath) && !args.includes("--force")) {
    printError(
      `project already initialized at ${configPath}; pass --force to overwrite`,
      json,
    );
    return 2;
  }

  const registryPath = readOption(args, "--registry");
  if (registryPath !== undefined) {
    const registry = parseLowkeyRegistryText(
      readFileSync(registryPath, "utf8"),
      {
        format:
          registryPath.endsWith(".yaml") || registryPath.endsWith(".yml")
            ? "yaml"
            : "json",
      },
    );
    const pack = required.values["--pack"]!;
    if (!findAgent(registry, pack)) {
      printError(`unknown agent pack: ${pack}`, json);
      return 1;
    }
  }

  const config: ProjectConfig = {
    version: 1,
    agent: required.values["--agent"]!,
    pack: required.values["--pack"]!,
    provider: parseProvider(readOption(args, "--provider") ?? "local-docker"),
    storeDir: readOption(args, "--store-dir") ?? join(projectDir, ".tinyagent"),
    stateDir:
      readOption(args, "--state-dir") ??
      join(projectDir, ".tinyagent", "state"),
    runnerImage: readOption(args, "--runner-image") ?? "tinyagent-runner:test",
    createdAt: new Date().toISOString(),
    ...(registryPath !== undefined ? { registryPath } : {}),
  };

  await mkdir(join(projectDir, ".tinyagent"), { recursive: true });
  await mkdir(config.storeDir, { recursive: true });
  await mkdir(config.stateDir, { recursive: true });
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, {
    mode: 0o600,
  });

  printValue({ ok: true, project: config }, json);
  return 0;
}

async function statusCommand(args: string[], json: boolean): Promise<number> {
  const projectDir = readOption(args, "--project-dir") ?? process.cwd();
  const config = readProjectConfig(projectDir);
  const deployment = readDeploymentState(projectDir);
  const plane = createLocalTinyCloudPlane({ rootDir: config.storeDir });
  const latestKey = tinyagentKvPath(config.agent, "latest");
  const latestHead = await plane.store.head(latestKey);
  if (!latestHead.ok) {
    printError(latestHead.error, json);
    return 1;
  }
  const latest =
    latestHead.value === null ? undefined : await plane.store.get(latestKey);
  if (latest !== undefined && !latest.ok) {
    printError(latest.error, json);
    return 1;
  }
  const secrets = await plane.secrets.list();
  if (!secrets.ok) {
    printError(secrets.error, json);
    return 1;
  }
  const value = {
    ok: true,
    project: config,
    sandbox:
      deployment === undefined
        ? { provider: config.provider, status: "not-deployed" }
        : {
            id: deployment.sandboxId,
            provider: deployment.provider,
            status: deployment.status,
            ports: deployment.ports,
            runnerSpec: deployment.runnerSpec,
            attestation: deployment.attestation,
            deployedAt: deployment.deployedAt,
            updatedAt: deployment.updatedAt,
          },
    backup:
      latest === undefined
        ? { latest: null }
        : { latest: new TextDecoder().decode(latest.value) },
    secrets: secrets.value,
  };

  printValue(value, json);
  return 0;
}

async function deployCommand(args: string[], json: boolean): Promise<number> {
  const projectDir = readOption(args, "--project-dir") ?? process.cwd();
  const config = readProjectConfig(projectDir);
  if (config.provider === "local-docker") {
    return deployLocalProject(projectDir, config, args, json);
  }

  if (config.provider === "dstack-cvm") {
    return deployDstackProject(projectDir, config, args, json);
  }

  printError(`${config.provider} deploy is not implemented yet`, json);
  return 2;
}

async function deployLocalProject(
  projectDir: string,
  config: ProjectConfig,
  args: string[],
  json: boolean,
): Promise<number> {
  await mkdir(config.stateDir, { recursive: true });
  if (args.includes("--execute-provider")) {
    return deployLocalDockerProject(projectDir, config, args, json);
  }

  const agent = readConfiguredAgent(config);
  for (const dir of agent?.stateDirs ?? []) {
    await mkdir(join(config.stateDir, dir.replace(/^\/+/, "")), {
      recursive: true,
    });
  }

  const now = new Date().toISOString();
  const existing = readDeploymentState(projectDir);
  const deployment: DeploymentState = {
    version: 1,
    sandboxId: existing?.sandboxId ?? `local:${config.agent}`,
    provider: config.provider,
    agent: config.agent,
    pack: config.pack,
    status: "running",
    ports: (agent?.ports ?? []).map((port) => ({
      name: port.name,
      remotePort: port.port,
      localPort: port.hostPort ?? port.port,
    })),
    ...(agent !== undefined
      ? { runnerSpec: buildLocalRunnerSpec(config, agent) }
      : {}),
    deployedAt: existing?.deployedAt ?? now,
    updatedAt: now,
  };

  await writeDeploymentState(projectDir, deployment);
  printValue({ ok: true, sandbox: deployment }, json);
  return 0;
}

async function deployLocalDockerProject(
  projectDir: string,
  config: ProjectConfig,
  args: string[],
  json: boolean,
): Promise<number> {
  const registry = readConfiguredRegistry(config);
  const agent = findAgent(registry, config.pack);
  if (agent === undefined) {
    printError(`unknown agent pack: ${config.pack}`, json);
    return 1;
  }

  for (const dir of agent.stateDirs) {
    await mkdir(join(config.stateDir, dir.replace(/^\/+/, "")), {
      recursive: true,
    });
  }

  const runnerSpec = buildLocalRunnerSpec(config, agent);
  const provider = new DockerProvider();
  const sandbox = await provider.provision(runnerSpec);
  try {
    await provider.start(sandbox);
    const environment = readRepeatedKeyValueOptions(args, "--env");
    await runLowkeyInstallPlan({
      provider,
      sandbox,
      plan: buildLowkeyInstallPlan(registry, config.pack),
      environment,
    });
    const manifest = readLowkeyManifest(config.pack);
    await runLowkeyStartPlan({
      provider,
      sandbox,
      plan: buildLowkeyStartPlan(registry, config.pack, {
        ...(manifest !== undefined ? { manifest } : {}),
      }),
      environment,
    });
  } catch (error) {
    await provider.destroy(sandbox).catch(() => undefined);
    throw error;
  }

  const now = new Date().toISOString();
  const existing = readDeploymentState(projectDir);
  const deployment: DeploymentState = {
    version: 1,
    sandboxId: sandbox.id,
    provider: config.provider,
    agent: config.agent,
    pack: config.pack,
    status: "running",
    ports: agent.ports.map((port) => ({
      name: port.name,
      remotePort: port.port,
      localPort: Number(sandbox.metadata[`port:${port.port}/tcp`] ?? port.port),
    })),
    runnerSpec,
    deployedAt: existing?.deployedAt ?? now,
    updatedAt: now,
  };

  await writeDeploymentState(projectDir, deployment);
  printValue(
    {
      ok: true,
      sandbox: deployment,
      providerExecution: {
        installed: config.pack,
        started: config.pack,
      },
    },
    json,
  );
  return 0;
}

async function deployDstackProject(
  projectDir: string,
  config: ProjectConfig,
  args: string[],
  json: boolean,
): Promise<number> {
  const registry = readConfiguredRegistry(config);
  const agent = findAgent(registry, config.pack);
  if (agent === undefined) {
    printError(`unknown agent pack: ${config.pack}`, json);
    return 1;
  }
  const verifier = createDeployDcapVerifier(args);
  if (verifier === undefined) {
    printError(
      "dstack-cvm deploy requires production attestation verification; pass --dcap-qvl or --phala-verify-url <url>",
      json,
    );
    return 2;
  }

  await mkdir(config.stateDir, { recursive: true });
  const runnerSpec = buildDstackRunnerSpec(config, agent);
  const provider = createPhalaCliProvider(args);
  const sandbox = await provider.provision(runnerSpec);
  try {
    await provider.start(sandbox);
    const environment = readRepeatedKeyValueOptions(args, "--env");
    await runLowkeyInstallPlan({
      provider,
      sandbox,
      plan: buildLowkeyInstallPlan(registry, config.pack),
      environment,
    });
    const manifest = readLowkeyManifest(config.pack);
    await runLowkeyStartPlan({
      provider,
      sandbox,
      plan: buildLowkeyStartPlan(registry, config.pack, {
        ...(manifest !== undefined ? { manifest } : {}),
      }),
      environment,
    });
    const guestKey = await provider.getAgentKey(sandbox, config.agent);
    if (guestKey.key.byteLength < 32) {
      throw new TinyAgentError(
        "DSTACK_GUEST_KEY_INVALID",
        "dstack guest key validation returned too few key bytes",
        { path: guestKey.path, bytes: guestKey.key.byteLength },
      );
    }

    const nonce = nodeRandomBytes(32);
    const attestationDoc = await provider.attest(sandbox, nonce);
    const attestation = await verifyAttestation(attestationDoc, {
      requireProductionDcap: true,
      dcapVerifier: verifier,
      ...(runnerSpec.expectedComposeHash !== undefined
        ? { expectedComposeHash: runnerSpec.expectedComposeHash }
        : {}),
      nonce: Buffer.from(nonce).toString("hex"),
    });
    if (!attestation.ok) {
      throw new Error(
        `dstack production attestation failed: ${[
          ...attestation.errors,
          ...attestation.warnings,
        ].join("; ")}`,
      );
    }

    const now = new Date().toISOString();
    const existing = readDeploymentState(projectDir);
    const deployment: DeploymentState = {
      version: 1,
      sandboxId: sandbox.id,
      provider: config.provider,
      agent: config.agent,
      pack: config.pack,
      status: "running",
      ports: agent.ports.map((port) => ({
        name: port.name,
        remotePort: port.port,
        localPort: port.hostPort ?? port.port,
      })),
      runnerSpec,
      attestation,
      deployedAt: existing?.deployedAt ?? now,
      updatedAt: now,
    };

    await writeDeploymentState(projectDir, deployment);
    printValue(
      {
        ok: true,
        sandbox: deployment,
        providerExecution: {
          provider: "dstack-cvm",
          installed: config.pack,
          started: config.pack,
          attested: true,
          guestKeyPath: guestKey.path,
        },
      },
      json,
    );
    return 0;
  } catch (error) {
    await provider.destroy(sandbox).catch(() => undefined);
    throw error;
  }
}

async function lifecycleCommand(
  args: string[],
  json: boolean,
  status: DeploymentState["status"],
): Promise<number> {
  const projectDir = readOption(args, "--project-dir") ?? process.cwd();
  const deployment = readDeploymentState(projectDir);
  if (deployment === undefined || deployment.status === "destroyed") {
    printError("project is not deployed", json);
    return 1;
  }

  if (
    deployment.provider === "local-docker" &&
    isRealDockerDeployment(deployment)
  ) {
    const provider = new DockerProvider();
    const sandbox = sandboxFromDeployment(deployment);
    if (status === "running") await provider.start(sandbox);
    else if (status === "stopped") await provider.stop(sandbox);
    else await provider.destroy(sandbox);
  }
  if (
    deployment.provider === "dstack-cvm" &&
    isRealDstackDeployment(deployment)
  ) {
    const provider = createPhalaCliProvider(args);
    const sandbox = sandboxFromDeployment(deployment);
    if (status === "running") await provider.start(sandbox);
    else if (status === "stopped") await provider.stop(sandbox);
    else await provider.destroy(sandbox);
  }

  const updated = {
    ...deployment,
    status,
    updatedAt: new Date().toISOString(),
  };
  await writeDeploymentState(projectDir, updated);
  printValue({ ok: true, sandbox: updated }, json);
  return 0;
}

async function removeCommand(args: string[], json: boolean): Promise<number> {
  const projectDir = readOption(args, "--project-dir") ?? process.cwd();
  const deployment = readDeploymentState(projectDir);
  if (deployment === undefined) {
    printValue({ ok: true, removed: false }, json);
    return 0;
  }

  if (
    deployment.provider === "local-docker" &&
    deployment.status !== "destroyed" &&
    isRealDockerDeployment(deployment)
  ) {
    await new DockerProvider()
      .destroy(sandboxFromDeployment(deployment))
      .catch(() => undefined);
  }
  if (
    deployment.provider === "dstack-cvm" &&
    deployment.status !== "destroyed" &&
    isRealDstackDeployment(deployment)
  ) {
    await createPhalaCliProvider(args)
      .destroy(sandboxFromDeployment(deployment))
      .catch(() => undefined);
  }

  await rm(deploymentPath(projectDir), { force: true });
  printValue({ ok: true, removed: true, sandbox: deployment }, json);
  return 0;
}

async function tunnelCommand(args: string[], json: boolean): Promise<number> {
  const projectDir = readOption(args, "--project-dir") ?? process.cwd();
  const deployment = readDeploymentState(projectDir);
  if (deployment === undefined || deployment.status !== "running") {
    printError("tunnel requires a running deployment", json);
    return 1;
  }
  if (
    deployment.provider === "dstack-cvm" &&
    deployment.attestation?.ok !== true
  ) {
    printError("dstack tunnel requires a successful attestation verdict", json);
    return 1;
  }

  const requested = readOption(args, "--port");
  const port =
    requested === undefined
      ? deployment.ports[0]
      : deployment.ports.find(
          (candidate) =>
            candidate.name === requested ||
            String(candidate.remotePort) === requested,
        );
  if (port === undefined) {
    printError("deployment has no matching port", json);
    return 1;
  }

  printValue(
    {
      ok: true,
      tunnel: {
        id: `${deployment.sandboxId}:${port.remotePort}`,
        localPort: port.localPort,
        remotePort: port.remotePort,
        portName: port.name,
      },
    },
    json,
  );
  return 0;
}

async function chatCommand(args: string[], json: boolean): Promise<number> {
  const projectDir = readOption(args, "--project-dir") ?? process.cwd();
  const message = readOption(args, "--message") ?? positionalMessage(args);
  if (message === undefined || message.length === 0) {
    printError("chat requires --message <text> or positional text", json);
    return 2;
  }

  const endpoint = resolveChatEndpoint(projectDir, args);
  if (!endpoint.ok) {
    printError(endpoint.error, json);
    return 1;
  }

  const model = readOption(args, "--model") ?? "default";
  const body = {
    model,
    messages: [{ role: "user", content: message }],
  };
  const token =
    readOption(args, "--token") ?? process.env.TINYAGENT_GATEWAY_TOKEN;
  const response = await fetch(endpoint.url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token !== undefined ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
  const responseText = await response.text();
  if (!response.ok) {
    printError(
      `chat gateway returned HTTP ${response.status}: ${responseText}`,
      json,
    );
    return 1;
  }

  const parsed = parseJsonObject(responseText);
  const content = extractChatContent(parsed);
  if (content === undefined) {
    printError("chat gateway response did not contain message content", json);
    return 1;
  }

  if (json) {
    printValue(
      {
        ok: true,
        endpoint: endpoint.url,
        model,
        message,
        response: content,
        raw: parsed,
      },
      true,
    );
  } else {
    console.log(content);
  }
  return 0;
}

async function logsCommand(args: string[], json: boolean): Promise<number> {
  const projectDir = readOption(args, "--project-dir") ?? process.cwd();
  const config = readProjectConfig(projectDir);
  const path = logPath(config);
  const tail = Number.parseInt(readOption(args, "--tail") ?? "200", 10);
  const text = existsSync(path) ? await readFile(path, "utf8") : "";
  const lines = text.length === 0 ? [] : text.trimEnd().split("\n");
  const selected =
    Number.isFinite(tail) && tail > 0 ? lines.slice(-tail) : lines;

  if (json) {
    printValue({ ok: true, path, lines: selected }, true);
  } else {
    console.log(selected.join("\n"));
  }
  return 0;
}

async function shellCommand(args: string[], json: boolean): Promise<number> {
  const projectDir = readOption(args, "--project-dir") ?? process.cwd();
  const separator = args.indexOf("--");
  if (separator < 0 || separator === args.length - 1) {
    printError("shell requires a command after --", json);
    return 2;
  }
  const command = args.slice(separator + 1);

  const config = readProjectConfig(projectDir);
  await mkdir(config.stateDir, { recursive: true });
  const result = await runLocalCommand(command, config.stateDir);
  await appendShellLog(config, command, result);

  const value = {
    ok: result.exitCode === 0,
    command,
    cwd: config.stateDir,
    exitCode: result.exitCode,
    stdout: result.stdout,
    stderr: result.stderr,
  };
  printValue(value, json);
  return result.exitCode === 0 ? 0 : 1;
}

async function secretsCommand(args: string[], json: boolean): Promise<number> {
  const subcommand = args[0] ?? "list";
  const storeDir = readOption(args, "--store-dir");
  if (storeDir === undefined) {
    printError("secrets requires --store-dir <dir>", json);
    return 2;
  }

  const plane = createLocalTinyCloudPlane({ rootDir: storeDir });
  if (subcommand === "list") {
    const result = await plane.secrets.list();
    if (!result.ok) {
      printError(result.error, json);
      return 1;
    }
    printValue({ ok: true, secrets: result.value }, json);
    return 0;
  }

  const name = args[1];
  if (name === undefined) {
    printError(`secrets ${subcommand} requires a secret name`, json);
    return 2;
  }

  if (subcommand === "set") {
    const value = await readSecretValue(args);
    if (!value.ok) {
      printError(value.error, json);
      return 2;
    }
    const result = await plane.secrets.set(name, value.bytes);
    if (!result.ok) {
      printError(result.error, json);
      return 1;
    }
    printValue({ ok: true, name }, json);
    return 0;
  }

  if (subcommand === "get") {
    const result = await plane.secrets.get(name);
    if (!result.ok) {
      printError(result.error, json);
      return 1;
    }
    if (json) {
      printValue(
        {
          ok: true,
          name,
          valueHex: Buffer.from(result.value).toString("hex"),
        },
        true,
      );
    } else {
      console.log(Buffer.from(result.value).toString("utf8"));
    }
    return 0;
  }

  if (subcommand === "delete" || subcommand === "rm") {
    const result = await plane.secrets.delete(name);
    if (!result.ok) {
      printError(result.error, json);
      return 1;
    }
    printValue({ ok: true, name }, json);
    return 0;
  }

  printError(`unknown secrets subcommand: ${subcommand}`, json);
  return 1;
}

async function readSecretValue(
  args: string[],
): Promise<{ ok: true; bytes: Uint8Array } | { ok: false; error: string }> {
  const value = readOption(args, "--value");
  const valueHex = readOption(args, "--value-hex");
  const file = readOption(args, "--file");
  const provided = [value, valueHex, file].filter(
    (item) => item !== undefined,
  ).length;
  if (provided !== 1) {
    return {
      ok: false,
      error:
        "secrets set requires exactly one of --value, --value-hex, or --file",
    };
  }

  if (value !== undefined) {
    return { ok: true, bytes: new TextEncoder().encode(value) };
  }
  if (valueHex !== undefined) {
    if (!isHex(valueHex)) {
      return { ok: false, error: "--value-hex must be even-length hex" };
    }
    return { ok: true, bytes: new Uint8Array(Buffer.from(valueHex, "hex")) };
  }
  if (file !== undefined) {
    return { ok: true, bytes: new Uint8Array(await readFile(file)) };
  }
  return { ok: false, error: "missing secret value" };
}

async function backupCommand(args: string[], json: boolean): Promise<number> {
  const input = resolveBackupInput(args);
  if (!input.ok) {
    printError(`backup requires ${input.missing.join(", ")}`, json);
    return 2;
  }
  const signature = await resolveBackupSignature(input.space, args);
  if (!signature.ok) {
    printError(signature.error, json);
    return 2;
  }

  const keypair = await deriveBackupKeypair(input.space, signature.bytes);
  const plane = createLocalTinyCloudPlane({
    rootDir: input.storeDir,
  });
  const result = await backupDirectory({
    store: plane.store,
    agent: input.agent,
    pack: input.pack,
    stateDir: input.stateDir,
    bpkId: keypair.publicKeyId,
    backupPublicKey: keypair.publicKey,
  });

  if (!result.ok) {
    printError(result.error, json);
    return 1;
  }

  printValue(
    {
      ok: true,
      agent: result.value.agent,
      pack: result.value.pack,
      timestamp: result.value.timestamp,
      chunks: result.value.chunks.length,
      backupPublicKeyId: result.value.backupPublicKeyId,
    },
    json,
  );
  return 0;
}

async function backupsCommand(args: string[], json: boolean): Promise<number> {
  const subcommand = args[0] ?? "list";
  if (subcommand !== "list" && subcommand !== "gc") {
    printError(`unknown backups subcommand: ${subcommand}`, json);
    return 1;
  }

  const target = resolveLocalAgentStore(args);
  if (!target.ok) {
    printError(target.error, json);
    return 2;
  }

  const plane = createLocalTinyCloudPlane({ rootDir: target.storeDir });
  if (subcommand === "gc") {
    const keepLast = Number.parseInt(
      readOption(args, "--keep-last") ?? "3",
      10,
    );
    const maxBytesOption = readOption(args, "--max-bytes");
    const maxBytes =
      maxBytesOption === undefined
        ? undefined
        : Number.parseInt(maxBytesOption, 10);
    const result = await gcBackups({
      store: plane.store,
      agent: target.agent,
      keepLast,
      ...(maxBytes !== undefined ? { maxBytes } : {}),
    });
    if (!result.ok) {
      printError(result.error, json);
      return 1;
    }
    printValue({ ok: true, agent: target.agent, ...result.value }, json);
    return 0;
  }

  const paths = backupKvPaths(target.agent);
  const latest = await plane.store.get(paths.latest);
  const latestVersion = latest.ok
    ? new TextDecoder().decode(latest.value)
    : undefined;
  const listed = await plane.store.list(paths.snapshotsPrefix);
  if (!listed.ok) {
    printError(listed.error, json);
    return 1;
  }

  const backups = await Promise.all(
    listed.value
      .filter((entry) => entry.key.endsWith(".manifest"))
      .map(async (entry) => {
        const manifestBytes = await plane.store.get(entry.key);
        if (!manifestBytes.ok) throw manifestBytes.error;
        const manifest = BackupManifestSchema.parse(
          JSON.parse(new TextDecoder().decode(manifestBytes.value)),
        );
        const version = entry.key.slice(paths.snapshotsPrefix.length);
        return {
          version,
          timestamp: manifest.timestamp,
          pack: manifest.pack,
          chunks: manifest.chunks.length,
          totalPlaintextBytes: manifest.integrity.totalPlaintextBytes ?? null,
          runnerImageDigest: manifest.runnerImageDigest,
          latest: version === latestVersion,
        };
      }),
  );
  backups.sort((a, b) => b.timestamp.localeCompare(a.timestamp));

  printValue(
    {
      ok: true,
      agent: target.agent,
      latest: latestVersion ?? null,
      backups,
    },
    json,
  );
  return 0;
}

async function backupdCommand(args: string[], json: boolean): Promise<number> {
  const subcommand = args[0] ?? "status";
  const url = readOption(args, "--url");
  if (url === undefined) {
    printError("backupd requires --url <loopback-or-tunnel-url>", json);
    return 2;
  }

  if (subcommand === "status") {
    const result = await fetchBackupdJson(`${trimTrailingSlash(url)}/status`, {
      method: "GET",
    });
    if (!result.ok) {
      printError(result.error, json);
      return 1;
    }
    printValue(result.value, json);
    return 0;
  }

  const command = backupdControlCommand(subcommand, args);
  if (!command.ok) {
    printError(command.error, json);
    return 2;
  }

  const result = await fetchBackupdJson(`${trimTrailingSlash(url)}/control`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(command.value),
  });
  if (!result.ok) {
    printError(result.error, json);
    return 1;
  }
  printValue(result.value, json);
  return 0;
}

function backupdControlCommand(
  subcommand: string,
  args: string[],
): { ok: true; value: BackupdCommand } | { ok: false; error: string } {
  const raw =
    subcommand === "backup-now"
      ? { type: "backupNow" }
      : subcommand === "prepare-restore"
        ? { type: "prepareRestore", version: readOption(args, "--version") }
        : subcommand === "renew-delegation"
          ? { type: "renewDelegation" }
          : undefined;
  if (raw === undefined) {
    return {
      ok: false,
      error:
        "unknown backupd subcommand; expected status, backup-now, prepare-restore, or renew-delegation",
    };
  }
  const parsed = BackupdCommandSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      error:
        subcommand === "prepare-restore"
          ? "backupd prepare-restore requires --version <snapshot-version>"
          : "invalid backupd command",
    };
  }
  return { ok: true, value: parsed.data };
}

async function fetchBackupdJson(
  url: string,
  init: RequestInit,
): Promise<{ ok: true; value: unknown } | { ok: false; error: string }> {
  let response: Response;
  try {
    response = await fetch(url, init);
  } catch (error) {
    return {
      ok: false,
      error: `backupd request failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return { ok: false, error: "backupd returned a non-JSON response" };
  }
  if (!response.ok) {
    const message =
      typeof body === "object" &&
      body !== null &&
      "error" in body &&
      typeof body.error === "string"
        ? body.error
        : `backupd returned HTTP ${response.status}`;
    return { ok: false, error: message };
  }
  if (typeof body !== "object" || body === null) {
    return { ok: false, error: "backupd response must be a JSON object" };
  }
  const record = body as Record<string, unknown>;
  if (record.ok !== true) {
    return {
      ok: false,
      error:
        typeof record.error === "string"
          ? record.error
          : "backupd response did not report success",
    };
  }
  const status = BackupdStatusSchema.safeParse(record.status);
  if (!status.success) {
    return {
      ok: false,
      error: "backupd response did not contain a valid status",
    };
  }
  return { ok: true, value: { ok: true, status: status.data } };
}

async function recoverCommand(args: string[], json: boolean): Promise<number> {
  const input = resolveRecoverInput(args);
  if (!input.ok) {
    printError(`recover requires ${input.missing.join(", ")}`, json);
    return 2;
  }
  const signature = await resolveBackupSignature(input.space, args);
  if (!signature.ok) {
    printError(signature.error, json);
    return 2;
  }

  const keypair = await deriveBackupKeypair(input.space, signature.bytes);
  const plane = createLocalTinyCloudPlane({
    rootDir: input.storeDir,
  });
  const version = readOption(args, "--version");
  const result = await restoreDirectory({
    store: plane.store,
    agent: input.agent,
    targetDir: input.targetDir,
    backupPublicKey: keypair.publicKey,
    backupPrivateKey: keypair.privateKey,
    ...(version !== undefined ? { version } : {}),
  });

  if (!result.ok) {
    printError(result.error, json);
    return 1;
  }

  printValue(
    {
      ok: true,
      agent: result.value.agent,
      pack: result.value.pack,
      timestamp: result.value.timestamp,
      targetDir: input.targetDir,
    },
    json,
  );
  return 0;
}

async function migrateCommand(args: string[], json: boolean): Promise<number> {
  const projectDir = readOption(args, "--project-dir") ?? process.cwd();
  const sourceDir = readOption(args, "--source-dir");
  const space = readOption(args, "--space");
  if (sourceDir === undefined || space === undefined) {
    const missing = [
      ...(sourceDir === undefined ? ["--source-dir"] : []),
      ...(space === undefined ? ["--space"] : []),
    ];
    printError(`migrate requires ${missing.join(", ")}`, json);
    return 2;
  }
  const signature = await resolveBackupSignature(space, args);
  if (!signature.ok) {
    printError(signature.error, json);
    return 2;
  }

  const config = readProjectConfig(projectDir);
  const keypair = await deriveBackupKeypair(space, signature.bytes);
  const plane = createLocalTinyCloudPlane({ rootDir: config.storeDir });
  const backup = await backupDirectory({
    store: plane.store,
    agent: config.agent,
    pack: config.pack,
    stateDir: sourceDir,
    bpkId: keypair.publicKeyId,
    backupPublicKey: keypair.publicKey,
  });
  if (!backup.ok) {
    printError(backup.error, json);
    return 1;
  }

  const restore = await restoreDirectory({
    store: plane.store,
    agent: config.agent,
    targetDir: config.stateDir,
    backupPublicKey: keypair.publicKey,
    backupPrivateKey: keypair.privateKey,
  });
  if (!restore.ok) {
    printError(restore.error, json);
    return 1;
  }

  printValue(
    {
      ok: true,
      agent: config.agent,
      pack: config.pack,
      sourceDir,
      targetDir: config.stateDir,
      timestamp: restore.value.timestamp,
      chunks: backup.value.chunks.length,
      backupPublicKeyId: backup.value.backupPublicKeyId,
    },
    json,
  );
  return 0;
}

async function attestCommand(args: string[], json: boolean): Promise<number> {
  const subcommand = args[0] ?? "verify";
  if (subcommand !== "verify") {
    printError(`unknown attest subcommand: ${subcommand}`, json);
    return 1;
  }

  const docInput = resolveAttestDocInput(args);
  if (!docInput.ok) {
    printError(docInput.error, json);
    return 2;
  }

  const expectedComposeHash = resolveAttestExpectedComposeHash(args);
  if (!expectedComposeHash.ok) {
    printError(expectedComposeHash.error, json);
    return 2;
  }
  const nonce = readOption(args, "--nonce");
  const phalaVerifyUrl = readOption(args, "--phala-verify-url");
  const policy: AttestationPolicy = {
    requireProductionDcap:
      args.includes("--require-production-dcap") ||
      args.includes("--dcap-qvl") ||
      phalaVerifyUrl !== undefined,
    ...(expectedComposeHash.value !== undefined
      ? { expectedComposeHash: expectedComposeHash.value }
      : {}),
    ...(nonce !== undefined ? { nonce } : {}),
    ...(args.includes("--dcap-qvl")
      ? { dcapVerifier: createDcapQvlVerifier() }
      : phalaVerifyUrl !== undefined
        ? { dcapVerifier: createPhalaVerifier({ endpoint: phalaVerifyUrl }) }
        : {}),
  };

  const verdict = await verifyAttestation(docInput.value, policy);

  printValue(verdict, json);
  return verdict.ok ? 0 : 1;
}

async function preflightCommand(
  args: string[],
  json: boolean,
): Promise<number> {
  const target = args[0] ?? "dstack";
  if (target !== "dstack" && target !== "dstack-cvm") {
    printError(`unknown preflight target: ${target}`, json);
    return 2;
  }

  const phalaCommand = resolvePhalaCommand(args);
  const phalaBin = phalaCommand[0]!;
  const formattedPhalaCommand = phalaCommand.join(" ");
  const help = await runLocalCommand(
    [...phalaCommand, "--help"],
    process.cwd(),
    {
      timeoutMs: 60_000,
    },
  );
  const hasDeploy = help.stdout.includes("deploy");
  const hasCvms = help.stdout.includes("cvms");
  if (help.exitCode !== 0 || !hasDeploy || !hasCvms) {
    printError(
      new TinyAgentError(
        "DSTACK_PREFLIGHT_PHALA_CLI_INVALID",
        `${formattedPhalaCommand} does not expose the expected Phala deploy/cvms command surface`,
        {
          phalaBin,
          phalaCommand,
          exitCode: help.exitCode,
          stdout: help.stdout,
          stderr: help.stderr,
        },
      ),
      json,
    );
    return 1;
  }

  const auth = await runLocalCommand(
    [...phalaCommand, "whoami", "--json"],
    process.cwd(),
    { timeoutMs: 60_000 },
  );
  if (auth.exitCode !== 0) {
    printError(
      new TinyAgentError(
        "DSTACK_PREFLIGHT_PHALA_AUTH_FAILED",
        `${formattedPhalaCommand} is not authenticated; run phala login or set PHALA_CLOUD_API_KEY`,
        {
          phalaBin,
          phalaCommand,
          exitCode: auth.exitCode,
          stdout: auth.stdout,
          stderr: auth.stderr,
        },
      ),
      json,
    );
    return 1;
  }

  const verifier =
    readOption(args, "--phala-verify-url") !== undefined ||
    args.includes("--dcap-qvl");
  if (!verifier) {
    printError(
      new TinyAgentError(
        "DSTACK_PREFLIGHT_VERIFIER_MISSING",
        "dstack-cvm deploy requires production attestation verification; pass --dcap-qvl or --phala-verify-url <url>",
      ),
      json,
    );
    return 2;
  }

  const runnerComposeHash = readRunnerComposeHash();
  if (runnerComposeHash === undefined) {
    printError(
      new TinyAgentError(
        "DSTACK_PREFLIGHT_RUNNER_COMPOSE_MISSING",
        "runner/app-compose.sha256 was not found",
      ),
      json,
    );
    return 1;
  }

  printValue(
    {
      ok: true,
      preflight: {
        target: "dstack-cvm",
        phalaBin,
        phalaCommand,
        commandSurface: { deploy: true, cvms: true },
        authenticated: true,
        productionVerifierConfigured: true,
        runnerComposeHash,
      },
    },
    json,
  );
  return 0;
}

function resolveAttestDocInput(
  args: string[],
): { ok: true; value: AttestationDoc } | { ok: false; error: string } {
  const docPath = readOption(args, "--doc");
  const useDeployment = args.includes("--deployment");
  if (docPath !== undefined && useDeployment) {
    return {
      ok: false,
      error: "attest verify accepts only one of --doc or --deployment",
    };
  }
  if (docPath !== undefined) {
    return {
      ok: true,
      value: AttestationDocSchema.parse(
        JSON.parse(readFileSync(docPath, "utf8")),
      ),
    };
  }
  if (!useDeployment) {
    return {
      ok: false,
      error: "attest verify requires --doc <path> or --deployment",
    };
  }

  const projectDir = readOption(args, "--project-dir") ?? process.cwd();
  const deployment = readDeploymentState(projectDir);
  if (deployment === undefined || deployment.attestation === undefined) {
    return {
      ok: false,
      error: "project deployment does not contain an attestation",
    };
  }
  return { ok: true, value: deployment.attestation.doc };
}

function resolveAttestExpectedComposeHash(
  args: string[],
): { ok: true; value?: string } | { ok: false; error: string } {
  const explicit = readOption(args, "--expected-compose-hash");
  if (explicit !== undefined && args.includes("--expected-runner-compose")) {
    return {
      ok: false,
      error:
        "attest verify accepts only one of --expected-compose-hash or --expected-runner-compose",
    };
  }
  if (explicit !== undefined) return { ok: true, value: explicit };
  if (!args.includes("--expected-runner-compose")) return { ok: true };

  const runnerComposeHash = readRunnerComposeHash();
  if (runnerComposeHash === undefined) {
    return {
      ok: false,
      error: "runner/app-compose.sha256 was not found",
    };
  }
  return { ok: true, value: runnerComposeHash };
}

async function deriveBackupKeyCommand(
  args: string[],
  json: boolean,
): Promise<number> {
  const space = readOption(args, "--space");
  if (!space) {
    printError("derive-backup-key requires --space", json);
    return 2;
  }
  const signature = await resolveBackupSignature(space, args);
  if (!signature.ok) {
    printError(signature.error, json);
    return 2;
  }
  const keypair = await deriveBackupKeypair(space, signature.bytes);
  printValue(encodeBackupPublicKey(keypair), json);
  return 0;
}

function agentsCommand(args: string[], json: boolean): number {
  const subcommand = args[0] ?? "list";
  const registryPath = readOption(args, "--registry") ?? defaultRegistryPath();
  if (!registryPath) {
    printError(
      "agents requires --registry <path> when no default registry fixture is available",
      json,
    );
    return 2;
  }

  try {
    const text = readFileSync(registryPath, "utf8");
    const registry = parseLowkeyRegistryText(text, {
      format:
        registryPath.endsWith(".yaml") || registryPath.endsWith(".yml")
          ? "yaml"
          : "json",
    });

    if (subcommand === "list") {
      const agents = registry.agents.map((agent) => ({
        name: agent.name,
        deps: agent.dependencies,
        ports: agent.ports,
        stateDirs: agent.stateDirs,
        brain: agent.brain,
        caveats: agent.headlessCaveats,
      }));
      if (json) {
        printValue({ lowkeyRef: registry.lowkeyRef, agents }, true);
      } else {
        for (const agent of agents) {
          console.log(
            `${agent.name}\tdeps=${agent.deps.join(",") || "-"}\tports=${
              agent.ports
                .map((port) => `${port.name}:${port.port}`)
                .join(",") || "-"
            }`,
          );
        }
      }
      return 0;
    }

    if (subcommand === "info") {
      const name = args[1];
      if (!name) {
        printError("agents info requires a pack name", json);
        return 2;
      }
      const agent = findAgent(registry, name);
      if (!agent) {
        printError(`unknown agent pack: ${name}`, json);
        return 1;
      }
      printValue(agent, json);
      return 0;
    }

    printError(`unknown agents subcommand: ${subcommand}`, json);
    return 1;
  } catch (error) {
    printError(error, json);
    return 1;
  }
}

function readOption(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index < 0 || index === args.length - 1) return undefined;
  const value = args[index + 1];
  return value?.startsWith("--") ? undefined : value;
}

function resolvePhalaCommand(args: string[]): string[] {
  const commandText =
    readOption(args, "--phala-command") ?? process.env.TINYAGENT_PHALA_COMMAND;
  if (commandText !== undefined) return parseCommandWords(commandText);
  return [
    readOption(args, "--phala-bin") ??
      process.env.TINYAGENT_PHALA_BIN ??
      "phala",
  ];
}

function parseCommandWords(input: string): string[] {
  const words: string[] = [];
  let current = "";
  let quote: "'" | '"' | undefined;
  let escaping = false;

  for (const char of input) {
    if (escaping) {
      current += char;
      escaping = false;
      continue;
    }
    if (char === "\\" && quote !== "'") {
      escaping = true;
      continue;
    }
    if (quote !== undefined) {
      if (char === quote) quote = undefined;
      else current += char;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }
    if (/\s/.test(char)) {
      if (current.length > 0) {
        words.push(current);
        current = "";
      }
      continue;
    }
    current += char;
  }

  if (escaping) current += "\\";
  if (quote !== undefined) {
    throw new TinyAgentError(
      "PHALA_COMMAND_INVALID",
      "--phala-command contains an unterminated quote",
    );
  }
  if (current.length > 0) words.push(current);
  if (words.length === 0) {
    throw new TinyAgentError(
      "PHALA_COMMAND_INVALID",
      "--phala-command must contain at least one word",
    );
  }
  return words;
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

function positionalMessage(args: string[]): string | undefined {
  const ignoredOptions = new Set([
    "--project-dir",
    "--message",
    "--model",
    "--token",
    "--port",
    "--url",
  ]);
  const parts: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (ignoredOptions.has(arg)) {
      index += 1;
      continue;
    }
    if (arg.startsWith("--")) continue;
    parts.push(arg);
  }
  return parts.length === 0 ? undefined : parts.join(" ");
}

function resolveChatEndpoint(
  projectDir: string,
  args: string[],
): { ok: true; url: string } | { ok: false; error: string } {
  const explicitUrl = readOption(args, "--url");
  if (explicitUrl !== undefined) return { ok: true, url: explicitUrl };

  const deployment = readDeploymentState(projectDir);
  if (deployment === undefined || deployment.status !== "running") {
    return { ok: false, error: "chat requires a running deployment" };
  }

  const requested = readOption(args, "--port");
  const port =
    requested === undefined
      ? (deployment.ports.find((candidate) => candidate.name === "gateway") ??
        deployment.ports[0])
      : deployment.ports.find(
          (candidate) =>
            candidate.name === requested ||
            String(candidate.remotePort) === requested ||
            String(candidate.localPort) === requested,
        );
  if (port === undefined) {
    return { ok: false, error: "deployment has no matching chat port" };
  }

  return {
    ok: true,
    url: `http://127.0.0.1:${port.localPort}/v1/chat/completions`,
  };
}

function parseJsonObject(input: string): Record<string, unknown> {
  const parsed = JSON.parse(input) as unknown;
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("expected JSON object response");
  }
  return parsed as Record<string, unknown>;
}

function extractChatContent(
  response: Record<string, unknown>,
): string | undefined {
  const choices = response.choices;
  if (!Array.isArray(choices)) return undefined;
  const first = choices[0];
  if (typeof first !== "object" || first === null) return undefined;
  const message = (first as Record<string, unknown>).message;
  if (typeof message !== "object" || message === null) return undefined;
  const content = (message as Record<string, unknown>).content;
  return typeof content === "string" ? content : undefined;
}

type RequiredOptions =
  | { ok: true; values: Record<string, string> }
  | { ok: false; missing: string[] };

function requireOptions(args: string[], names: string[]): RequiredOptions {
  const missing: string[] = [];
  const values: Record<string, string> = {};
  for (const name of names) {
    const value = readOption(args, name);
    if (value === undefined) missing.push(name);
    else values[name] = value;
  }
  return missing.length === 0 ? { ok: true, values } : { ok: false, missing };
}

function resolveLocalAgentStore(
  args: string[],
):
  | { ok: true; agent: string; storeDir: string }
  | { ok: false; error: string } {
  const projectDir = readOption(args, "--project-dir");
  if (projectDir !== undefined) {
    const config = readProjectConfig(projectDir);
    return { ok: true, agent: config.agent, storeDir: config.storeDir };
  }

  const agent = readOption(args, "--agent");
  const storeDir = readOption(args, "--store-dir");
  if (agent === undefined || storeDir === undefined) {
    const missing = [
      ...(agent === undefined ? ["--agent"] : []),
      ...(storeDir === undefined ? ["--store-dir"] : []),
    ];
    return {
      ok: false,
      error: `requires --project-dir or ${missing.join(", ")}`,
    };
  }
  return { ok: true, agent, storeDir };
}

type BackupInput =
  | {
      ok: true;
      agent: string;
      pack: string;
      stateDir: string;
      storeDir: string;
      space: string;
    }
  | { ok: false; missing: string[] };

function resolveBackupInput(args: string[]): BackupInput {
  const projectDir = readOption(args, "--project-dir");
  const config =
    projectDir === undefined ? undefined : readProjectConfig(projectDir);
  const values = {
    agent: readOption(args, "--agent") ?? config?.agent,
    pack: readOption(args, "--pack") ?? config?.pack,
    stateDir: readOption(args, "--state-dir") ?? config?.stateDir,
    storeDir: readOption(args, "--store-dir") ?? config?.storeDir,
    space: readOption(args, "--space"),
  };
  const missing = missingKeys(values);
  if (!hasBackupCredential(args)) {
    missing.push("--signature-hex, --signature-file, or --wallet-private-key");
  }
  return missing.length === 0
    ? ({ ok: true, ...values } as BackupInput)
    : { ok: false, missing };
}

type RecoverInput =
  | {
      ok: true;
      agent: string;
      targetDir: string;
      storeDir: string;
      space: string;
    }
  | { ok: false; missing: string[] };

function resolveRecoverInput(args: string[]): RecoverInput {
  const projectDir = readOption(args, "--project-dir");
  const config =
    projectDir === undefined ? undefined : readProjectConfig(projectDir);
  const values = {
    agent: readOption(args, "--agent") ?? config?.agent,
    targetDir: readOption(args, "--target-dir") ?? config?.stateDir,
    storeDir: readOption(args, "--store-dir") ?? config?.storeDir,
    space: readOption(args, "--space"),
  };
  const missing = missingKeys(values);
  if (!hasBackupCredential(args)) {
    missing.push("--signature-hex, --signature-file, or --wallet-private-key");
  }
  return missing.length === 0
    ? ({ ok: true, ...values } as RecoverInput)
    : { ok: false, missing };
}

function hasBackupCredential(args: string[]): boolean {
  return (
    readOption(args, "--signature-hex") !== undefined ||
    readOption(args, "--signature-file") !== undefined ||
    readOption(args, "--wallet-private-key") !== undefined
  );
}

async function resolveBackupSignature(
  space: string,
  args: string[],
): Promise<{ ok: true; bytes: Uint8Array } | { ok: false; error: string }> {
  const signatureHex = readOption(args, "--signature-hex");
  const signatureFile = readOption(args, "--signature-file");
  const walletPrivateKey = readOption(args, "--wallet-private-key");
  const provided = [signatureHex, signatureFile, walletPrivateKey].filter(
    (value) => value !== undefined,
  ).length;
  if (provided !== 1) {
    return {
      ok: false,
      error:
        "requires exactly one of --signature-hex, --signature-file, or --wallet-private-key",
    };
  }

  if (signatureHex !== undefined) {
    return signatureBytesFromHex(signatureHex, "--signature-hex");
  }
  if (signatureFile !== undefined) {
    const text = await readFile(signatureFile, "utf8");
    return signatureBytesFromHex(text.trim());
  }

  if (walletPrivateKey === undefined) {
    return { ok: false, error: "missing backup signature" };
  }

  try {
    const signer = new PrivateKeySigner(walletPrivateKey);
    const signature = await signer.signMessage(
      `${BACKUP_MESSAGE_PREFIX}${space}`,
    );
    return signatureBytesFromHex(signature);
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function signatureBytesFromHex(
  value: string,
  source = "backup signature",
): { ok: true; bytes: Uint8Array } | { ok: false; error: string } {
  const hex = value.startsWith("0x") ? value.slice(2) : value;
  if (!isHex(hex)) {
    return { ok: false, error: `${source} must be even-length hex` };
  }
  return { ok: true, bytes: new Uint8Array(Buffer.from(hex, "hex")) };
}

function missingKeys(values: Record<string, string | undefined>): string[] {
  return Object.entries(values)
    .filter((entry): entry is [string, undefined] => entry[1] === undefined)
    .map(
      ([key]) =>
        `--${key.replace(/[A-Z]/g, (char) => `-${char.toLowerCase()}`)}`,
    );
}

function projectConfigPath(projectDir: string): string {
  return join(projectDir, ".tinyagent", "project.json");
}

function deploymentPath(projectDir: string): string {
  return join(projectDir, ".tinyagent", "deployment.json");
}

function logPath(config: ProjectConfig): string {
  return join(config.stateDir, "logs", "tinyagent.log");
}

interface LocalCommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

async function runLocalCommand(
  command: string[],
  cwd: string,
  options: { timeoutMs?: number } = {},
): Promise<LocalCommandResult> {
  return await new Promise((resolve, reject) => {
    let timedOut = false;
    const child = spawn(command[0]!, command.slice(1), {
      cwd,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const timeout =
      options.timeoutMs === undefined
        ? undefined
        : setTimeout(() => {
            timedOut = true;
            child.kill();
          }, options.timeoutMs);
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("error", (error) => {
      if (timeout !== undefined) clearTimeout(timeout);
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "ENOENT"
      ) {
        resolve({
          exitCode: 127,
          stdout: Buffer.concat(stdout).toString("utf8"),
          stderr: error instanceof Error ? error.message : String(error),
        });
        return;
      }
      reject(error);
    });
    child.on("close", (code) => {
      if (timeout !== undefined) clearTimeout(timeout);
      resolve({
        exitCode: code ?? (timedOut ? 124 : 1),
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      });
    });
  });
}

async function appendShellLog(
  config: ProjectConfig,
  command: string[],
  result: LocalCommandResult,
): Promise<void> {
  const path = logPath(config);
  await mkdir(join(config.stateDir, "logs"), { recursive: true });
  const entry = [
    `[${new Date().toISOString()}] shell ${redactText(JSON.stringify(command))} exit=${result.exitCode}`,
    result.stdout ? `[stdout]\n${redactText(result.stdout.trimEnd())}` : "",
    result.stderr ? `[stderr]\n${redactText(result.stderr.trimEnd())}` : "",
    "",
  ]
    .filter((line) => line.length > 0)
    .join("\n");
  await appendFile(path, `${entry}\n`, { mode: 0o600 });
}

function readProjectConfig(projectDir: string): ProjectConfig {
  const parsed = JSON.parse(
    readFileSync(projectConfigPath(projectDir), "utf8"),
  );
  return parseProjectConfig(parsed);
}

function readDeploymentState(projectDir: string): DeploymentState | undefined {
  const path = deploymentPath(projectDir);
  if (!existsSync(path)) return undefined;
  const parsed = JSON.parse(readFileSync(path, "utf8"));
  return parseDeploymentState(parsed);
}

async function writeDeploymentState(
  projectDir: string,
  deployment: DeploymentState,
): Promise<void> {
  await mkdir(join(projectDir, ".tinyagent"), { recursive: true });
  await writeFile(
    deploymentPath(projectDir),
    `${JSON.stringify(deployment, null, 2)}\n`,
    { mode: 0o600 },
  );
}

function parseProjectConfig(value: unknown): ProjectConfig {
  if (typeof value !== "object" || value === null) {
    throw new Error("project config must be an object");
  }
  const record = value as Record<string, unknown>;
  const provider = parseProvider(String(record.provider));
  const config: ProjectConfig = {
    version: 1,
    agent: requireString(record, "agent"),
    pack: requireString(record, "pack"),
    provider,
    storeDir: requireString(record, "storeDir"),
    stateDir: requireString(record, "stateDir"),
    runnerImage:
      typeof record.runnerImage === "string"
        ? record.runnerImage
        : "tinyagent-runner:test",
    createdAt: requireString(record, "createdAt"),
    ...(typeof record.registryPath === "string"
      ? { registryPath: record.registryPath }
      : {}),
  };
  if (record.version !== 1)
    throw new Error("unsupported project config version");
  return config;
}

function parseDeploymentState(value: unknown): DeploymentState {
  if (typeof value !== "object" || value === null) {
    throw new Error("deployment state must be an object");
  }
  const record = value as Record<string, unknown>;
  if (record.version !== 1) {
    throw new Error("unsupported deployment state version");
  }
  const ports = Array.isArray(record.ports) ? record.ports : [];
  return {
    version: 1,
    sandboxId: requireString(record, "sandboxId"),
    provider: parseProvider(String(record.provider)),
    agent: requireString(record, "agent"),
    pack: requireString(record, "pack"),
    status: parseDeploymentStatus(String(record.status)),
    ports: ports.map(parseDeploymentPort),
    ...(record.runnerSpec !== undefined
      ? { runnerSpec: SandboxSpecSchema.parse(record.runnerSpec) }
      : {}),
    ...(record.attestation !== undefined
      ? { attestation: parseStoredAttestation(record.attestation) }
      : {}),
    deployedAt: requireString(record, "deployedAt"),
    updatedAt: requireString(record, "updatedAt"),
  };
}

function isRealDockerDeployment(deployment: DeploymentState): boolean {
  return !deployment.sandboxId.startsWith("local:");
}

function isRealDstackDeployment(deployment: DeploymentState): boolean {
  return !deployment.sandboxId.startsWith("dstack-sim:");
}

function sandboxFromDeployment(deployment: DeploymentState): Sandbox {
  return {
    id: deployment.sandboxId,
    name: deployment.runnerSpec?.name ?? deployment.sandboxId,
    provider: deployment.provider,
    status: deployment.status,
    metadata: Object.fromEntries(
      deployment.ports.map((port) => [
        `port:${port.remotePort}/tcp`,
        String(port.localPort),
      ]),
    ),
  };
}

function buildLocalRunnerSpec(
  config: ProjectConfig,
  agent: AgentSpec,
): SandboxSpec {
  const gatewayPort = agent.ports.find((port) => port.name === "gateway");
  const expectedComposeHash = readRunnerComposeHash();
  return {
    name: `tinyagent-${config.agent}`,
    provider: "local-docker",
    agent,
    image: config.runnerImage,
    environment: {
      TINYAGENT_AGENT: config.agent,
      TINYAGENT_PACK: config.pack,
      TINYAGENT_STATE_DIR: "/state",
      ...(gatewayPort !== undefined
        ? { GATEWAY_PORT: String(gatewayPort.port) }
        : {}),
    },
    mounts: [
      {
        source: config.stateDir,
        target: "/state",
        readonly: false,
      },
    ],
    labels: {
      "tinyagent.agent": config.agent,
      "tinyagent.pack": config.pack,
      "tinyagent.provider": config.provider,
    },
    ...(expectedComposeHash !== undefined ? { expectedComposeHash } : {}),
  };
}

function buildDstackRunnerSpec(
  config: ProjectConfig,
  agent: AgentSpec,
): SandboxSpec {
  const expectedComposeHash = readRunnerComposeHash();
  return {
    name: `tinyagent-${config.agent}`,
    provider: "dstack-cvm",
    agent,
    image: config.runnerImage,
    environment: {
      TINYAGENT_AGENT: config.agent,
      TINYAGENT_PACK: config.pack,
      TINYAGENT_STATE_DIR: "/state",
    },
    mounts: [
      {
        source: config.stateDir,
        target: "/state",
        readonly: false,
      },
    ],
    labels: {
      "tinyagent.agent": config.agent,
      "tinyagent.pack": config.pack,
      "tinyagent.provider": config.provider,
    },
    ...(expectedComposeHash !== undefined ? { expectedComposeHash } : {}),
  };
}

function createPhalaCliProvider(args: string[]): PhalaCliProvider {
  return new PhalaCliProvider({ phalaCommand: resolvePhalaCommand(args) });
}

function createDeployDcapVerifier(
  args: string[],
): AttestationPolicy["dcapVerifier"] | undefined {
  const phalaVerifyUrl = readOption(args, "--phala-verify-url");
  if (phalaVerifyUrl !== undefined) {
    return createPhalaVerifier({ endpoint: phalaVerifyUrl });
  }
  if (args.includes("--dcap-qvl")) return createDcapQvlVerifier();
  return undefined;
}

function readRunnerComposeHash(): string | undefined {
  const candidates = [
    join(process.cwd(), "runner", "app-compose.sha256"),
    join(process.cwd(), "tinyagent", "runner", "app-compose.sha256"),
  ];
  const path = candidates.find((candidate) => existsSync(candidate));
  if (path === undefined) return undefined;
  return readFileSync(path, "utf8").trim();
}

function parseDeploymentStatus(value: string): DeploymentState["status"] {
  if (value === "running" || value === "stopped" || value === "destroyed") {
    return value;
  }
  throw new Error(`unsupported deployment status: ${value}`);
}

function parseDeploymentPort(value: unknown): DeploymentState["ports"][number] {
  if (typeof value !== "object" || value === null) {
    throw new Error("deployment port must be an object");
  }
  const record = value as Record<string, unknown>;
  return {
    name: requireString(record, "name"),
    remotePort: requireNumber(record, "remotePort"),
    localPort: requireNumber(record, "localPort"),
  };
}

function parseStoredAttestation(value: unknown): StoredAttestationVerdict {
  if (typeof value !== "object" || value === null) {
    throw new Error("deployment attestation must be an object");
  }
  const record = value as Record<string, unknown>;
  return {
    ok: record.ok === true,
    doc: AttestationDocSchema.parse(record.doc),
    errors: stringArray(record.errors),
    warnings: stringArray(record.warnings),
    checks: {
      schema: booleanField(record.checks, "schema"),
      composeHash: booleanField(record.checks, "composeHash"),
      nonce: booleanField(record.checks, "nonce"),
      timestamp: booleanField(record.checks, "timestamp"),
      productionDcap: booleanField(record.checks, "productionDcap"),
      rtmrReplay: booleanField(record.checks, "rtmrReplay"),
      gatewayBinding: booleanField(record.checks, "gatewayBinding"),
    },
  };
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function booleanField(value: unknown, key: string): boolean {
  return typeof value === "object" &&
    value !== null &&
    (value as Record<string, unknown>)[key] === true
    ? true
    : false;
}

function readConfiguredAgent(config: ProjectConfig): AgentSpec | undefined {
  if (config.registryPath === undefined) return undefined;
  return findAgent(readConfiguredRegistry(config), config.pack);
}

function readConfiguredRegistry(config: ProjectConfig): PackRegistry {
  const registryPath = config.registryPath ?? defaultRegistryPath();
  if (registryPath === undefined) {
    throw new Error(
      "project has no registryPath and no default Lowkey registry is available",
    );
  }
  return parseLowkeyRegistryText(readFileSync(registryPath, "utf8"), {
    format:
      registryPath.endsWith(".yaml") || registryPath.endsWith(".yml")
        ? "yaml"
        : "json",
  });
}

function readLowkeyManifest(pack: string) {
  const candidates = [
    join(process.cwd(), "vendor", "lowkey", "packs", pack, "manifest.yaml"),
    join(
      process.cwd(),
      "tinyagent",
      "vendor",
      "lowkey",
      "packs",
      pack,
      "manifest.yaml",
    ),
  ];
  const path = candidates.find((candidate) => existsSync(candidate));
  return path === undefined
    ? undefined
    : parseLowkeyManifestText(readFileSync(path, "utf8"));
}

function readRepeatedKeyValueOptions(
  args: string[],
  name: string,
): Record<string, string> {
  const values: Record<string, string> = {};
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] !== name) continue;
    const raw = args[index + 1];
    if (raw === undefined || raw.startsWith("--")) continue;
    const separator = raw.indexOf("=");
    if (separator < 1) {
      throw new Error(`${name} requires KEY=VALUE`);
    }
    values[raw.slice(0, separator)] = raw.slice(separator + 1);
    index += 1;
  }
  return values;
}

function requireString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`project config requires ${key}`);
  }
  return value;
}

function requireNumber(record: Record<string, unknown>, key: string): number {
  const value = record[key];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`project config requires numeric ${key}`);
  }
  return value;
}

function parseProvider(value: string): ProjectConfig["provider"] {
  if (
    value === "local-docker" ||
    value === "dstack-cvm" ||
    value === "lightning"
  ) {
    return value;
  }
  throw new Error(`unsupported provider: ${value}`);
}

function defaultRegistryPath(): string | undefined {
  const candidates = [
    join(process.cwd(), "vendor/lowkey/packs/registry.json"),
    join(process.cwd(), "tinyagent/vendor/lowkey/packs/registry.json"),
    join(process.cwd(), "test/fixtures/lowkey-registry.json"),
    join(process.cwd(), "tinyagent/test/fixtures/lowkey-registry.json"),
  ];
  return candidates.find((candidate) => existsSync(candidate));
}

function printValue(value: unknown, json: boolean): void {
  const redacted = redactOutputValue(value);
  console.log(
    json ? JSON.stringify(redacted) : JSON.stringify(redacted, null, 2),
  );
}

function redactOutputValue(value: unknown): unknown {
  if (typeof value === "string") return redactText(value);
  if (value && typeof value === "object") {
    return redactObject({ value }).value;
  }
  return value;
}

function printError(error: unknown, json: boolean): void {
  const message = redactText(
    error instanceof Error ? error.message : String(error),
  );
  const code =
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string"
      ? error.code
      : undefined;
  const details =
    typeof error === "object" &&
    error !== null &&
    "details" in error &&
    error.details !== undefined
      ? typeof error.details === "object" && error.details !== null
        ? redactObject(error.details as Record<string, unknown>)
        : redactValue(error.details)
      : undefined;
  if (json) {
    console.error(
      JSON.stringify({
        ok: false,
        ...(code !== undefined ? { code } : {}),
        error: message,
        ...(details !== undefined ? { details } : {}),
      }),
    );
  } else {
    console.error(`error: ${code !== undefined ? `${code}: ` : ""}${message}`);
  }
}

function isHex(value: string): boolean {
  return (
    value.length > 0 && value.length % 2 === 0 && /^[0-9a-fA-F]+$/.test(value)
  );
}

function isDirectRun(): boolean {
  return process.argv[1]
    ? import.meta.url === pathToFileURL(process.argv[1]).href
    : false;
}

if (isDirectRun()) {
  const result = await main();
  if (result !== 0) process.exit(result);
}

async function catchCommand(
  run: () => Promise<number>,
  json: boolean,
): Promise<number> {
  try {
    return await run();
  } catch (error) {
    printError(error, json);
    return 1;
  }
}
