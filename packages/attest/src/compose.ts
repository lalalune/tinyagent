import { createHash } from "node:crypto";

export interface RunnerAppCompose {
  readonly manifestVersion: number;
  readonly name: string;
  readonly runner: "docker-compose";
  readonly dockerComposeFile: string;
  readonly kmsEnabled: boolean;
  readonly gatewayEnabled: boolean;
  readonly localKeyProvider: boolean;
  readonly publicSysinfo: boolean;
  readonly publicLogs: boolean;
  readonly allowedEnvs: readonly string[];
  readonly preLaunchScript?: string;
  [extra: string]: JsonValue;
}

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | undefined
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

export interface RunnerComposeSpec {
  readonly name: string;
  readonly image: string;
  readonly pack?: string;
  readonly lowkeyRef: string;
  readonly gatewayPort?: number;
  readonly allowedEnvs?: readonly string[];
  readonly kmsEnabled?: boolean;
  readonly gatewayEnabled?: boolean;
  readonly localKeyProvider?: boolean;
  readonly publicSysinfo?: boolean;
  readonly publicLogs?: boolean;
}

const MANIFEST_VERSION = 2;
const DEFAULT_GATEWAY_PORT = 3001;
const DEFAULT_PACK = "openclaw";

function buildDockerComposeFile(spec: RunnerComposeSpec): string {
  const pack = spec.pack ?? DEFAULT_PACK;
  const port = spec.gatewayPort ?? DEFAULT_GATEWAY_PORT;
  const lines = [
    "services:",
    "  runner:",
    `    image: ${spec.image}`,
    "    restart: unless-stopped",
    `    container_name: tinyagent-runner`,
    "    labels:",
    `      tinyagent.pack: "${pack}"`,
    `      tinyagent.lowkey_ref: "${spec.lowkeyRef}"`,
    "    ports:",
    `      - "${port}:${port}"`,
    "    volumes:",
    "      - /var/run/tappd.sock:/var/run/tappd.sock",
    "      - tinyagent-data:/data",
    "    environment:",
    `      - GATEWAY_PORT=${port}`,
    "volumes:",
    "  tinyagent-data:",
    "",
  ];
  return lines.join("\n");
}

export function buildRunnerAppCompose(
  spec: RunnerComposeSpec,
): RunnerAppCompose {
  const allowedEnvs = [...(spec.allowedEnvs ?? [])].sort();
  return {
    manifestVersion: MANIFEST_VERSION,
    name: spec.name,
    runner: "docker-compose",
    dockerComposeFile: buildDockerComposeFile(spec),
    kmsEnabled: spec.kmsEnabled ?? true,
    gatewayEnabled: spec.gatewayEnabled ?? true,
    localKeyProvider: spec.localKeyProvider ?? false,
    publicSysinfo: spec.publicSysinfo ?? false,
    publicLogs: spec.publicLogs ?? false,
    allowedEnvs,
  };
}

export function canonicalize(value: JsonValue): string {
  if (value === null || value === undefined) return "null";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error("cannot canonicalize a non-finite number");
    }
    return JSON.stringify(value);
  }
  if (typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalize(item ?? null)).join(",")}]`;
  }
  const record = value as { readonly [key: string]: JsonValue };
  const entries = Object.keys(record)
    .sort()
    .map((key) => [key, record[key]] as const)
    .filter(([, v]) => v !== undefined)
    .map(
      ([key, v]) => `${JSON.stringify(key)}:${canonicalize(v as JsonValue)}`,
    );
  return `{${entries.join(",")}}`;
}

export function computeComposeHash(appCompose: RunnerAppCompose): string {
  const canonical = canonicalize(appCompose as unknown as JsonValue);
  const hex = createHash("sha256").update(canonical, "utf8").digest("hex");
  return `sha256:${hex}`;
}

export function serializeAppCompose(appCompose: RunnerAppCompose): string {
  return canonicalize(appCompose as unknown as JsonValue);
}
