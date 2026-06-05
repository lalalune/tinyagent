import { z } from "zod";

export const ProviderKindSchema = z.enum([
  "local-docker",
  "dstack-cvm",
  "lightning",
]);
export type ProviderKind = z.infer<typeof ProviderKindSchema>;

export const PortSpecSchema = z.object({
  name: z.string().min(1),
  port: z.number().int().positive(),
  hostPort: z.number().int().positive().optional(),
  protocol: z.enum(["tcp", "udp"]).default("tcp"),
});
export type PortSpec = z.infer<typeof PortSpecSchema>;

export const SecretTargetSchema = z.object({
  name: z.string().min(1),
  env: z.string().min(1).optional(),
  file: z.string().min(1).optional(),
  mode: z
    .string()
    .regex(/^[0-7]{3,4}$/)
    .default("0600"),
});
export type SecretTarget = z.infer<typeof SecretTargetSchema>;

export const AgentSpecSchema = z.object({
  name: z.string().min(1),
  version: z.string().min(1).optional(),
  dependencies: z.array(z.string().min(1)).default([]),
  ports: z.array(PortSpecSchema).default([]),
  stateDirs: z.array(z.string().min(1)).default([]),
  dataVolumeGb: z.number().nonnegative().optional(),
  modelModes: z.array(z.string().min(1)).default([]),
  secretTargets: z.array(SecretTargetSchema).default([]),
  headlessCaveats: z.array(z.string().min(1)).default([]),
  brain: z.boolean().default(false),
});
export type AgentSpec = z.infer<typeof AgentSpecSchema>;

export const SandboxSpecSchema = z.object({
  name: z.string().min(1),
  provider: ProviderKindSchema,
  agent: AgentSpecSchema,
  image: z.string().min(1),
  imageDigest: z.string().min(1).optional(),
  environment: z.record(z.string()).default({}),
  mounts: z
    .array(
      z.object({
        source: z.string().min(1),
        target: z.string().min(1),
        readonly: z.boolean().default(false),
      }),
    )
    .default([]),
  labels: z.record(z.string()).default({}),
  expectedComposeHash: z.string().min(1).optional(),
});
export type SandboxSpec = z.infer<typeof SandboxSpecSchema>;

export const SandboxSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  provider: ProviderKindSchema,
  status: z.enum(["provisioned", "running", "stopped", "destroyed", "unknown"]),
  metadata: z.record(z.unknown()).default({}),
});
export type Sandbox = z.infer<typeof SandboxSchema>;

export const ExecSpecSchema = z.object({
  command: z.array(z.string().min(1)).min(1),
  cwd: z.string().min(1).optional(),
  env: z.record(z.string()).default({}),
  timeoutMs: z.number().int().positive().optional(),
});
export type ExecSpec = z.infer<typeof ExecSpecSchema>;

export const ExecChunkSchema = z.object({
  stream: z.enum(["stdout", "stderr", "exit"]),
  data: z.instanceof(Uint8Array).optional(),
  exitCode: z.number().int().optional(),
  timedOut: z.boolean().optional(),
  timeoutMs: z.number().int().positive().optional(),
});
export type ExecChunk = z.infer<typeof ExecChunkSchema>;

export const FileSpecSchema = z.object({
  path: z.string().min(1),
  content: z.instanceof(Uint8Array),
  mode: z
    .string()
    .regex(/^[0-7]{3,4}$/)
    .optional(),
});
export type FileSpec = z.infer<typeof FileSpecSchema>;

export const FileBlobSchema = z.object({
  path: z.string().min(1),
  content: z.instanceof(Uint8Array),
});
export type FileBlob = z.infer<typeof FileBlobSchema>;

export const TunnelSchema = z.object({
  id: z.string().min(1),
  localPort: z.number().int().positive(),
  remotePort: z.number().int().positive(),
  close: z.function().returns(z.promise(z.void())),
});
export type Tunnel = z.infer<typeof TunnelSchema>;

export const AttestationDocSchema = z.object({
  provider: z.literal("dstack-cvm"),
  quote: z.string().min(1),
  eventLog: z.unknown().optional(),
  composeHash: z.string().min(1),
  appId: z.string().min(1).optional(),
  timestamp: z.string().datetime(),
  nonce: z.string().min(1).optional(),
  reportData: z.string().min(1).optional(),
});
export type AttestationDoc = z.infer<typeof AttestationDocSchema>;

export const BackupChunkSchema = z.object({
  hash: z.string().min(1),
  length: z.number().int().nonnegative(),
  cipherLength: z.number().int().nonnegative().optional(),
  nonce: z.string().min(1),
});
export type BackupChunk = z.infer<typeof BackupChunkSchema>;

export const SealedContentKeySchema = z.object({
  version: z.literal(1),
  algorithm: z.literal("x25519-xsalsa20-poly1305-sealedbox"),
  ciphertext: z.string().min(1),
  backupPublicKeyId: z.string().min(1).optional(),
});
export type SealedContentKey = z.infer<typeof SealedContentKeySchema>;
export type SealedKey = SealedContentKey;

export const BackupManifestSchema = z.object({
  version: z.literal(1),
  agent: z.string().min(1),
  pack: z.string().min(1),
  timestamp: z.string().datetime(),
  stateDir: z.string().min(1),
  chunks: z.array(BackupChunkSchema),
  sealedContentKey: SealedContentKeySchema,
  backupPublicKeyId: z.string().min(1),
  integrity: z.object({
    algorithm: z.literal("blake3"),
    digest: z.string().min(1),
    totalPlaintextBytes: z.number().int().nonnegative().optional(),
  }),
  runnerImageDigest: z.string().min(1),
  metadata: z.record(z.unknown()).default({}),
});
export type BackupManifest = z.infer<typeof BackupManifestSchema>;
export const backupManifestSchema = BackupManifestSchema;

export const ChunkEnvelopeSchema = z.object({
  version: z.literal(1),
  algorithm: z.literal("xchacha20-poly1305"),
  nonce: z.string().min(1),
  ciphertext: z.instanceof(Uint8Array),
});
export type ChunkEnvelope = z.infer<typeof ChunkEnvelopeSchema>;

export const BackupdCommandSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("backupNow") }),
  z.object({ type: z.literal("status") }),
  z.object({ type: z.literal("prepareRestore"), version: z.string().min(1) }),
  z.object({ type: z.literal("renewDelegation") }),
]);
export type BackupdCommand = z.infer<typeof BackupdCommandSchema>;

export const BackupdStatusSchema = z.object({
  agent: z.string().min(1),
  lastBackupAt: z.string().datetime().optional(),
  nextBackupAt: z.string().datetime().optional(),
  state: z.enum(["idle", "running", "restoring", "error"]),
  error: z.string().optional(),
});
export type BackupdStatus = z.infer<typeof BackupdStatusSchema>;

export function backupKvPaths(agent: string): {
  chunksPrefix: string;
  snapshotsPrefix: string;
  latest: string;
  meta: string;
} {
  return {
    chunksPrefix: `tinyagent/${agent}/chunks/`,
    snapshotsPrefix: `tinyagent/${agent}/snapshots/`,
    latest: `tinyagent/${agent}/latest`,
    meta: `tinyagent/${agent}/meta.json`,
  };
}
