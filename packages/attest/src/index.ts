import { createHash } from "node:crypto";
import { AttestationDocSchema, type AttestationDoc } from "@tinyagent/core";
export {
  buildRunnerAppCompose,
  canonicalize,
  computeComposeHash,
  serializeAppCompose,
  type RunnerAppCompose,
  type RunnerComposeSpec,
} from "./compose.js";

export interface AttestationVerdict {
  readonly ok: boolean;
  readonly doc: AttestationDoc;
  readonly errors: readonly string[];
  readonly warnings: readonly string[];
  readonly checks: AttestationChecks;
}

export interface AttestationChecks {
  readonly schema: boolean;
  readonly composeHash: boolean;
  readonly nonce: boolean;
  readonly timestamp: boolean;
  readonly productionDcap: boolean;
  readonly rtmrReplay: boolean;
  readonly gatewayBinding: boolean;
}

export interface AttestationPolicy {
  readonly expectedComposeHash?: string;
  readonly nonce?: string | Uint8Array;
  readonly maxAgeMs?: number;
  readonly now?: Date;
  readonly requireProductionDcap?: boolean;
  readonly dcapVerifier?: DcapVerifier;
  /**
   * Expected RTMR register values keyed by register index (0..3), as
   * lowercase hex strings (no `0x` prefix). When provided, the attestation's
   * `eventLog` is replayed and the recomputed registers must match these.
   */
  readonly expectedRtmrs?: Readonly<Record<number, string>>;
  /**
   * Expected gateway session key/token that the attestation's `reportData`
   * must commit to. When provided, `reportData` must either contain the key
   * bytes or equal `hash(nonce || gatewayKey)` (see {@link GatewayBindingMode}).
   */
  readonly expectedGatewayKey?: string | Uint8Array;
  /**
   * How `reportData` is expected to bind the gateway key.
   * - `contains` (default): the gateway key bytes appear inside reportData.
   * - `sha512`/`sha384`/`sha256`: reportData == hash(nonce || gatewayKey).
   */
  readonly gatewayBindingMode?: GatewayBindingMode;
}

export type GatewayBindingMode = "contains" | "sha256" | "sha384" | "sha512";

export type DcapVerifier = (doc: AttestationDoc) => Promise<DcapVerification>;

export interface DcapVerification {
  readonly ok: boolean;
  readonly errors?: readonly string[];
  readonly warnings?: readonly string[];
  /**
   * RTMR register values the verifier extracted from the verified quote, as
   * lowercase hex. Used to cross-check against an RTMR replay.
   */
  readonly rtmrs?: Readonly<Record<number, string>>;
}

export async function verifyAttestation(
  doc: AttestationDoc,
  policy: AttestationPolicy = {},
): Promise<AttestationVerdict> {
  const errors: string[] = [];
  const warnings: string[] = [];
  const checks: MutableChecks = {
    schema: true,
    composeHash: true,
    nonce: true,
    timestamp: true,
    productionDcap: false,
    rtmrReplay: true,
    gatewayBinding: true,
  };

  const parsed = AttestationDocSchema.safeParse(doc);
  if (!parsed.success) {
    checks.schema = false;
    errors.push("attestation document does not match the TinyAgent schema");
  }

  if (
    policy.expectedComposeHash !== undefined &&
    doc.composeHash !== policy.expectedComposeHash
  ) {
    checks.composeHash = false;
    errors.push(
      `compose hash mismatch: expected ${policy.expectedComposeHash}, got ${doc.composeHash}`,
    );
  }

  if (
    policy.nonce !== undefined &&
    !attestationCarriesNonce(doc, policy.nonce)
  ) {
    checks.nonce = false;
    errors.push("nonce not found in attestation nonce or reportData");
  }

  const timestamp = Date.parse(doc.timestamp);
  if (Number.isNaN(timestamp)) {
    checks.timestamp = false;
    errors.push("attestation timestamp is invalid");
  } else if (policy.maxAgeMs !== undefined) {
    const now = policy.now ?? new Date();
    const age = Math.abs(now.getTime() - timestamp);
    if (age > policy.maxAgeMs) {
      checks.timestamp = false;
      errors.push(`attestation timestamp is older than ${policy.maxAgeMs}ms`);
    }
  }

  if (policy.expectedRtmrs !== undefined) {
    const replay = verifyRtmrReplay(doc, policy.expectedRtmrs);
    checks.rtmrReplay = replay.ok;
    errors.push(...replay.errors);
  }

  if (policy.expectedGatewayKey !== undefined) {
    const binding = verifyGatewayBinding(
      doc,
      policy.expectedGatewayKey,
      policy.gatewayBindingMode ?? "contains",
    );
    checks.gatewayBinding = binding.ok;
    errors.push(...binding.errors);
  }

  if (policy.dcapVerifier !== undefined) {
    const dcap = await policy.dcapVerifier(doc);
    checks.productionDcap = dcap.ok;
    if (dcap.errors !== undefined) errors.push(...dcap.errors);
    if (dcap.warnings !== undefined) warnings.push(...dcap.warnings);

    // Cross-check: if the verified quote reported RTMRs and the policy also
    // pinned expected values, they must agree.
    if (dcap.rtmrs !== undefined && policy.expectedRtmrs !== undefined) {
      for (const [index, expected] of Object.entries(policy.expectedRtmrs)) {
        const reported = dcap.rtmrs[Number(index)];
        if (reported !== undefined && reported !== expected) {
          checks.rtmrReplay = false;
          errors.push(
            `RTMR${index} from verified quote (${reported}) does not match expected (${expected})`,
          );
        }
      }
    }
  } else if (policy.requireProductionDcap === true) {
    errors.push("production DCAP verification backend is not configured");
  } else {
    warnings.push("DCAP quote verification was not performed");
  }

  return {
    ok: errors.length === 0,
    doc,
    errors,
    warnings,
    checks,
  };
}

type MutableChecks = {
  -readonly [Key in keyof AttestationChecks]: AttestationChecks[Key];
};

function attestationCarriesNonce(
  doc: AttestationDoc,
  expected: string | Uint8Array,
): boolean {
  const expectedForms = nonceForms(expected);
  return [doc.nonce, doc.reportData].some(
    (value) => value !== undefined && expectedForms.has(value),
  );
}

function nonceForms(nonce: string | Uint8Array): Set<string> {
  if (typeof nonce === "string") return new Set([nonce]);
  return new Set([
    Buffer.from(nonce).toString("hex"),
    Buffer.from(nonce).toString("base64"),
    base64Url(nonce),
  ]);
}

function base64Url(bytes: Uint8Array): string {
  return Buffer.from(bytes)
    .toString("base64")
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}

/**
 * A single measured event in a TDX RTMR event log. `digest` is the lowercase
 * hex SHA-384 of the measured payload that was extended into the register.
 */
export interface RtmrEvent {
  readonly rtmr: number;
  readonly digest: string;
}

/**
 * The structured event log we expect to find on `doc.eventLog`. Either an
 * array of events, or an object with an `events` array. Any other shape is
 * treated as "no replayable event log".
 */
function extractEventLog(eventLog: unknown): RtmrEvent[] | undefined {
  const raw = Array.isArray(eventLog)
    ? eventLog
    : isRecord(eventLog) && Array.isArray(eventLog.events)
      ? eventLog.events
      : undefined;
  if (raw === undefined) return undefined;

  const events: RtmrEvent[] = [];
  for (const entry of raw) {
    if (!isRecord(entry)) return undefined;
    const rtmr =
      typeof entry.rtmr === "number"
        ? entry.rtmr
        : typeof entry.imr === "number"
          ? entry.imr
          : undefined;
    const digest =
      typeof entry.digest === "string"
        ? entry.digest
        : typeof entry.eventDigest === "string"
          ? entry.eventDigest
          : undefined;
    if (rtmr === undefined || digest === undefined) return undefined;
    events.push({ rtmr, digest: normalizeHex(digest) });
  }
  return events;
}

/**
 * Replays a TDX RTMR event log. For each register, the value starts at 48
 * zero bytes and each event extends it as:
 *   rtmr_next = SHA384(rtmr_prev || event_digest)
 * where both operands are raw 48-byte SHA-384 values.
 *
 * Returns the recomputed registers as lowercase hex keyed by register index.
 * This is pure computation and runs fully in this environment.
 */
export function replayRtmrs(
  events: readonly RtmrEvent[],
): Record<number, string> {
  const registers = new Map<number, Buffer>();
  for (const event of events) {
    const digest = Buffer.from(normalizeHex(event.digest), "hex");
    const prev = registers.get(event.rtmr) ?? Buffer.alloc(48, 0);
    const next = createHash("sha384")
      .update(Buffer.concat([prev, digest]))
      .digest();
    registers.set(event.rtmr, next);
  }
  const out: Record<number, string> = {};
  for (const [index, value] of registers) {
    out[index] = value.toString("hex");
  }
  return out;
}

function verifyRtmrReplay(
  doc: AttestationDoc,
  expected: Readonly<Record<number, string>>,
): { ok: boolean; errors: string[] } {
  const events = extractEventLog(doc.eventLog);
  if (events === undefined) {
    return {
      ok: false,
      errors: [
        "RTMR replay requested but attestation has no replayable event log",
      ],
    };
  }
  const replayed = replayRtmrs(events);
  const errors: string[] = [];
  for (const [index, expectedValue] of Object.entries(expected)) {
    const got = replayed[Number(index)];
    const want = normalizeHex(expectedValue);
    if (got === undefined) {
      errors.push(`RTMR${index} not produced by event-log replay`);
    } else if (got !== want) {
      errors.push(
        `RTMR${index} replay mismatch: expected ${want}, replayed ${got}`,
      );
    }
  }
  return { ok: errors.length === 0, errors };
}

function verifyGatewayBinding(
  doc: AttestationDoc,
  expectedKey: string | Uint8Array,
  mode: GatewayBindingMode,
): { ok: boolean; errors: string[] } {
  const reportData = doc.reportData;
  if (reportData === undefined || reportData.length === 0) {
    return {
      ok: false,
      errors: [
        "gateway key binding requested but attestation has no reportData",
      ],
    };
  }

  const keyBytes = toBytes(expectedKey);

  if (mode === "contains") {
    const haystacks = candidateByteForms(reportData);
    const found = haystacks.some((h) => indexOfBytes(h, keyBytes) !== -1);
    // Also allow a direct string-substring match (e.g. hex key embedded in a
    // hex reportData) for robustness across encodings.
    const stringMatch =
      typeof expectedKey === "string" && reportData.includes(expectedKey);
    if (!found && !stringMatch) {
      return {
        ok: false,
        errors: ["reportData does not contain the expected gateway key"],
      };
    }
    return { ok: true, errors: [] };
  }

  // Hash-commitment modes: reportData == hash(nonce || gatewayKey).
  // The attestation `nonce` is a textual identifier, so it is bound as its
  // raw UTF-8 bytes (not re-decoded as hex/base64).
  const nonceBytes =
    doc.nonce !== undefined ? Buffer.from(doc.nonce, "utf8") : Buffer.alloc(0);
  const commitment = createHash(mode)
    .update(Buffer.concat([nonceBytes, keyBytes]))
    .digest();
  const reportBytes = decodeFlexible(reportData);
  if (reportBytes === undefined) {
    return {
      ok: false,
      errors: ["reportData is not a decodable hex/base64 value"],
    };
  }
  // reportData may be longer than the digest (zero-padded into a 64-byte
  // field); compare against the leading bytes.
  const prefix = reportBytes.subarray(0, commitment.length);
  if (!timingSafeEqualBytes(prefix, commitment)) {
    return {
      ok: false,
      errors: [
        `reportData does not commit to the gateway key via ${mode}(nonce || gatewayKey)`,
      ],
    };
  }
  return { ok: true, errors: [] };
}

export interface DcapQvlOptions {
  /** Override the binary name/path. Defaults to `dcap-qvl`. */
  readonly binary?: string;
  /**
   * Hook to spawn the verification tool. Injectable for testing. Returns the
   * process stdout/stderr and exit code. Defaults to spawning via
   * `node:child_process`.
   */
  readonly run?: (
    binary: string,
    args: readonly string[],
    quote: Buffer,
  ) => Promise<{ code: number | null; stdout: string; stderr: string }>;
  /** Hook to check binary presence on PATH. Injectable for testing. */
  readonly which?: (binary: string) => Promise<boolean>;
}

/**
 * Builds a {@link DcapVerifier} that shells out to the `dcap-qvl` quote
 * verification tool when it is present on PATH. When the binary is absent it
 * returns a clearly-labeled "unsupported in this environment" verdict rather
 * than silently passing.
 *
 * In this environment `dcap-qvl` is NOT installed, so the produced verifier
 * yields the unsupported result. The parsing of a real verdict is covered by
 * the injectable `run` hook.
 */
export function createDcapQvlVerifier(
  options: DcapQvlOptions = {},
): DcapVerifier {
  const binary = options.binary ?? "dcap-qvl";
  const which = options.which ?? defaultWhich;
  const run = options.run ?? defaultRun;

  return async (doc: AttestationDoc): Promise<DcapVerification> => {
    if (!(await which(binary))) {
      return {
        ok: false,
        errors: [
          `DCAP backend not available in this environment: '${binary}' not found on PATH`,
        ],
      };
    }

    const quote = decodeFlexible(doc.quote) ?? Buffer.from(doc.quote, "utf8");
    let result: { code: number | null; stdout: string; stderr: string };
    try {
      result = await run(binary, ["verify", "--quote", "-"], quote);
    } catch (cause) {
      return {
        ok: false,
        errors: [
          `dcap-qvl invocation failed: ${cause instanceof Error ? cause.message : String(cause)}`,
        ],
      };
    }
    return parseDcapQvlOutput(result);
  };
}

/**
 * Parses `dcap-qvl` output into a verdict. Recognizes JSON output with a
 * `status`/`verified` field, and falls back to exit-code semantics.
 */
export function parseDcapQvlOutput(result: {
  code: number | null;
  stdout: string;
  stderr: string;
}): DcapVerification {
  const text = result.stdout.trim();
  let json: unknown;
  try {
    json = text.length > 0 ? JSON.parse(text) : undefined;
  } catch {
    json = undefined;
  }

  if (isRecord(json)) {
    const status =
      typeof json.status === "string"
        ? json.status
        : typeof json.tcbStatus === "string"
          ? json.tcbStatus
          : undefined;
    const verified =
      typeof json.verified === "boolean" ? json.verified : undefined;
    const rtmrs = extractRtmrsFromJson(json);

    const okStatuses = new Set(["ok", "uptodate", "up-to-date", "success"]);
    const statusOk =
      status !== undefined
        ? okStatuses.has(status.toLowerCase().replace(/\s+/g, ""))
        : undefined;

    const ok =
      verified === true ||
      statusOk === true ||
      (verified === undefined && statusOk === undefined && result.code === 0);

    if (ok) {
      const warnings: string[] = [];
      if (status !== undefined && !okStatuses.has(status.toLowerCase())) {
        warnings.push(`dcap-qvl TCB status: ${status}`);
      }
      return {
        ok: true,
        ...(warnings.length > 0 ? { warnings } : {}),
        ...(rtmrs !== undefined ? { rtmrs } : {}),
      };
    }
    return {
      ok: false,
      errors: [
        `dcap-qvl reported the quote as not verified${status !== undefined ? ` (status: ${status})` : ""}`,
      ],
      ...(rtmrs !== undefined ? { rtmrs } : {}),
    };
  }

  // No JSON: rely on exit code.
  if (result.code === 0) return { ok: true };
  return {
    ok: false,
    errors: [
      `dcap-qvl exited with code ${result.code}${
        result.stderr.trim().length > 0 ? `: ${result.stderr.trim()}` : ""
      }`,
    ],
  };
}

export interface PhalaVerifyOptions {
  /** Base URL of the Phala attestation verify API. */
  readonly endpoint?: string;
  /** Injectable fetch implementation for testing. Defaults to global fetch. */
  readonly fetch?: typeof fetch;
}

const DEFAULT_PHALA_ENDPOINT =
  "https://cloud-api.phala.network/api/v1/attestations/verify";

/**
 * Builds a {@link DcapVerifier} backed by Phala's hosted quote-verification
 * HTTP API. There is no live Phala quote/account in this environment, so the
 * live path is exercised only when an endpoint + real quote are supplied; the
 * response-parsing/verdict logic is covered by a mocked fetch in tests.
 */
export function createPhalaVerifier(
  options: PhalaVerifyOptions = {},
): DcapVerifier {
  const endpoint = options.endpoint ?? DEFAULT_PHALA_ENDPOINT;
  const fetchImpl = options.fetch ?? globalThis.fetch;

  return async (doc: AttestationDoc): Promise<DcapVerification> => {
    if (typeof fetchImpl !== "function") {
      return {
        ok: false,
        errors: ["Phala verify backend not available: no fetch implementation"],
      };
    }
    let response: Response;
    try {
      response = await fetchImpl(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ quote: doc.quote, eventLog: doc.eventLog }),
      });
    } catch (cause) {
      return {
        ok: false,
        errors: [
          `Phala verify request failed: ${cause instanceof Error ? cause.message : String(cause)}`,
        ],
      };
    }

    if (!response.ok) {
      return {
        ok: false,
        errors: [`Phala verify API returned HTTP ${response.status}`],
      };
    }

    let body: unknown;
    try {
      body = await response.json();
    } catch {
      return {
        ok: false,
        errors: ["Phala verify API returned a non-JSON body"],
      };
    }
    return parsePhalaResponse(body);
  };
}

/**
 * Parses a Phala verify-API response body into a verdict. Accepts a few common
 * shapes: `{ verified: bool }`, `{ status: "UpToDate"|... }`, and an optional
 * `rtmrs` map / `report.rtmrs` extracted from the verified quote.
 */
export function parsePhalaResponse(body: unknown): DcapVerification {
  if (!isRecord(body)) {
    return {
      ok: false,
      errors: ["Phala verify API returned an unexpected body"],
    };
  }

  const verified =
    typeof body.verified === "boolean"
      ? body.verified
      : typeof body.success === "boolean"
        ? body.success
        : undefined;
  const status =
    typeof body.status === "string"
      ? body.status
      : typeof body.tcbStatus === "string"
        ? body.tcbStatus
        : undefined;
  const rtmrs = extractRtmrsFromJson(body);

  const okStatuses = new Set(["uptodate", "ok", "success", "verified"]);
  const statusOk =
    status !== undefined
      ? okStatuses.has(status.toLowerCase().replace(/\s+/g, ""))
      : undefined;

  const ok = verified === true || (verified === undefined && statusOk === true);

  if (ok) {
    const warnings: string[] = [];
    if (
      status !== undefined &&
      !okStatuses.has(status.toLowerCase().replace(/\s+/g, ""))
    ) {
      warnings.push(`Phala TCB status: ${status}`);
    }
    return {
      ok: true,
      ...(warnings.length > 0 ? { warnings } : {}),
      ...(rtmrs !== undefined ? { rtmrs } : {}),
    };
  }
  return {
    ok: false,
    errors: [
      `Phala verify API reported the quote as not verified${status !== undefined ? ` (status: ${status})` : ""}`,
    ],
    ...(rtmrs !== undefined ? { rtmrs } : {}),
  };
}

function extractRtmrsFromJson(
  json: Record<string, unknown>,
): Record<number, string> | undefined {
  const source =
    isRecord(json.rtmrs) || Array.isArray(json.rtmrs)
      ? json.rtmrs
      : isRecord(json.report) &&
          (isRecord((json.report as Record<string, unknown>).rtmrs) ||
            Array.isArray((json.report as Record<string, unknown>).rtmrs))
        ? (json.report as Record<string, unknown>).rtmrs
        : undefined;
  if (source === undefined) return undefined;

  const out: Record<number, string> = {};
  if (Array.isArray(source)) {
    source.forEach((value, index) => {
      if (typeof value === "string") out[index] = normalizeHex(value);
    });
  } else if (isRecord(source)) {
    for (const [key, value] of Object.entries(source)) {
      const index = Number(key.replace(/[^0-9]/g, ""));
      if (Number.isInteger(index) && typeof value === "string") {
        out[index] = normalizeHex(value);
      }
    }
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

async function defaultWhich(binary: string): Promise<boolean> {
  const { spawn } = await import("node:child_process");
  const probe = process.platform === "win32" ? "where" : "which";
  return new Promise<boolean>((resolve) => {
    const child = spawn(probe, [binary], {
      stdio: "ignore",
    });
    child.on("error", () => resolve(false));
    child.on("close", (code) => resolve(code === 0));
  });
}

async function defaultRun(
  binary: string,
  args: readonly string[],
  quote: Buffer,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const { spawn } = await import("node:child_process");
  return new Promise((resolve, reject) => {
    const child = spawn(binary, [...args], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d: Buffer) => (stdout += d.toString("utf8")));
    child.stderr.on("data", (d: Buffer) => (stderr += d.toString("utf8")));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(quote);
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeHex(value: string): string {
  return value.replace(/^0x/i, "").toLowerCase();
}

function toBytes(value: string | Uint8Array): Buffer {
  if (typeof value !== "string") return Buffer.from(value);
  const decoded = decodeFlexible(value);
  return decoded ?? Buffer.from(value, "utf8");
}

/**
 * Decodes a string that is plausibly hex or base64/base64url into bytes.
 * Returns undefined when it cannot be confidently decoded.
 */
function decodeFlexible(value: string): Buffer | undefined {
  const hex = value.replace(/^0x/i, "");
  if (hex.length > 0 && hex.length % 2 === 0 && /^[0-9a-fA-F]+$/.test(hex)) {
    return Buffer.from(hex, "hex");
  }
  if (/^[A-Za-z0-9+/=_-]+$/.test(value)) {
    const normalized = value.replaceAll("-", "+").replaceAll("_", "/");
    try {
      return Buffer.from(normalized, "base64");
    } catch {
      return undefined;
    }
  }
  return undefined;
}

/** All plausible byte decodings of a reportData string. */
function candidateByteForms(value: string): Buffer[] {
  const forms: Buffer[] = [Buffer.from(value, "utf8")];
  const decoded = decodeFlexible(value);
  if (decoded !== undefined) forms.push(decoded);
  return forms;
}

function indexOfBytes(haystack: Buffer, needle: Buffer): number {
  if (needle.length === 0) return -1;
  return haystack.indexOf(needle);
}

function timingSafeEqualBytes(a: Buffer, b: Buffer): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}
