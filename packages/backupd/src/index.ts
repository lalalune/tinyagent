import { backupDirectory, type BackupInput } from "@tinyagent/backup";
import type {
  BackupManifest,
  BackupdCommand,
  BackupdStatus,
  Store,
} from "@tinyagent/core";
import { BackupdCommandSchema } from "@tinyagent/core";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";

export interface BackupdControlApi {
  handle(command: BackupdCommand): Promise<BackupdStatus>;
}

export interface BackupdLoopbackServer {
  readonly url: string;
  readonly server: Server;
  close(): Promise<void>;
}

export interface BackupdControllerOptions
  extends Omit<BackupInput, "runnerImageDigest"> {
  intervalMs?: number;
  runnerImageDigest?: string;
  backup?: (input: BackupInput) => Promise<BackupRunResult>;
  renewDelegation?: () => Promise<BackupdRenewDelegationResult>;
  now?: () => Date;
  setInterval?: (callback: () => void, ms: number) => TimerHandle;
  clearInterval?: (handle: TimerHandle) => void;
}

export type BackupRunResult =
  | { ok: true; value: BackupManifest }
  | { ok: false; error: Error };
export type BackupdRenewDelegationResult =
  | { ok: true; store?: Store }
  | { ok: false; error: Error };

type TimerHandle = ReturnType<typeof setInterval>;

export class BackupdController implements BackupdControlApi {
  private state: BackupdStatus["state"] = "idle";
  private lastBackupAt: string | undefined;
  private nextBackupAt: string | undefined;
  private error: string | undefined;
  private timer: TimerHandle | undefined;
  private running: Promise<BackupdStatus> | undefined;
  private activeStore: Store;

  constructor(private readonly options: BackupdControllerOptions) {
    this.activeStore = options.store;
  }

  start(): BackupdStatus {
    if (this.options.intervalMs === undefined) return this.status();
    if (this.timer !== undefined) return this.status();

    const setTimer = this.options.setInterval ?? setInterval;
    this.timer = setTimer(() => {
      void this.runBackup();
    }, this.options.intervalMs);
    this.scheduleNext();
    return this.status();
  }

  stop(): BackupdStatus {
    if (this.timer !== undefined) {
      const clearTimer = this.options.clearInterval ?? clearInterval;
      clearTimer(this.timer);
      this.timer = undefined;
    }
    this.nextBackupAt = undefined;
    return this.status();
  }

  async handle(command: BackupdCommand): Promise<BackupdStatus> {
    switch (command.type) {
      case "backupNow":
        return this.runBackup();
      case "status":
        return this.status();
      case "prepareRestore":
        return this.prepareRestore(command.version);
      case "renewDelegation":
        return this.renewDelegation();
    }
  }

  status(): BackupdStatus {
    const status: BackupdStatus = {
      agent: this.options.agent,
      state: this.state,
    };
    if (this.lastBackupAt !== undefined)
      status.lastBackupAt = this.lastBackupAt;
    if (this.nextBackupAt !== undefined)
      status.nextBackupAt = this.nextBackupAt;
    if (this.error !== undefined) status.error = this.error;
    return status;
  }

  private async runBackup(): Promise<BackupdStatus> {
    if (this.running !== undefined) return this.running;

    this.state = "running";
    this.error = undefined;
    this.running = this.backupOnce().finally(() => {
      this.running = undefined;
    });
    return this.running;
  }

  private async backupOnce(): Promise<BackupdStatus> {
    const backup = this.options.backup ?? backupDirectory;
    const input: BackupInput = {
      store: this.activeStore,
      agent: this.options.agent,
      pack: this.options.pack,
      stateDir: this.options.stateDir,
      bpkId: this.options.bpkId,
      backupPublicKey: this.options.backupPublicKey,
    };
    if (this.options.chunkSize !== undefined) {
      input.chunkSize = this.options.chunkSize;
    }
    if (this.options.runnerImageDigest !== undefined) {
      input.runnerImageDigest = this.options.runnerImageDigest;
    }
    let result = await backup(input);

    if (
      !result.ok &&
      shouldRenewAfterBackupError(result.error) &&
      this.options.renewDelegation !== undefined
    ) {
      const renewed = await this.options.renewDelegation();
      if (!renewed.ok) return this.fail(renewed.error.message);
      if (renewed.store !== undefined) {
        this.activeStore = renewed.store;
      }
      result = await backup({ ...input, store: this.activeStore });
    }

    if (!result.ok) {
      return this.fail(result.error.message);
    }

    this.lastBackupAt = result.value.timestamp;
    this.state = "idle";
    this.error = undefined;
    this.scheduleNext();
    return this.status();
  }

  private prepareRestore(version: string): BackupdStatus {
    this.state = "restoring";
    this.error = `restore prepared for snapshot ${version}`;
    return this.status();
  }

  private async renewDelegation(): Promise<BackupdStatus> {
    if (this.options.renewDelegation === undefined) {
      return this.fail("DELEGATION_RENEWAL_NOT_CONFIGURED");
    }
    this.state = "running";
    this.error = undefined;
    const result = await this.options.renewDelegation();
    if (!result.ok) return this.fail(result.error.message);
    if (result.store !== undefined) {
      this.activeStore = result.store;
    }
    this.state = "idle";
    this.error = undefined;
    this.scheduleNext();
    return this.status();
  }

  private fail(error: string): BackupdStatus {
    this.state = "error";
    this.error = error;
    this.scheduleNext();
    return this.status();
  }

  private scheduleNext(): void {
    if (this.options.intervalMs === undefined || this.timer === undefined) {
      this.nextBackupAt = undefined;
      return;
    }
    const now = this.options.now ?? (() => new Date());
    this.nextBackupAt = new Date(
      now().getTime() + this.options.intervalMs,
    ).toISOString();
  }
}

export async function startBackupdLoopbackServer(
  api: BackupdControlApi,
  options: { port?: number; host?: "127.0.0.1" | "::1" } = {},
): Promise<BackupdLoopbackServer> {
  const host = options.host ?? "127.0.0.1";
  const server = createServer((request, response) => {
    void handleBackupdHttpRequest(api, request, response);
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 0, host, () => {
      server.off("error", reject);
      resolve();
    });
  });

  const address = server.address();
  if (typeof address === "string" || address === null) {
    await closeServer(server);
    throw new Error("backupd loopback server did not bind to a TCP address");
  }
  const hostname = address.address === "::1" ? "[::1]" : address.address;
  return {
    url: `http://${hostname}:${address.port}`,
    server,
    close: async () => closeServer(server),
  };
}

export async function handleBackupdHttpRequest(
  api: BackupdControlApi,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  if (!isLoopbackAddress(request.socket.remoteAddress)) {
    writeJson(response, 403, {
      ok: false,
      error: "backupd control API only accepts loopback clients",
    });
    return;
  }

  try {
    if (request.method === "GET" && request.url === "/status") {
      const status = await api.handle({ type: "status" });
      writeJson(response, 200, { ok: true, status });
      return;
    }

    if (request.method === "POST" && request.url === "/control") {
      const body = await readJsonBody(request);
      const parsed = BackupdCommandSchema.safeParse(body);
      if (!parsed.success) {
        writeJson(response, 400, {
          ok: false,
          error: "invalid backupd command",
        });
        return;
      }
      const status = await api.handle(parsed.data);
      writeJson(response, 200, { ok: true, status });
      return;
    }

    writeJson(response, 404, { ok: false, error: "not found" });
  } catch (error) {
    writeJson(response, 400, {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

export function isLoopbackAddress(address: string | undefined): boolean {
  return (
    address === "127.0.0.1" ||
    address === "::1" ||
    address === "::ffff:127.0.0.1"
  );
}

function shouldRenewAfterBackupError(error: Error): boolean {
  const code =
    "code" in error && typeof error.code === "string" ? error.code : "";
  const text = `${code} ${error.message}`.toLowerCase();
  return (
    text.includes("delegation") ||
    text.includes("session") ||
    text.includes("expired") ||
    text.includes("unauthorized") ||
    text.includes("forbidden") ||
    text.includes("permission")
  );
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  let body = "";
  request.setEncoding("utf8");
  for await (const chunk of request) {
    body += chunk;
    if (body.length > 1_000_000) {
      throw new Error("request body too large");
    }
  }
  if (body.length === 0) return {};
  return JSON.parse(body) as unknown;
}

function writeJson(
  response: ServerResponse,
  status: number,
  body: unknown,
): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}
