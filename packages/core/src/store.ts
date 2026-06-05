import type { Result } from "./result.js";

export interface StoreHead {
  key: string;
  size: number;
  etag?: string;
  metadata?: Record<string, string>;
}

export type StoreListEntry = StoreHead;

export interface Store {
  put(input: {
    key: string;
    bytes: Uint8Array;
    contentType?: string;
    metadata?: Record<string, string>;
  }): Promise<Result<StoreHead>>;
  get(key: string): Promise<Result<Uint8Array>>;
  head(key: string): Promise<Result<StoreHead | null>>;
  list(prefix: string): Promise<Result<StoreListEntry[]>>;
  delete?(key: string): Promise<Result<void>>;
}

export function tinyagentKvPath(agent: string, suffix: string): string {
  const cleanAgent = agent.replace(/^\/+|\/+$/g, "");
  const cleanSuffix = suffix.replace(/^\/+/g, "");
  return `tinyagent/${cleanAgent}/${cleanSuffix}`;
}
