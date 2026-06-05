import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, normalize } from "node:path";
import { spawn } from "node:child_process";
import {
  TinyAgentError,
  type AttestationDoc,
  type ExecChunk,
  type ExecSpec,
  type FileBlob,
  type FileSpec,
  type Sandbox,
  type SandboxSpec,
  type Tunnel,
} from "@tinyagent/core";
import type { ComputeProvider } from "@tinyagent/provider-core";

export interface CommandResult {
  stdout: Uint8Array;
  stderr: Uint8Array;
  exitCode: number;
}

export interface CommandRunner {
  run(
    command: string[],
    options?: { timeoutMs?: number },
  ): Promise<CommandResult>;
  spawn?(command: string[]): Promise<{ close(): Promise<void> }>;
}

export interface PhalaCliProviderOptions {
  runner?: CommandRunner;
  phalaBin?: string;
  phalaCommand?: string[];
}

export interface GuestKey {
  path: string;
  key: Uint8Array;
}

export class PhalaCliProvider implements ComputeProvider {
  readonly kind = "dstack-cvm" as const;
  private readonly runner: CommandRunner;
  private readonly phalaCommand: string[];

  constructor(options: PhalaCliProviderOptions = {}) {
    this.runner = options.runner ?? new NodeCommandRunner();
    this.phalaCommand = options.phalaCommand ?? [options.phalaBin ?? "phala"];
  }

  async provision(spec: SandboxSpec): Promise<Sandbox> {
    const compose = await writeTempFile(
      new TextEncoder().encode(renderDockerCompose(spec)),
    );
    try {
      const command = [
        ...this.phalaCommand,
        "deploy",
        "--json",
        "--wait",
        "--name",
        spec.name,
        "--compose",
        compose.path,
        "--no-public-logs",
        "--no-public-sysinfo",
      ];
      for (const [key, value] of Object.entries(spec.environment)) {
        command.push("--env", `${key}=${value}`);
      }

      const result = await this.run(command, "PHALA_PROVISION_FAILED");
      const parsed = parseJsonObject(
        result.stdout,
        "PHALA_PROVISION_PARSE_FAILED",
      );
      const id = firstStringField(parsed, [
        "id",
        "cvmId",
        "cvm_id",
        "uuid",
        "appId",
        "app_id",
        "instanceId",
        "instance_id",
      ]);
      return {
        id,
        name: spec.name,
        provider: this.kind,
        status: "provisioned",
        metadata: {
          appId: firstOptionalStringField(parsed, ["appId", "app_id"]) ?? id,
          composeHash:
            firstOptionalStringField(parsed, ["composeHash", "compose_hash"]) ??
            spec.expectedComposeHash,
        },
      };
    } finally {
      await compose.closeAndRemove();
    }
  }

  async start(sandbox: Sandbox): Promise<void> {
    await this.run(
      [...this.phalaCommand, "cvms", "start", sandbox.id, "--json"],
      "PHALA_START_FAILED",
    );
    sandbox.status = "running";
  }

  async stop(sandbox: Sandbox): Promise<void> {
    await this.run(
      [...this.phalaCommand, "cvms", "stop", sandbox.id, "--json"],
      "PHALA_STOP_FAILED",
    );
    sandbox.status = "stopped";
  }

  async destroy(sandbox: Sandbox): Promise<void> {
    await this.run(
      [...this.phalaCommand, "cvms", "delete", sandbox.id, "--yes", "--json"],
      "PHALA_DESTROY_FAILED",
    );
    sandbox.status = "destroyed";
  }

  async *exec(sandbox: Sandbox, command: ExecSpec): AsyncIterable<ExecChunk> {
    const remoteCommand =
      Object.keys(command.env).length === 0
        ? command.command
        : [
            "env",
            ...Object.entries(command.env).map(
              ([key, value]) => `${key}=${value}`,
            ),
            ...command.command,
          ];
    const result = await this.runner.run(
      [...this.phalaCommand, "ssh", sandbox.id, "--", ...remoteCommand],
      command.timeoutMs === undefined
        ? undefined
        : { timeoutMs: command.timeoutMs },
    );
    if (result.stdout.byteLength > 0) {
      yield { stream: "stdout", data: new Uint8Array(result.stdout) };
    }
    if (result.stderr.byteLength > 0) {
      yield { stream: "stderr", data: new Uint8Array(result.stderr) };
    }
    yield {
      stream: "exit",
      exitCode: result.exitCode,
      ...(result.exitCode === 124 && command.timeoutMs !== undefined
        ? { timedOut: true, timeoutMs: command.timeoutMs }
        : {}),
    };
  }

  async putFiles(sandbox: Sandbox, files: FileSpec[]): Promise<void> {
    for (const file of files) {
      const tmp = await writeTempFile(file.content, file.mode);
      try {
        await this.run(
          [...this.phalaCommand, "cp", tmp.path, `${sandbox.id}:${file.path}`],
          "PHALA_PUT_FILES_FAILED",
        );
      } finally {
        await tmp.closeAndRemove();
      }
    }
  }

  async getFiles(sandbox: Sandbox, paths: string[]): Promise<FileBlob[]> {
    const out: FileBlob[] = [];
    for (const path of paths) {
      const tmp = await writeTempFile(new Uint8Array());
      try {
        await this.run(
          [...this.phalaCommand, "cp", `${sandbox.id}:${path}`, tmp.path],
          "PHALA_GET_FILES_FAILED",
        );
        out.push({ path, content: await readFile(tmp.path) });
      } finally {
        await tmp.closeAndRemove();
      }
    }
    return out;
  }

  async forwardPort(
    sandbox: Sandbox,
    remotePort: number,
    localPort: number,
  ): Promise<Tunnel> {
    const actualLocalPort = localPort === 0 ? remotePort : localPort;
    const command = [
      ...this.phalaCommand,
      "ssh",
      sandbox.id,
      "--",
      "-L",
      `${actualLocalPort}:localhost:${remotePort}`,
      "-N",
    ];
    if (this.runner.spawn === undefined) {
      throw new TinyAgentError(
        "PHALA_TUNNEL_UNSUPPORTED",
        "Phala command runner cannot keep an SSH tunnel open",
      );
    }
    const process = await this.runner.spawn(command);
    return {
      id: `${sandbox.id}:${remotePort}`,
      localPort: actualLocalPort,
      remotePort,
      async close() {
        await process.close();
      },
    };
  }

  async attest(sandbox: Sandbox, nonce: Uint8Array): Promise<AttestationDoc> {
    const result = await this.run(
      [
        ...this.phalaCommand,
        "ssh",
        sandbox.id,
        "--",
        "sh",
        "-lc",
        [
          "curl -fsS -X POST",
          "--unix-socket /var/run/dstack.sock",
          "-H 'Content-Type: application/json'",
          `-d ${shellQuote(
            JSON.stringify({
              reportData: `0x${Buffer.from(nonce).toString("hex")}`,
            }),
          )}`,
          "http://dstack/GetQuote",
        ].join(" "),
      ],
      "PHALA_ATTEST_FAILED",
    );
    const parsed = parseJsonObject(result.stdout, "PHALA_ATTEST_PARSE_FAILED");
    const composeHash =
      optionalStringField(parsed, "composeHash") ??
      metadataString(sandbox, "composeHash");
    if (composeHash === undefined) {
      throw new TinyAgentError(
        "PHALA_RESPONSE_INVALID",
        "Phala attestation response is missing composeHash",
      );
    }
    return {
      provider: this.kind,
      quote: firstStringField(parsed, ["quote", "tdxQuote", "tdx_quote"]),
      composeHash,
      appId:
        firstOptionalStringField(parsed, ["appId", "app_id"]) ??
        metadataString(sandbox, "appId"),
      timestamp:
        optionalStringField(parsed, "timestamp") ?? new Date().toISOString(),
      nonce:
        optionalStringField(parsed, "nonce") ??
        Buffer.from(nonce).toString("hex"),
      reportData:
        firstOptionalStringField(parsed, ["reportData", "report_data"]) ??
        `0x${Buffer.from(nonce).toString("hex")}`,
      eventLog: parsed.eventLog ?? parsed.event_log,
    };
  }

  async getAgentKey(sandbox: Sandbox, agentName: string): Promise<GuestKey> {
    const path = `tinycloud/agents/${agentName}`;
    const result = await this.run(
      [
        ...this.phalaCommand,
        "ssh",
        sandbox.id,
        "--",
        "sh",
        "-lc",
        `curl -fsS --unix-socket /var/run/dstack.sock ${shellQuote(
          `http://dstack/GetKey?path=${encodeURIComponent(path)}`,
        )}`,
      ],
      "PHALA_GET_KEY_FAILED",
    );
    const parsed = parseJsonObject(result.stdout, "PHALA_GET_KEY_PARSE_FAILED");
    return {
      path,
      key: keyField(parsed),
    };
  }

  private async run(command: string[], code: string): Promise<CommandResult> {
    const result = await this.runner.run(command);
    if (result.exitCode !== 0) {
      throw new TinyAgentError(code, commandFailedMessage(command, result), {
        command,
        exitCode: result.exitCode,
      });
    }
    return result;
  }
}

class NodeCommandRunner implements CommandRunner {
  async run(
    command: string[],
    options: { timeoutMs?: number } = {},
  ): Promise<CommandResult> {
    const controller = new AbortController();
    const timeout =
      options.timeoutMs === undefined
        ? undefined
        : setTimeout(() => controller.abort(), options.timeoutMs);
    const child = spawn(command[0]!, command.slice(1), {
      signal: controller.signal,
    });
    try {
      return await collectProcessOutput(child);
    } finally {
      if (timeout !== undefined) clearTimeout(timeout);
    }
  }

  async spawn(command: string[]): Promise<{ close(): Promise<void> }> {
    const child = spawn(command[0]!, command.slice(1), {
      stdio: "ignore",
    });
    return {
      close: async () => {
        child.kill();
        await new Promise<void>((resolve) => {
          child.once("close", () => resolve());
          setTimeout(resolve, 100);
        });
      },
    };
  }
}

async function collectProcessOutput(
  child: ReturnType<typeof spawn>,
): Promise<CommandResult> {
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];

  if (child.stdout !== null) {
    child.stdout.on("data", (chunk) => stdout.push(Buffer.from(chunk)));
  }
  if (child.stderr !== null) {
    child.stderr.on("data", (chunk) => stderr.push(Buffer.from(chunk)));
  }

  const exitCode = await new Promise<number>((resolve, reject) => {
    child.on("error", (error: NodeJS.ErrnoException) => {
      if (error.name === "AbortError") {
        resolve(124);
        return;
      }
      if (error.code === "ENOENT") {
        stderr.push(Buffer.from(error.message));
        resolve(127);
        return;
      }
      reject(error);
    });
    child.on("close", (code) => resolve(code ?? 0));
  });

  return {
    stdout: new Uint8Array(Buffer.concat(stdout)),
    stderr: new Uint8Array(Buffer.concat(stderr)),
    exitCode,
  };
}

async function writeTempFile(
  content: Uint8Array,
  mode?: string,
): Promise<{ path: string; closeAndRemove(): Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), "tinyagent-phala-cp-"));
  const path = join(dir, "file");
  await writeFile(path, content, {
    mode: Number.parseInt(mode ?? "0600", 8),
  });
  return {
    path,
    closeAndRemove: async () => {
      await rm(dir, { recursive: true, force: true });
    },
  };
}

function parseJsonObject(
  bytes: Uint8Array,
  code: string,
): Record<string, unknown> {
  try {
    const parsed = JSON.parse(new TextDecoder().decode(bytes)) as unknown;
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      Array.isArray(parsed)
    ) {
      throw new Error("expected JSON object");
    }
    return parsed as Record<string, unknown>;
  } catch (error) {
    throw new TinyAgentError(
      code,
      error instanceof Error ? error.message : String(error),
    );
  }
}

function firstStringField(
  record: Record<string, unknown>,
  keys: string[],
): string {
  const value = firstOptionalStringField(record, keys);
  if (value !== undefined) return value;
  throw new TinyAgentError(
    "PHALA_RESPONSE_INVALID",
    `Phala response missing string field: ${keys.join(" | ")}`,
    { keys },
  );
}

function optionalStringField(
  record: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function firstOptionalStringField(
  record: Record<string, unknown>,
  keys: string[],
): string | undefined {
  for (const key of keys) {
    const direct = optionalStringField(record, key);
    if (direct !== undefined) return direct;
  }
  for (const value of Object.values(record)) {
    if (typeof value === "object" && value !== null && !Array.isArray(value)) {
      const nested = firstOptionalStringField(
        value as Record<string, unknown>,
        keys,
      );
      if (nested !== undefined) return nested;
    }
  }
  return undefined;
}

function commandFailedMessage(
  command: string[],
  result: CommandResult,
): string {
  const stderr = new TextDecoder().decode(result.stderr).trim();
  return stderr.length > 0
    ? stderr
    : `${command.join(" ")} exited with code ${result.exitCode}`;
}

function keyField(record: Record<string, unknown>): Uint8Array {
  const value = record.key;
  if (typeof value === "string") return hexKey(value);
  if (
    Array.isArray(value) &&
    value.every((item) => Number.isInteger(item) && item >= 0 && item <= 255)
  ) {
    return Uint8Array.from(value);
  }
  throw new TinyAgentError(
    "PHALA_RESPONSE_INVALID",
    "Phala key response missing key bytes",
  );
}

function hexKey(value: string): Uint8Array {
  const hex = value.startsWith("0x") ? value.slice(2) : value;
  if (!/^[0-9a-fA-F]+$/.test(hex) || hex.length % 2 !== 0) {
    throw new TinyAgentError(
      "PHALA_RESPONSE_INVALID",
      "Phala key response has invalid hex",
    );
  }
  return Uint8Array.from(Buffer.from(hex, "hex"));
}

export class DstackSimulatorProvider implements ComputeProvider {
  readonly kind = "dstack-cvm" as const;

  async provision(spec: SandboxSpec): Promise<Sandbox> {
    const rootDir = await mkdtemp(join(tmpdir(), "tinyagent-dstack-sim-"));
    const composeHash =
      spec.expectedComposeHash ??
      computeComposeHash(spec.image, spec.agent.name);
    return {
      id: `dstack-sim:${crypto.randomUUID()}`,
      name: spec.name,
      provider: this.kind,
      status: "provisioned",
      metadata: {
        rootDir,
        composeHash,
        appId: spec.labels.appId ?? spec.name,
      },
    };
  }

  async start(sandbox: Sandbox): Promise<void> {
    sandbox.status = "running";
  }

  async stop(sandbox: Sandbox): Promise<void> {
    if (sandbox.status !== "destroyed") sandbox.status = "stopped";
  }

  async destroy(sandbox: Sandbox): Promise<void> {
    const rootDir = metadataString(sandbox, "rootDir");
    if (rootDir !== undefined)
      await rm(rootDir, { force: true, recursive: true });
    sandbox.status = "destroyed";
  }

  async *exec(sandbox: Sandbox, command: ExecSpec): AsyncIterable<ExecChunk> {
    const cwd = sandboxPath(sandbox, command.cwd ?? "/");
    const controller = new AbortController();
    const timeout =
      command.timeoutMs === undefined
        ? undefined
        : setTimeout(() => controller.abort(), command.timeoutMs);
    const child = spawn(command.command[0]!, command.command.slice(1), {
      cwd,
      env: { ...process.env, ...command.env },
      signal: controller.signal,
    });

    try {
      for await (const chunk of readProcessChunks(child, command.timeoutMs)) {
        yield chunk;
      }
    } finally {
      if (timeout !== undefined) clearTimeout(timeout);
    }
  }

  async putFiles(sandbox: Sandbox, files: FileSpec[]): Promise<void> {
    for (const file of files) {
      const path = sandboxPath(sandbox, file.path);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, file.content, {
        mode: Number.parseInt(file.mode ?? "0600", 8),
      });
    }
  }

  async getFiles(sandbox: Sandbox, paths: string[]): Promise<FileBlob[]> {
    return Promise.all(
      paths.map(async (path) => ({
        path,
        content: await readFile(sandboxPath(sandbox, path)),
      })),
    );
  }

  async forwardPort(
    sandbox: Sandbox,
    remotePort: number,
    localPort: number,
  ): Promise<Tunnel> {
    return {
      id: `${sandbox.id}:${remotePort}`,
      localPort,
      remotePort,
      async close() {
        return;
      },
    };
  }

  async attest(sandbox: Sandbox, nonce: Uint8Array): Promise<AttestationDoc> {
    const composeHash = metadataString(sandbox, "composeHash");
    if (composeHash === undefined) {
      throw new TinyAgentError(
        "DSTACK_SIM_ATTEST_FAILED",
        "sandbox is missing compose hash metadata",
      );
    }

    return {
      provider: this.kind,
      quote: "simulated-dstack-quote",
      composeHash,
      appId: metadataString(sandbox, "appId"),
      timestamp: new Date().toISOString(),
      nonce: Buffer.from(nonce).toString("hex"),
    };
  }
}

function computeComposeHash(image: string, agent: string): string {
  const digest = createHash("sha256")
    .update(`${image}\n${agent}`)
    .digest("hex");
  return `sha256:${digest}`;
}

function metadataString(sandbox: Sandbox, key: string): string | undefined {
  const value = sandbox.metadata?.[key];
  return typeof value === "string" ? value : undefined;
}

function sandboxPath(sandbox: Sandbox, path: string): string {
  const rootDir = metadataString(sandbox, "rootDir");
  if (rootDir === undefined) {
    throw new TinyAgentError(
      "DSTACK_SIM_SANDBOX_INVALID",
      "sandbox is missing root directory metadata",
    );
  }
  const relative = normalize(path).replace(/^(\.\.(\/|\\|$))+/, "");
  return join(rootDir, relative.replace(/^\/+/, ""));
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function renderDockerCompose(spec: SandboxSpec): string {
  const lines = [
    "services:",
    "  runner:",
    `    image: ${quoteYaml(spec.image)}`,
    "    restart: unless-stopped",
    `    container_name: ${quoteYaml(spec.name)}`,
  ];
  if (Object.keys(spec.labels).length > 0) {
    lines.push("    labels:");
    for (const [key, value] of Object.entries(spec.labels)) {
      lines.push(`      ${quoteYaml(key)}: ${quoteYaml(value)}`);
    }
  }
  if (Object.keys(spec.environment).length > 0) {
    lines.push("    environment:");
    for (const [key, value] of Object.entries(spec.environment)) {
      lines.push(`      - ${quoteYaml(`${key}=${value}`)}`);
    }
  }
  if (spec.agent.ports.length > 0) {
    lines.push("    ports:");
    for (const port of spec.agent.ports) {
      lines.push(`      - ${quoteYaml(`${port.port}:${port.port}`)}`);
    }
  }
  const volumes = new Set<string>();
  const mounts = ensureDstackSocketMount(spec.mounts);
  if (mounts.length > 0) {
    lines.push("    volumes:");
    for (const mount of mounts) {
      const source = composeVolumeSource(spec, mount.source, mount.target);
      if (!source.startsWith("/") && !source.startsWith(".")) {
        volumes.add(source);
      }
      lines.push(
        `      - ${quoteYaml(
          `${source}:${mount.target}${mount.readonly ? ":ro" : ""}`,
        )}`,
      );
    }
  }
  if (volumes.size > 0) {
    lines.push("volumes:");
    for (const volume of volumes) {
      lines.push(`  ${quoteYaml(volume)}:`);
    }
  }
  return `${lines.join("\n")}\n`;
}

function ensureDstackSocketMount(
  mounts: SandboxSpec["mounts"],
): SandboxSpec["mounts"] {
  if (
    mounts.some(
      (mount) =>
        mount.source === "/var/run/dstack.sock" ||
        mount.target === "/var/run/dstack.sock",
    )
  ) {
    return mounts;
  }
  return [
    ...mounts,
    {
      source: "/var/run/dstack.sock",
      target: "/var/run/dstack.sock",
      readonly: false,
    },
  ];
}

function composeVolumeSource(
  spec: SandboxSpec,
  source: string,
  target: string,
): string {
  if (source === "/var/run/dstack.sock") return source;
  if (source.startsWith("/") || source.startsWith(".")) {
    return `${sanitizeComposeName(spec.name)}-${sanitizeComposeName(target)}`;
  }
  return source;
}

function sanitizeComposeName(value: string): string {
  const sanitized = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return sanitized.length > 0 ? sanitized : "data";
}

function quoteYaml(value: string): string {
  return JSON.stringify(value);
}

async function* readProcessChunks(
  child: ReturnType<typeof spawn>,
  timeoutMs?: number,
): AsyncIterable<ExecChunk> {
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];

  if (child.stdout !== null) {
    child.stdout.on("data", (chunk) => stdout.push(Buffer.from(chunk)));
  }
  if (child.stderr !== null) {
    child.stderr.on("data", (chunk) => stderr.push(Buffer.from(chunk)));
  }

  const exitCode = await new Promise<number>((resolve, reject) => {
    child.on("error", (error: NodeJS.ErrnoException) => {
      if (error.name === "AbortError") {
        resolve(124);
        return;
      }
      reject(error);
    });
    child.on("close", (code) => resolve(code ?? 0));
  });

  if (stdout.length > 0) {
    yield {
      stream: "stdout",
      data: new Uint8Array(Buffer.concat(stdout)),
    };
  }
  if (stderr.length > 0) {
    yield {
      stream: "stderr",
      data: new Uint8Array(Buffer.concat(stderr)),
    };
  }
  yield {
    stream: "exit",
    exitCode,
    ...(exitCode === 124 && timeoutMs !== undefined
      ? { timedOut: true, timeoutMs }
      : {}),
  };
}
