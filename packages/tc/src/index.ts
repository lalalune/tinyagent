import { createHash } from "node:crypto";
import {
  mkdir,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import {
  err,
  ok,
  redactObject,
  TinyAgentError,
  type Result,
  type Store,
  type StoreHead,
  type StoreListEntry,
} from "@tinyagent/core";
import {
  serializeDelegation as sdkSerializeDelegation,
  TinyCloudNode,
  type IKVService,
  type PortableDelegation,
  type SignInOptions,
  type TinyCloudNodeConfig,
} from "@tinycloud/node-sdk";

type SdkResult<T> = { ok: true; data: T } | { ok: false; error: SdkError };
type SdkError = {
  code: string;
  message: string;
  service?: string;
  meta?: Record<string, unknown>;
};
type VaultErrorLike = {
  code: string;
  message: string;
  service?: string;
};
type VaultResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: VaultErrorLike };
type VaultSecretBackend = {
  put(
    key: string,
    value: unknown,
    options?: {
      contentType?: string;
      serialize?: (value: unknown) => Uint8Array;
    },
  ): Promise<VaultResult<void>>;
  get<T>(
    key: string,
    options?: {
      raw?: boolean;
      deserialize?: (data: Uint8Array) => T;
    },
  ): Promise<
    VaultResult<{
      value: T;
      metadata: Record<string, string>;
      keyId: string;
    }>
  >;
  list(options?: {
    prefix?: string;
    removePrefix?: boolean;
  }): Promise<VaultResult<string[]>>;
  delete(key: string): Promise<VaultResult<void>>;
};

type SdkHeaders = {
  etag?: string;
  contentLength?: number;
  get(name: string): string | null;
};

type SdkKvResponse<T = unknown> = {
  data: T;
  headers: SdkHeaders;
};

type ByteEnvelope = {
  encoding: "base64";
  bytes: string;
  size: number;
};

export interface TinyCloudPlane {
  readonly store: Store;
  readonly secrets: SecretStore;
}

export interface TinyCloudSdkPlane extends TinyCloudPlane {
  readonly node: TinyCloudNode;
  createDelegation(input: {
    path: string;
    actions: string[];
    delegateDID: string;
    disableSubDelegation?: boolean;
    expiryMs?: number;
    spaceIdOverride?: string;
    includePublicSpace?: boolean;
  }): Promise<PortableDelegation>;
  serializeDelegation(delegation: PortableDelegation): string;
  useDelegation(delegation: PortableDelegation): Promise<TinyCloudSdkPlane>;
}

export interface SecretStore {
  set(name: string, value: Uint8Array): Promise<Result<void>>;
  get(name: string): Promise<Result<Uint8Array>>;
  list(): Promise<Result<string[]>>;
  delete(name: string): Promise<Result<void>>;
}

export interface LocalTinyCloudPlaneOptions {
  rootDir: string;
}

export function createLocalTinyCloudPlane(
  options: LocalTinyCloudPlaneOptions,
): TinyCloudPlane {
  return {
    store: new FileStore(join(options.rootDir, "kv")),
    secrets: new FileSecretStore(join(options.rootDir, "secrets")),
  };
}

export async function signInTinyCloudPlane(
  config: TinyCloudNodeConfig,
  signInOptions?: SignInOptions,
): Promise<TinyCloudSdkPlane> {
  const node = new TinyCloudNode(config);
  await node.signIn(signInOptions);
  return planeFromNode(node);
}

export function planeFromNode(node: TinyCloudNode): TinyCloudSdkPlane {
  return planeFromKv(node, node.kv, new TinyCloudVaultSecretStore(node.vault));
}

export async function renewSession(
  config: TinyCloudNodeConfig,
  signInOptions?: SignInOptions,
): Promise<TinyCloudSdkPlane> {
  return signInTinyCloudPlane(config, signInOptions);
}

export interface RenewableDelegation {
  ownerConfig: TinyCloudNodeConfig;
  grant: {
    path: string;
    actions: string[];
    delegateDID: string;
    disableSubDelegation?: boolean;
    expiryMs?: number;
    spaceIdOverride?: string;
    includePublicSpace?: boolean;
  };
}

export interface RenewedDelegation {
  plane: TinyCloudSdkPlane;
  delegation: PortableDelegation;
}

export async function renewDelegation(
  input: RenewableDelegation,
  delegateNode?: TinyCloudNode,
): Promise<RenewedDelegation> {
  const owner = new TinyCloudNode(input.ownerConfig);
  await owner.signIn();
  const delegate = delegateNode ?? new TinyCloudNode();
  const grant = { ...input.grant, delegateDID: delegate.did };
  const delegation = await owner.createDelegation(grant);
  const access = await delegate.useDelegation(delegation);
  return {
    plane: planeFromKv(delegate, access.kv, new UnsupportedSecretStore()),
    delegation,
  };
}

export class TinyCloudStore implements Store {
  constructor(
    private readonly kv: Pick<
      IKVService,
      "put" | "get" | "head" | "list" | "delete"
    >,
  ) {}

  async put(input: {
    key: string;
    bytes: Uint8Array;
    contentType?: string;
    metadata?: Record<string, string>;
  }): Promise<Result<StoreHead>> {
    const options: { contentType: string; metadata?: Record<string, string> } =
      {
        contentType: "application/json",
      };
    if (input.metadata) options.metadata = input.metadata;
    const result = (await this.kv.put(
      input.key,
      encodeBytes(input.bytes),
      options,
    )) as SdkResult<SdkKvResponse<void>>;
    if (!result.ok) return err(fromSdkError(result.error, { key: input.key }));
    return ok(
      headFromHeaders(
        input.key,
        result.data.headers,
        input.bytes.byteLength,
        input.metadata,
      ),
    );
  }

  async get(key: string): Promise<Result<Uint8Array>> {
    const result = (await this.kv.get<ByteEnvelope | string>(key)) as SdkResult<
      SdkKvResponse<ByteEnvelope | string>
    >;
    if (!result.ok) return err(fromSdkError(result.error, { key }));
    try {
      return ok(decodeBytes(result.data.data));
    } catch (error) {
      return err(toTinyAgentError("TC_STORE_DECODE_FAILED", error, { key }));
    }
  }

  async head(key: string): Promise<Result<StoreHead | null>> {
    const result = (await this.kv.head(key)) as SdkResult<SdkKvResponse<void>>;
    if (!result.ok) {
      if (
        result.error.code === "KV_NOT_FOUND" ||
        result.error.code === "NOT_FOUND"
      ) {
        return ok(null);
      }
      return err(fromSdkError(result.error, { key }));
    }
    return ok(headFromHeaders(key, result.data.headers));
  }

  async list(prefix: string): Promise<Result<StoreListEntry[]>> {
    const result = (await this.kv.list({ prefix })) as SdkResult<{
      keys: string[];
    }>;
    if (!result.ok) return err(fromSdkError(result.error, { prefix }));
    return ok(result.data.keys.map((key) => ({ key, size: 0 })));
  }

  async delete(key: string): Promise<Result<void>> {
    const result = (await this.kv.delete(key)) as SdkResult<void>;
    if (!result.ok) return err(fromSdkError(result.error, { key }));
    return ok(undefined);
  }
}

export class FileStore implements Store {
  constructor(private readonly rootDir: string) {}

  async put(input: {
    key: string;
    bytes: Uint8Array;
    contentType?: string;
    metadata?: Record<string, string>;
  }): Promise<Result<StoreHead>> {
    try {
      const path = this.pathFor(input.key);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, input.bytes, { mode: 0o600 });
      return ok(await this.headFor(input.key, input.bytes, input.metadata));
    } catch (error) {
      return err(
        toTinyAgentError("FILE_STORE_PUT_FAILED", error, { key: input.key }),
      );
    }
  }

  async get(key: string): Promise<Result<Uint8Array>> {
    try {
      return ok(new Uint8Array(await readFile(this.pathFor(key))));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return err(toTinyAgentError("FILE_STORE_NOT_FOUND", error, { key }));
      }
      return err(toTinyAgentError("FILE_STORE_GET_FAILED", error, { key }));
    }
  }

  async head(key: string): Promise<Result<StoreHead | null>> {
    try {
      const path = this.pathFor(key);
      const info = await stat(path).catch(() => null);
      if (!info?.isFile()) return ok(null);
      const bytes = await readFile(path);
      return ok(await this.headFor(key, bytes));
    } catch (error) {
      return err(toTinyAgentError("FILE_STORE_HEAD_FAILED", error, { key }));
    }
  }

  async list(prefix: string): Promise<Result<StoreListEntry[]>> {
    try {
      const entries: StoreListEntry[] = [];
      await this.walk(this.rootDir, async (path) => {
        const key = relative(this.rootDir, path).split("/").join("/");
        if (!key.startsWith(prefix)) return;
        const bytes = await readFile(path);
        entries.push(await this.headFor(key, bytes));
      });
      entries.sort((a, b) => a.key.localeCompare(b.key));
      return ok(entries);
    } catch (error) {
      return err(toTinyAgentError("FILE_STORE_LIST_FAILED", error, { prefix }));
    }
  }

  async delete(key: string): Promise<Result<void>> {
    try {
      await rm(this.pathFor(key), { force: true });
      return ok(undefined);
    } catch (error) {
      return err(toTinyAgentError("FILE_STORE_DELETE_FAILED", error, { key }));
    }
  }

  private pathFor(key: string): string {
    return safeChildPath(this.rootDir, key, "UNSAFE_STORE_KEY", "store key");
  }

  private async headFor(
    key: string,
    bytes: Uint8Array,
    metadata?: Record<string, string>,
  ): Promise<StoreHead> {
    const head: StoreHead = {
      key,
      size: bytes.byteLength,
      etag: createHash("sha256").update(bytes).digest("hex"),
    };
    if (metadata) head.metadata = metadata;
    return head;
  }

  private async walk(
    dir: string,
    visit: (path: string) => Promise<void>,
  ): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true }).catch(
      (error: unknown) => {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
        throw error;
      },
    );
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) await this.walk(path, visit);
      else if (entry.isFile()) await visit(path);
    }
  }
}

export class FileSecretStore implements SecretStore {
  constructor(private readonly rootDir: string) {}

  async set(name: string, value: Uint8Array): Promise<Result<void>> {
    try {
      const path = this.pathFor(name);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, value, { mode: 0o600 });
      return ok(undefined);
    } catch (error) {
      return err(
        toTinyAgentError("SECRET_SET_FAILED", error, redactObject({ name })),
      );
    }
  }

  async get(name: string): Promise<Result<Uint8Array>> {
    try {
      return ok(new Uint8Array(await readFile(this.pathFor(name))));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return err(
          toTinyAgentError("SECRET_NOT_FOUND", error, redactObject({ name })),
        );
      }
      return err(
        toTinyAgentError("SECRET_GET_FAILED", error, redactObject({ name })),
      );
    }
  }

  async list(): Promise<Result<string[]>> {
    try {
      const names: string[] = [];
      await this.walk(this.rootDir, async (path) => {
        names.push(relative(this.rootDir, path).split("/").join("/"));
      });
      names.sort();
      return ok(names);
    } catch (error) {
      return err(toTinyAgentError("SECRET_LIST_FAILED", error));
    }
  }

  async delete(name: string): Promise<Result<void>> {
    try {
      await rm(this.pathFor(name), { force: true });
      return ok(undefined);
    } catch (error) {
      return err(
        toTinyAgentError("SECRET_DELETE_FAILED", error, redactObject({ name })),
      );
    }
  }

  private pathFor(name: string): string {
    return safeChildPath(
      this.rootDir,
      name,
      "UNSAFE_SECRET_NAME",
      "secret name",
    );
  }

  private async walk(
    dir: string,
    visit: (path: string) => Promise<void>,
  ): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true }).catch(
      (error: unknown) => {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
        throw error;
      },
    );
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) await this.walk(path, visit);
      else if (entry.isFile()) await visit(path);
    }
  }
}

export class TinyCloudVaultSecretStore implements SecretStore {
  constructor(
    private readonly vault: VaultSecretBackend,
    private readonly prefix = "tinyagent/secrets/",
  ) {}

  async set(name: string, value: Uint8Array): Promise<Result<void>> {
    try {
      const result = await this.vault.put(this.keyFor(name), value, {
        contentType: "application/octet-stream",
        serialize: (bytes) => bytesToUint8Array(bytes),
      });
      if (!result.ok) return err(fromVaultError(result.error, { name }));
      return ok(undefined);
    } catch (error) {
      return err(
        toTinyAgentError("TC_VAULT_SECRET_SET_FAILED", error, { name }),
      );
    }
  }

  async get(name: string): Promise<Result<Uint8Array>> {
    try {
      const result = await this.vault.get<Uint8Array>(this.keyFor(name), {
        raw: true,
        deserialize: (bytes) => bytes,
      });
      if (!result.ok) return err(fromVaultError(result.error, { name }));
      return ok(bytesToUint8Array(result.data.value));
    } catch (error) {
      return err(
        toTinyAgentError("TC_VAULT_SECRET_GET_FAILED", error, { name }),
      );
    }
  }

  async list(): Promise<Result<string[]>> {
    try {
      const result = await this.vault.list({
        prefix: this.prefix,
        removePrefix: true,
      });
      if (!result.ok) return err(fromVaultError(result.error));
      return ok([...result.data].sort());
    } catch (error) {
      return err(toTinyAgentError("TC_VAULT_SECRET_LIST_FAILED", error));
    }
  }

  async delete(name: string): Promise<Result<void>> {
    try {
      const result = await this.vault.delete(this.keyFor(name));
      if (!result.ok) return err(fromVaultError(result.error, { name }));
      return ok(undefined);
    } catch (error) {
      return err(
        toTinyAgentError("TC_VAULT_SECRET_DELETE_FAILED", error, { name }),
      );
    }
  }

  private keyFor(name: string): string {
    validateSafePath(name, "UNSAFE_SECRET_NAME", "secret name");
    return `${this.prefix}${name}`;
  }
}

class UnsupportedSecretStore implements SecretStore {
  async set(): Promise<Result<void>> {
    return unsupportedSecrets();
  }

  async get(): Promise<Result<Uint8Array>> {
    return unsupportedSecrets();
  }

  async list(): Promise<Result<string[]>> {
    return unsupportedSecrets();
  }

  async delete(): Promise<Result<void>> {
    return unsupportedSecrets();
  }
}

function unsupportedSecrets<T>(): Result<T> {
  return err(
    new TinyAgentError(
      "TC_SECRETS_UNSUPPORTED",
      "TinyCloud vault secrets are unavailable on delegated KV-only planes",
    ),
  );
}

function safeChildPath(
  rootDir: string,
  child: string,
  code: string,
  label: string,
): string {
  validateSafePath(child, code, label);
  const root = resolve(rootDir);
  const path = resolve(root, ...child.split(/[\\/]+/));
  if (path !== root && !path.startsWith(`${root}${sep}`)) {
    throw new TinyAgentError(code, `unsafe ${label}: ${child}`);
  }
  return path;
}

function validateSafePath(child: string, code: string, label: string): void {
  const parts = child.split(/[\\/]+/);
  if (
    child.length === 0 ||
    child.startsWith("/") ||
    parts.some((part) => part.length === 0 || part === "." || part === "..")
  ) {
    throw new TinyAgentError(code, `unsafe ${label}: ${child}`);
  }
}

function planeFromKv(
  node: TinyCloudNode,
  kv: IKVService,
  secrets: SecretStore,
): TinyCloudSdkPlane {
  return {
    node,
    store: new TinyCloudStore(kv),
    secrets,
    createDelegation: (input) => node.createDelegation(input),
    serializeDelegation: (delegation) => sdkSerializeDelegation(delegation),
    useDelegation: async (delegation) =>
      planeFromKv(
        node,
        (await node.useDelegation(delegation)).kv,
        new UnsupportedSecretStore(),
      ),
  };
}

function encodeBytes(bytes: Uint8Array): ByteEnvelope {
  return {
    encoding: "base64",
    bytes: Buffer.from(bytes).toString("base64"),
    size: bytes.byteLength,
  };
}

function decodeBytes(value: ByteEnvelope | string): Uint8Array {
  const envelope: ByteEnvelope =
    typeof value === "string" ? parseEnvelope(value) : value;
  if (envelope.encoding !== "base64") {
    throw new TinyAgentError(
      "TC_STORE_BAD_ENCODING",
      `unsupported byte encoding: ${String(envelope.encoding)}`,
    );
  }
  return new Uint8Array(Buffer.from(envelope.bytes, "base64"));
}

function parseEnvelope(value: string): ByteEnvelope {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch (error) {
    throw new TinyAgentError(
      "TC_STORE_BAD_ENCODING",
      `value is not a byte envelope: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !("encoding" in parsed) ||
    !("bytes" in parsed)
  ) {
    throw new TinyAgentError(
      "TC_STORE_BAD_ENCODING",
      "value is not a byte envelope",
    );
  }
  return parsed as ByteEnvelope;
}

function headFromHeaders(
  key: string,
  headers: SdkHeaders,
  size = headers.contentLength ?? Number(headers.get("content-length") ?? 0),
  metadata?: Record<string, string>,
): StoreHead {
  const head: StoreHead = {
    key,
    size,
  };
  const etag = headers.etag ?? headers.get("etag");
  if (etag) head.etag = etag;
  if (metadata) head.metadata = metadata;
  return head;
}

function fromSdkError(error: SdkError, details?: unknown): TinyAgentError {
  return new TinyAgentError(mapSdkErrorCode(error), error.message, {
    service: error.service,
    sdkCode: error.code,
    meta: error.meta,
    details,
  });
}

function mapSdkErrorCode(error: SdkError): string {
  const code = error.code;
  const normalized = code.toUpperCase().replace(/[^A-Z0-9]+/g, "_");
  const meta = error.meta ?? {};
  const status =
    typeof meta.status === "number"
      ? meta.status
      : typeof meta.statusCode === "number"
        ? meta.statusCode
        : undefined;
  const text = `${error.message} ${JSON.stringify(meta)}`.toUpperCase();
  if (
    status === 413 ||
    text.includes("PAYLOAD TOO LARGE") ||
    text.includes("PAYLOAD_TOO_LARGE") ||
    text.includes("OBJECT TOO LARGE") ||
    text.includes("OBJECT_TOO_LARGE") ||
    text.includes("WRITE EXCEEDS REMAINING STORAGE")
  ) {
    return "TC_STORE_OBJECT_TOO_LARGE";
  }
  if (
    status === 402 ||
    text.includes("STORAGE QUOTA EXCEEDED") ||
    text.includes("QUOTA EXCEEDED")
  ) {
    return "TC_STORE_QUOTA_EXCEEDED";
  }
  if (
    normalized.includes("QUOTA") ||
    normalized === "STORAGE_LIMIT_REACHED" ||
    normalized === "STORAGE_LIMIT_EXCEEDED" ||
    normalized === "LIMIT_REACHED" ||
    normalized === "LIMIT_EXCEEDED"
  ) {
    return "TC_STORE_QUOTA_EXCEEDED";
  }
  if (
    normalized.includes("TOO_LARGE") ||
    normalized.includes("PAYLOAD_TOO_LARGE") ||
    normalized.includes("OBJECT_TOO_LARGE") ||
    normalized === "ENTITY_TOO_LARGE"
  ) {
    return "TC_STORE_OBJECT_TOO_LARGE";
  }
  return `TC_${code}`;
}

function fromVaultError(
  error: VaultErrorLike,
  details?: unknown,
): TinyAgentError {
  return new TinyAgentError(`TC_VAULT_${error.code}`, error.message, {
    service: error.service,
    details,
  });
}

function toTinyAgentError(
  code: string,
  error: unknown,
  details?: unknown,
): TinyAgentError {
  if (error instanceof TinyAgentError) return error;
  return new TinyAgentError(
    code,
    error instanceof Error ? error.message : String(error),
    details,
  );
}

function bytesToUint8Array(value: unknown): Uint8Array {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (Array.isArray(value) && value.every((item) => Number.isInteger(item))) {
    return new Uint8Array(value);
  }
  throw new TinyAgentError(
    "TC_VAULT_SECRET_BAD_ENCODING",
    "vault secret value is not raw bytes",
  );
}
