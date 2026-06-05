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

export interface ComputeProvider {
  readonly kind: SandboxSpec["provider"];
  provision(spec: SandboxSpec): Promise<Sandbox>;
  start(sandbox: Sandbox): Promise<void>;
  stop(sandbox: Sandbox): Promise<void>;
  destroy(sandbox: Sandbox): Promise<void>;
  exec(sandbox: Sandbox, command: ExecSpec): AsyncIterable<ExecChunk>;
  putFiles(sandbox: Sandbox, files: FileSpec[]): Promise<void>;
  getFiles(sandbox: Sandbox, paths: string[]): Promise<FileBlob[]>;
  forwardPort(
    sandbox: Sandbox,
    remotePort: number,
    localPort: number,
  ): Promise<Tunnel>;
  attest(sandbox: Sandbox, nonce: Uint8Array): Promise<AttestationDoc | null>;
}

export interface ProviderConformanceOptions {
  provider: ComputeProvider;
  sandbox: SandboxSpec;
  remotePort: number;
}
