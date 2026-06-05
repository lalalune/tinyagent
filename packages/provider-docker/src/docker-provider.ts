import { createConnection, createServer } from "node:net";
import { Readable } from "node:stream";
import Docker from "dockerode";
import getPort from "get-port";
import tar from "tar-stream";
import {
  redactObject,
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

export class DockerProvider implements ComputeProvider {
  readonly kind = "local-docker" as const;
  private readonly docker: Docker;

  constructor(docker = new Docker()) {
    this.docker = docker;
  }

  async provision(spec: SandboxSpec): Promise<Sandbox> {
    try {
      const exposedPorts: Record<string, Record<string, never>> = {};
      const portBindings: Record<string, Array<{ HostPort: string }>> = {};
      for (const port of spec.agent.ports) {
        const key = `${port.port}/tcp`;
        const hostPort = await getPort();
        exposedPorts[key] = {};
        portBindings[key] = [{ HostPort: String(hostPort) }];
      }

      const container = await this.docker.createContainer({
        Image: spec.image,
        name: spec.name,
        Env: Object.entries(spec.environment).map(
          ([key, value]) => `${key}=${value}`,
        ),
        Labels: spec.labels,
        ExposedPorts: exposedPorts,
        HostConfig: {
          AutoRemove: false,
          PortBindings: portBindings,
          Binds: (spec.mounts ?? []).map(
            (mount) =>
              `${mount.source}:${mount.target}${mount.readonly ? ":ro" : ""}`,
          ),
        },
      });
      return {
        id: container.id,
        name: spec.name,
        provider: this.kind,
        status: "provisioned",
        metadata: Object.fromEntries(
          Object.entries(portBindings).map(([key, binding]) => [
            `port:${key}`,
            binding[0]?.HostPort ?? "",
          ]),
        ),
      };
    } catch (error) {
      throw wrapDockerError("DOCKER_PROVISION_FAILED", error);
    }
  }

  async start(sandbox: Sandbox): Promise<void> {
    try {
      await this.docker.getContainer(sandbox.id).start();
      sandbox.status = "running";
    } catch (error) {
      throw wrapDockerError("DOCKER_START_FAILED", error);
    }
  }

  async stop(sandbox: Sandbox): Promise<void> {
    try {
      await this.docker.getContainer(sandbox.id).stop();
      sandbox.status = "stopped";
    } catch (error) {
      throw wrapDockerError("DOCKER_STOP_FAILED", error);
    }
  }

  async destroy(sandbox: Sandbox): Promise<void> {
    try {
      const container = this.docker.getContainer(sandbox.id);
      await container.remove({ force: true });
      sandbox.status = "destroyed";
    } catch (error) {
      throw wrapDockerError("DOCKER_DESTROY_FAILED", error);
    }
  }

  async *exec(sandbox: Sandbox, command: ExecSpec): AsyncIterable<ExecChunk> {
    try {
      const container = this.docker.getContainer(sandbox.id);
      const exec = await container.exec({
        Cmd: command.command,
        WorkingDir: command.cwd,
        Env: Object.entries(command.env).map(
          ([key, value]) => `${key}=${value}`,
        ),
        AttachStdout: true,
        AttachStderr: true,
      });
      const started = await startDockerExec(exec);
      if (started.kind === "captured-output") {
        const inspected = await exec.inspect();
        if (started.stdout.length > 0)
          yield {
            stream: "stdout",
            data: new TextEncoder().encode(started.stdout),
          };
        yield { stream: "exit", exitCode: inspected.ExitCode ?? 0 };
        return;
      }
      const stream = started.stream;
      const chunks: Buffer[] = [];
      let timedOut = false;
      let timeout: ReturnType<typeof setTimeout> | undefined;
      await new Promise<void>((resolve, reject) => {
        if (command.timeoutMs !== undefined) {
          timeout = setTimeout(() => {
            timedOut = true;
            void container
              .kill()
              .catch(() => undefined)
              .finally(resolve);
          }, command.timeoutMs);
        }
        stream.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
        stream.on("end", resolve);
        stream.on("error", reject);
      });
      if (timeout !== undefined) clearTimeout(timeout);
      if (timedOut) {
        yield {
          stream: "exit",
          exitCode: 124,
          timedOut: true,
          timeoutMs: command.timeoutMs,
        };
        return;
      }
      const inspected = await exec.inspect();
      const demuxed = demuxDockerStdout(Buffer.concat(chunks));
      if (demuxed.stdout.length > 0)
        yield {
          stream: "stdout",
          data: new TextEncoder().encode(demuxed.stdout),
        };
      if (demuxed.stderr.length > 0)
        yield {
          stream: "stderr",
          data: new TextEncoder().encode(demuxed.stderr),
        };
      yield { stream: "exit", exitCode: inspected.ExitCode ?? 0 };
    } catch (error) {
      throw wrapDockerError("DOCKER_EXEC_FAILED", error);
    }
  }

  async putFiles(sandbox: Sandbox, files: FileSpec[]): Promise<void> {
    try {
      const container = this.docker.getContainer(sandbox.id);
      for (const file of files) {
        const pack = tar.pack();
        pack.entry(
          {
            name: file.path.replace(/^\/+/, ""),
            mode: Number.parseInt(file.mode ?? "0600", 8),
          },
          Buffer.from(file.content),
        );
        pack.finalize();
        await container.putArchive(pack, { path: "/" });
      }
    } catch (error) {
      throw wrapDockerError("DOCKER_PUT_FILES_FAILED", error);
    }
  }

  async getFiles(sandbox: Sandbox, paths: string[]): Promise<FileBlob[]> {
    try {
      const container = this.docker.getContainer(sandbox.id);
      const out: FileBlob[] = [];
      for (const path of paths) {
        const stream = await container.getArchive({ path });
        out.push({ path, content: await firstFileFromTar(stream) });
      }
      return out;
    } catch (error) {
      throw wrapDockerError("DOCKER_GET_FILES_FAILED", error);
    }
  }

  async forwardPort(
    sandbox: Sandbox,
    remotePort: number,
    localPort: number,
  ): Promise<Tunnel> {
    try {
      const target = await this.resolveForwardTarget(sandbox, remotePort);

      // Local TCP proxy: accept connections on localPort and pipe each one
      // bidirectionally to the container service. This is a real, active
      // forward — bytes written to the local port reach the container, and
      // responses flow back.
      const sockets = new Set<ReturnType<typeof createConnection>>();
      const server = createServer((local) => {
        sockets.add(local);
        const upstream = createConnection(
          { host: target.host, port: target.port },
          () => {
            local.pipe(upstream);
            upstream.pipe(local);
          },
        );
        sockets.add(upstream);
        const cleanup = () => {
          sockets.delete(local);
          sockets.delete(upstream);
        };
        const teardown = () => {
          local.destroy();
          upstream.destroy();
          cleanup();
        };
        local.on("error", teardown);
        upstream.on("error", teardown);
        local.on("close", () => {
          upstream.destroy();
          cleanup();
        });
        upstream.on("close", () => {
          local.destroy();
          cleanup();
        });
      });

      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        // localPort 0 lets the OS pick an ephemeral free port.
        server.listen({ host: "127.0.0.1", port: localPort }, () => {
          server.removeListener("error", reject);
          resolve();
        });
      });

      const address = server.address();
      const boundPort =
        typeof address === "object" && address !== null
          ? address.port
          : localPort;

      return {
        id: `${sandbox.id}:${remotePort}`,
        localPort: boundPort,
        remotePort,
        async close() {
          for (const socket of sockets) socket.destroy();
          sockets.clear();
          await new Promise<void>((resolve) => {
            server.close(() => resolve());
          });
        },
      };
    } catch (error) {
      throw wrapDockerError("DOCKER_FORWARD_PORT_FAILED", error);
    }
  }

  /**
   * Resolve where the local proxy should connect to reach `remotePort` inside
   * the container. Prefers a published host port binding (reachable on
   * 127.0.0.1); falls back to the container's bridge-network IP address.
   */
  private async resolveForwardTarget(
    sandbox: Sandbox,
    remotePort: number,
  ): Promise<{ host: string; port: number }> {
    const container = this.docker.getContainer(sandbox.id);
    const info = await container.inspect();
    const key = `${remotePort}/tcp`;

    const bindings = info.NetworkSettings?.Ports?.[key];
    const published = bindings?.find((b) => b.HostPort)?.HostPort;
    if (published) {
      return { host: "127.0.0.1", port: Number(published) };
    }

    const networks = info.NetworkSettings?.Networks ?? {};
    for (const net of Object.values(networks)) {
      if (net?.IPAddress) {
        return { host: net.IPAddress, port: remotePort };
      }
    }
    const fallbackIp = info.NetworkSettings?.IPAddress;
    if (fallbackIp) {
      return { host: fallbackIp, port: remotePort };
    }

    throw new TinyAgentError(
      "DOCKER_FORWARD_PORT_NO_TARGET",
      `cannot determine forward target for port ${remotePort}: container is not publishing the port and has no reachable IP address`,
    );
  }

  async attest(
    _sandbox: Sandbox,
    _nonce: Uint8Array,
  ): Promise<AttestationDoc | null> {
    return null;
  }
}

type DockerExecHandle = {
  start(
    options: { hijack: boolean; stdin: boolean },
    callback: (
      error: Error | null | undefined,
      outputStream?: NodeJS.ReadableStream,
    ) => void,
  ): void;
};

type StartedDockerExec =
  | { kind: "stream"; stream: NodeJS.ReadableStream }
  | { kind: "captured-output"; stdout: string };

async function startDockerExec(
  exec: DockerExecHandle,
): Promise<StartedDockerExec> {
  try {
    const stream = await new Promise<NodeJS.ReadableStream>(
      (resolve, reject) => {
        exec.start({ hijack: true, stdin: false }, (error, outputStream) => {
          if (error != null) {
            reject(error);
            return;
          }
          if (outputStream === undefined) {
            reject(new Error("Docker exec did not return a stream"));
            return;
          }
          resolve(outputStream);
        });
      },
    );
    return { kind: "stream", stream };
  } catch (error) {
    const stdout = bunHijackUpgradeOutput(error);
    if (stdout !== undefined) return { kind: "captured-output", stdout };
    throw error;
  }
}

function bunHijackUpgradeOutput(error: unknown): string | undefined {
  const message = error instanceof Error ? error.message : String(error);
  if (!message.includes("HTTP code 101")) return undefined;
  const marker = "unexpected - ";
  const index = message.indexOf(marker);
  if (index < 0) return undefined;
  return message
    .slice(index + marker.length)
    .split("")
    .filter((char) => {
      const code = char.charCodeAt(0);
      return code >= 0x20 || code === 0x09 || code === 0x0a || code === 0x0d;
    })
    .join("")
    .replaceAll("\ufffd", "");
}

function wrapDockerError(code: string, error: unknown): TinyAgentError {
  return new TinyAgentError(
    code,
    error instanceof Error ? error.message : String(error),
    redactObject({
      docker: serializeError(error),
    }),
  );
}

function serializeError(error: unknown): unknown {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      ...("code" in error ? { code: error.code } : {}),
    };
  }
  return error;
}

function demuxDockerStdout(buffer: Buffer): { stdout: string; stderr: string } {
  let offset = 0;
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  while (offset + 8 <= buffer.length) {
    const streamType = buffer[offset];
    const length = buffer.readUInt32BE(offset + 4);
    const payload = buffer.subarray(offset + 8, offset + 8 + length);
    if (streamType === 2) stderr.push(payload);
    else stdout.push(payload);
    offset += 8 + length;
  }
  if (offset === 0) stdout.push(buffer);
  return {
    stdout: Buffer.concat(stdout).toString("utf8"),
    stderr: Buffer.concat(stderr).toString("utf8"),
  };
}

async function firstFileFromTar(
  stream: NodeJS.ReadableStream,
): Promise<Uint8Array<ArrayBuffer>> {
  const extract = tar.extract();
  const chunks: Buffer[] = [];
  const done = new Promise<Uint8Array>((resolve, reject) => {
    extract.on("entry", (_header, entry, next) => {
      entry.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      entry.on("end", () => {
        next();
        const data = Buffer.concat(chunks);
        const buffer = data.buffer.slice(
          data.byteOffset,
          data.byteOffset + data.byteLength,
        ) as ArrayBuffer;
        const output: Uint8Array<ArrayBuffer> = new Uint8Array(buffer);
        resolve(output);
      });
      entry.resume();
    });
    extract.on("error", reject);
  });
  Readable.from(stream).pipe(extract);
  return (await done) as Uint8Array<ArrayBuffer>;
}
