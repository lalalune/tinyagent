/**
 * Shared types for the TinyAgent control-plane API.
 *
 * These mirror the backend contract (see the monorepo's @tinyagent/core
 * `PackRecord`, `DeployedAgent`, `AttestationDoc` and @tinyagent/billing
 * `Quote`). The fields here are the public subset the web console consumes.
 */

export type ProviderKind = "local-docker" | "dstack-cvm" | "lightning";

export type ModelMode =
  | "bedrock"
  | "api-key"
  | "litellm"
  | "openai"
  | "kiro-cloud";

export interface ResourceSize {
  vcpu: number;
  memMiB: number;
  diskGiB: number;
}

export interface PackNeeds {
  docker?: boolean;
  postgres?: boolean;
  gpu?: boolean;
  systemdUser?: boolean;
  interactiveLogin?: boolean;
}

/** A pack the operator can deploy (lowkey registry entry + augmented metadata). */
export interface PackRecord {
  name: string;
  type: "base" | "agent";
  description?: string;
  brain: boolean;
  ports: Record<string, number>;
  dataVolumeGiB: number;
  defaultModel?: string;
  runtime: string;
  needs: PackNeeds;
  modelModes: string[];
  language: string;
}

/** A deployed agent instance owned by the signed-in wallet. */
export interface DeployedAgent {
  name: string;
  pack: string;
  provider: ProviderKind;
  sandboxId: string;
  spaceId: string;
  agentDid: string;
  stateDir: string;
  runnerImage: string;
  composeHash?: string;
  modelMode: string;
  gatewayPort?: number;
  createdAt: string;
}

/** TDX attestation document; `mode: "none"` for non-TEE providers. */
export interface AttestationDoc {
  mode: "dstack" | "none";
  quote?: string;
  eventLog?: string;
  composeHash?: string;
  appId?: string;
  instanceId?: string;
  timestamp?: string;
  message?: string;
}

export interface AgentStatus {
  agent: DeployedAgent;
  status: string;
  endpoint?: string;
  lastBackupAt?: string;
  snapshotBytes?: number;
  attestation: AttestationDoc | null;
}

export interface BackupResult {
  chunks: number;
  totalBytes: number;
  integrity: string;
  createdAt: string;
}

export interface DeployAgentInput {
  name: string;
  pack: string;
  provider: ProviderKind;
  modelMode: string;
  model?: string;
}

/** Billing quote: Phala cost, the +20% markup, and the user-facing price. */
export interface BillingQuote {
  hours: number;
  resources: ResourceSize;
  phalaCostUsd: number;
  markup: number;
  priceUsd: number;
  marginUsd: number;
}

/** On-chain billing config — escrow + ERC20 addresses. */
export interface BillingConfig {
  chainId: number;
  token: string;
  contract: string;
  decimals: number;
}

export interface BillingBalance {
  /** prepaid escrow balance as a bigint string (token base units). */
  balanceUnits: string;
}

export interface MeResponse {
  address: string;
}
