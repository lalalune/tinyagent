/**
 * Typed client for the TinyAgent control-plane.
 *
 * - Base URL = `NEXT_PUBLIC_CONTROL_PLANE_URL` (default http://localhost:8088).
 * - Session is a httpOnly cookie set by `/api/auth/verify`; every request uses
 *   `credentials: 'include'` so the cookie rides along.
 *
 * Every method talks to the real control-plane and returns a typed value or
 * throws `ApiError` (with `.status`). There is no mock/demo path — the console
 * is wired straight to the live backend.
 */
import type {
  AgentStatus,
  AttestationDoc,
  BackupResult,
  BillingBalance,
  BillingConfig,
  BillingQuote,
  DeployAgentInput,
  DeployedAgent,
  MeResponse,
  PackRecord,
  ResourceSize,
} from "./types";

export const CONTROL_PLANE_URL = (
  process.env.NEXT_PUBLIC_CONTROL_PLANE_URL ?? "http://localhost:8088"
).replace(/\/+$/, "");

export class ApiError extends Error {
  readonly status: number;
  readonly body: unknown;
  constructor(message: string, status: number, body?: unknown) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.body = body;
  }
}

type Query = Record<string, string | number | undefined>;

interface RequestOptions {
  method?: "GET" | "POST";
  body?: unknown;
  query?: Query;
  signal?: AbortSignal;
}

function buildUrl(path: string, query?: Query): string {
  const url = new URL(CONTROL_PLANE_URL + path);
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined) url.searchParams.set(k, String(v));
    }
  }
  return url.toString();
}

async function request<T>(path: string, opts: RequestOptions = {}): Promise<T> {
  const { method = "GET", body, query, signal } = opts;
  let res: Response;
  try {
    res = await fetch(buildUrl(path, query), {
      method,
      credentials: "include",
      headers: body !== undefined ? { "Content-Type": "application/json" } : {},
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal,
    });
  } catch (cause) {
    throw new ApiError(
      `Could not reach the control-plane at ${CONTROL_PLANE_URL}. Is it running?`,
      0,
      cause,
    );
  }

  const text = await res.text();
  let parsed: unknown = undefined;
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = text;
    }
  }

  if (!res.ok) {
    const message =
      extractErrorMessage(parsed) ??
      `Request failed: ${method} ${path} → ${res.status}`;
    throw new ApiError(message, res.status, parsed);
  }

  return parsed as T;
}

/** Pull a human-readable `error` string out of a parsed JSON error body, if present. */
function extractErrorMessage(parsed: unknown): string | undefined {
  if (
    parsed &&
    typeof parsed === "object" &&
    "error" in parsed &&
    typeof (parsed as { error: unknown }).error === "string"
  ) {
    return (parsed as { error: string }).error;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Public API surface
// ---------------------------------------------------------------------------

export const api = {
  // --- auth -------------------------------------------------------------
  async nonce(): Promise<string> {
    const r = await request<{ nonce: string }>("/api/auth/nonce", {
      method: "POST",
    });
    return r.nonce;
  },

  async verify(message: string, signature: string): Promise<{ address: string }> {
    return request<{ address: string }>("/api/auth/verify", {
      method: "POST",
      body: { message, signature },
    });
  },

  async logout(): Promise<{ ok: true }> {
    return request<{ ok: true }>("/api/auth/logout", { method: "POST" });
  },

  /** Returns the session address, or null if unauthenticated (401). */
  async me(): Promise<MeResponse | null> {
    try {
      return await request<MeResponse>("/api/me");
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) return null;
      throw e;
    }
  },

  // --- packs & agents ---------------------------------------------------
  async packs(signal?: AbortSignal): Promise<PackRecord[]> {
    return request<PackRecord[]>("/api/packs", { signal });
  },

  async agents(signal?: AbortSignal): Promise<DeployedAgent[]> {
    return request<DeployedAgent[]>("/api/agents", { signal });
  },

  async deploy(input: DeployAgentInput): Promise<DeployedAgent> {
    return request<DeployedAgent>("/api/agents", {
      method: "POST",
      body: input,
    });
  },

  async status(name: string, signal?: AbortSignal): Promise<AgentStatus> {
    return request<AgentStatus>(`/api/agents/${encodeURIComponent(name)}/status`, {
      signal,
    });
  },

  async backup(name: string): Promise<BackupResult> {
    return request<BackupResult>(`/api/agents/${encodeURIComponent(name)}/backup`, {
      method: "POST",
    });
  },

  async recover(name: string): Promise<DeployedAgent> {
    return request<DeployedAgent>(
      `/api/agents/${encodeURIComponent(name)}/recover`,
      { method: "POST" },
    );
  },

  async down(name: string): Promise<{ ok: true }> {
    return request<{ ok: true }>(`/api/agents/${encodeURIComponent(name)}/down`, {
      method: "POST",
    });
  },

  async attestation(
    name: string,
    signal?: AbortSignal,
  ): Promise<AttestationDoc | null> {
    return request<AttestationDoc | null>(
      `/api/agents/${encodeURIComponent(name)}/attestation`,
      { signal },
    );
  },

  // --- billing ----------------------------------------------------------
  async quote(
    r: ResourceSize,
    hours: number,
    signal?: AbortSignal,
  ): Promise<BillingQuote> {
    return request<BillingQuote>("/api/billing/quote", {
      query: {
        vcpu: r.vcpu,
        memMiB: r.memMiB,
        diskGiB: r.diskGiB,
        hours,
      },
      signal,
    });
  },

  async billingConfig(signal?: AbortSignal): Promise<BillingConfig> {
    return request<BillingConfig>("/api/billing/config", { signal });
  },

  async billingBalance(
    address: string,
    signal?: AbortSignal,
  ): Promise<BillingBalance> {
    return request<BillingBalance>("/api/billing/balance", {
      query: { address },
      signal,
    });
  },
};
