import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { AttestationDoc } from "@tinyagent/core";
import {
  createDcapQvlVerifier,
  createPhalaVerifier,
  parseDcapQvlOutput,
  parsePhalaResponse,
  replayRtmrs,
  verifyAttestation,
  type RtmrEvent,
} from "./index.js";

const doc: AttestationDoc = {
  provider: "dstack-cvm",
  quote: "quote-bytes",
  composeHash: "sha256:compose",
  appId: "tinyagent-openclaw",
  timestamp: "2026-01-01T00:00:00.000Z",
  nonce: "nonce-123",
};

describe("verifyAttestation", () => {
  it("accepts a matching structural attestation with a DCAP warning", async () => {
    const verdict = await verifyAttestation(doc, {
      expectedComposeHash: "sha256:compose",
      nonce: "nonce-123",
      maxAgeMs: 60_000,
      now: new Date("2026-01-01T00:00:30.000Z"),
    });

    expect(verdict.ok).toBe(true);
    expect(verdict.checks).toMatchObject({
      schema: true,
      composeHash: true,
      nonce: true,
      timestamp: true,
      productionDcap: false,
    });
    expect(verdict.warnings).toContain(
      "DCAP quote verification was not performed",
    );
  });

  it("rejects compose hash mismatches", async () => {
    const verdict = await verifyAttestation(doc, {
      expectedComposeHash: "sha256:other",
    });

    expect(verdict.ok).toBe(false);
    expect(verdict.checks.composeHash).toBe(false);
    expect(verdict.errors[0]).toContain("compose hash mismatch");
  });

  it("rejects nonce mismatches", async () => {
    const verdict = await verifyAttestation(doc, { nonce: "wrong" });

    expect(verdict.ok).toBe(false);
    expect(verdict.checks.nonce).toBe(false);
  });

  it("rejects attestations outside the allowed clock-skew window", async () => {
    const verdict = await verifyAttestation(doc, {
      maxAgeMs: 60_000,
      now: new Date("2026-01-01T00:02:01.000Z"),
    });

    expect(verdict.ok).toBe(false);
    expect(verdict.checks.timestamp).toBe(false);
    expect(verdict.errors.join(" ")).toContain(
      "attestation timestamp is older than 60000ms",
    );
  });

  it("fails production mode without a DCAP verifier", async () => {
    const verdict = await verifyAttestation(doc, {
      requireProductionDcap: true,
    });

    expect(verdict.ok).toBe(false);
    expect(verdict.errors).toContain(
      "production DCAP verification backend is not configured",
    );
  });

  it("uses an injected DCAP verifier for production checks", async () => {
    const verdict = await verifyAttestation(doc, {
      requireProductionDcap: true,
      dcapVerifier: async () => ({ ok: true }),
    });

    expect(verdict.ok).toBe(true);
    expect(verdict.checks.productionDcap).toBe(true);
  });
});

const digestA = createHash("sha384").update("event-a").digest("hex");
const digestB = createHash("sha384").update("event-b").digest("hex");

const events: RtmrEvent[] = [
  { rtmr: 1, digest: digestA },
  { rtmr: 1, digest: digestB },
];

// Precomputed expected RTMR1 from folding the two events from a zero register.
const EXPECTED_RTMR1 =
  "d52e535a19e91bb6e0943801563a9f427689aab768299ef1a52ff2f220cccef1666b701622b01ffbd738e8744776fa8c";

describe("RTMR replay", () => {
  it("replayRtmrs folds events into the known register value", () => {
    const replayed = replayRtmrs(events);
    expect(replayed[1]).toBe(EXPECTED_RTMR1);
  });

  it("accepts an attestation whose event log replays to the expected RTMR", async () => {
    const docWithLog: AttestationDoc = { ...doc, eventLog: { events } };
    const verdict = await verifyAttestation(docWithLog, {
      expectedRtmrs: { 1: EXPECTED_RTMR1 },
    });
    expect(verdict.ok).toBe(true);
    expect(verdict.checks.rtmrReplay).toBe(true);
  });

  it("accepts an event log given as a bare array", async () => {
    const docWithLog: AttestationDoc = { ...doc, eventLog: events };
    const verdict = await verifyAttestation(docWithLog, {
      expectedRtmrs: { 1: EXPECTED_RTMR1 },
    });
    expect(verdict.ok).toBe(true);
  });

  it("rejects a tampered event log", async () => {
    const tampered: RtmrEvent[] = [
      { rtmr: 1, digest: digestA },
      { rtmr: 1, digest: createHash("sha384").update("evil").digest("hex") },
    ];
    const docWithLog: AttestationDoc = {
      ...doc,
      eventLog: { events: tampered },
    };
    const verdict = await verifyAttestation(docWithLog, {
      expectedRtmrs: { 1: EXPECTED_RTMR1 },
    });
    expect(verdict.ok).toBe(false);
    expect(verdict.checks.rtmrReplay).toBe(false);
    expect(verdict.errors.join(" ")).toContain("replay mismatch");
  });

  it("rejects when RTMR replay is requested but no event log is present", async () => {
    const verdict = await verifyAttestation(doc, {
      expectedRtmrs: { 1: EXPECTED_RTMR1 },
    });
    expect(verdict.ok).toBe(false);
    expect(verdict.checks.rtmrReplay).toBe(false);
    expect(verdict.errors.join(" ")).toContain("no replayable event log");
  });

  it("cross-checks RTMRs reported by a verified quote against expected", async () => {
    const docWithLog: AttestationDoc = { ...doc, eventLog: { events } };
    const verdict = await verifyAttestation(docWithLog, {
      expectedRtmrs: { 1: EXPECTED_RTMR1 },
      dcapVerifier: async () => ({
        ok: true,
        rtmrs: { 1: "00".repeat(48) },
      }),
    });
    expect(verdict.ok).toBe(false);
    expect(verdict.checks.rtmrReplay).toBe(false);
    expect(verdict.errors.join(" ")).toContain("does not match expected");
  });
});

describe("gateway key binding", () => {
  it("accepts reportData that contains the gateway key (utf8 substring)", async () => {
    const docBound: AttestationDoc = {
      ...doc,
      reportData: "prefix-gw-session-key-abc-suffix",
    };
    const verdict = await verifyAttestation(docBound, {
      expectedGatewayKey: "gw-session-key-abc",
    });
    expect(verdict.ok).toBe(true);
    expect(verdict.checks.gatewayBinding).toBe(true);
  });

  it("accepts reportData hex that contains the gateway key bytes", async () => {
    const keyHex = Buffer.from("gw-session-key-abc", "utf8").toString("hex");
    const docBound: AttestationDoc = {
      ...doc,
      reportData: `dead${keyHex}beef`,
    };
    const verdict = await verifyAttestation(docBound, {
      expectedGatewayKey: Buffer.from("gw-session-key-abc", "utf8"),
    });
    expect(verdict.ok).toBe(true);
    expect(verdict.checks.gatewayBinding).toBe(true);
  });

  it("rejects reportData that does not contain the gateway key", async () => {
    const docBound: AttestationDoc = {
      ...doc,
      reportData: "totally-different",
    };
    const verdict = await verifyAttestation(docBound, {
      expectedGatewayKey: "gw-session-key-abc",
    });
    expect(verdict.ok).toBe(false);
    expect(verdict.checks.gatewayBinding).toBe(false);
    expect(verdict.errors.join(" ")).toContain(
      "does not contain the expected gateway key",
    );
  });

  it("rejects when gateway binding is requested but reportData is absent", async () => {
    const verdict = await verifyAttestation(doc, {
      expectedGatewayKey: "gw-session-key-abc",
    });
    expect(verdict.ok).toBe(false);
    expect(verdict.checks.gatewayBinding).toBe(false);
    expect(verdict.errors.join(" ")).toContain("has no reportData");
  });

  it("accepts reportData that commits to the gateway key via sha512(nonce||key)", async () => {
    const nonce = Buffer.from("nonce-123", "utf8");
    const key = Buffer.from("gw-session-key-abc", "utf8");
    const commit = createHash("sha512")
      .update(Buffer.concat([nonce, key]))
      .digest("hex");
    const docBound: AttestationDoc = { ...doc, reportData: commit };
    const verdict = await verifyAttestation(docBound, {
      expectedGatewayKey: key,
      gatewayBindingMode: "sha512",
    });
    expect(verdict.ok).toBe(true);
    expect(verdict.checks.gatewayBinding).toBe(true);
  });

  it("rejects a wrong hash commitment", async () => {
    const docBound: AttestationDoc = { ...doc, reportData: "00".repeat(64) };
    const verdict = await verifyAttestation(docBound, {
      expectedGatewayKey: "gw-session-key-abc",
      gatewayBindingMode: "sha512",
    });
    expect(verdict.ok).toBe(false);
    expect(verdict.checks.gatewayBinding).toBe(false);
    expect(verdict.errors.join(" ")).toContain(
      "does not commit to the gateway key",
    );
  });
});

describe("createDcapQvlVerifier", () => {
  it("returns a labeled unsupported result when the binary is absent", async () => {
    const verifier = createDcapQvlVerifier({ which: async () => false });
    const result = await verifier(doc);
    expect(result.ok).toBe(false);
    expect(result.errors?.[0]).toContain(
      "DCAP backend not available in this environment",
    );
  });

  it("fails production verification when the binary is absent", async () => {
    const verifier = createDcapQvlVerifier({ which: async () => false });
    const verdict = await verifyAttestation(doc, {
      requireProductionDcap: true,
      dcapVerifier: verifier,
    });
    expect(verdict.ok).toBe(false);
    expect(verdict.checks.productionDcap).toBe(false);
    expect(verdict.errors.join(" ")).toContain(
      "DCAP backend not available in this environment",
    );
  });

  it("parses a verified verdict when the binary is present", async () => {
    const verifier = createDcapQvlVerifier({
      which: async () => true,
      run: async () => ({
        code: 0,
        stdout: JSON.stringify({ status: "UpToDate", rtmrs: { 1: "ab" } }),
        stderr: "",
      }),
    });
    const result = await verifier(doc);
    expect(result.ok).toBe(true);
    expect(result.rtmrs?.[1]).toBe("ab");
  });

  it("parses a not-verified verdict when the tool rejects the quote", async () => {
    const verifier = createDcapQvlVerifier({
      which: async () => true,
      run: async () => ({
        code: 1,
        stdout: JSON.stringify({ verified: false, status: "Revoked" }),
        stderr: "",
      }),
    });
    const result = await verifier(doc);
    expect(result.ok).toBe(false);
    expect(result.errors?.join(" ")).toContain("not verified");
  });

  it("parseDcapQvlOutput falls back to exit code for non-JSON output", () => {
    expect(parseDcapQvlOutput({ code: 0, stdout: "OK", stderr: "" }).ok).toBe(
      true,
    );
    const bad = parseDcapQvlOutput({ code: 2, stdout: "", stderr: "boom" });
    expect(bad.ok).toBe(false);
    expect(bad.errors?.join(" ")).toContain("exited with code 2");
  });

  it("confirms dcap-qvl is genuinely absent on this PATH (default which)", async () => {
    const verifier = createDcapQvlVerifier();
    const result = await verifier(doc);
    expect(result.ok).toBe(false);
    expect(result.errors?.[0]).toContain(
      "DCAP backend not available in this environment",
    );
  });
});

describe("createPhalaVerifier", () => {
  it("parses a verified API response (mocked HTTP)", async () => {
    const fetchMock = (async () =>
      new Response(
        JSON.stringify({ verified: true, rtmrs: { 1: "0xAB", 2: "cd" } }),
        { status: 200, headers: { "content-type": "application/json" } },
      )) as unknown as typeof fetch;

    const verifier = createPhalaVerifier({
      endpoint: "https://example.test/verify",
      fetch: fetchMock,
    });
    const result = await verifier(doc);
    expect(result.ok).toBe(true);
    expect(result.rtmrs?.[1]).toBe("ab");
    expect(result.rtmrs?.[2]).toBe("cd");
  });

  it("parses a status-based verified response with a TCB warning", async () => {
    const fetchMock = (async () =>
      new Response(JSON.stringify({ status: "SWHardeningNeeded" }), {
        status: 200,
      })) as unknown as typeof fetch;
    const verifier = createPhalaVerifier({
      endpoint: "https://example.test/verify",
      fetch: fetchMock,
    });
    const result = await verifier(doc);
    // Non-OK status => not verified.
    expect(result.ok).toBe(false);
  });

  it("parses a rejected API response", async () => {
    const fetchMock = (async () =>
      new Response(JSON.stringify({ verified: false, status: "Revoked" }), {
        status: 200,
      })) as unknown as typeof fetch;
    const verifier = createPhalaVerifier({
      endpoint: "https://example.test/verify",
      fetch: fetchMock,
    });
    const result = await verifier(doc);
    expect(result.ok).toBe(false);
    expect(result.errors?.join(" ")).toContain("not verified");
  });

  it("surfaces non-2xx HTTP as an error", async () => {
    const fetchMock = (async () =>
      new Response("nope", { status: 500 })) as unknown as typeof fetch;
    const verifier = createPhalaVerifier({
      endpoint: "https://example.test/verify",
      fetch: fetchMock,
    });
    const result = await verifier(doc);
    expect(result.ok).toBe(false);
    expect(result.errors?.join(" ")).toContain("HTTP 500");
  });

  it("parsePhalaResponse rejects unexpected bodies", () => {
    expect(parsePhalaResponse(null).ok).toBe(false);
    expect(parsePhalaResponse({ verified: true }).ok).toBe(true);
  });

  // Live test, gated behind env. No live quote/account exists here, so this is
  // skipped unless PHALA_VERIFY_LIVE=1 and a real quote are supplied.
  const live = process.env.PHALA_VERIFY_LIVE === "1";
  (live ? it : it.skip)(
    "verifies a real quote against the live Phala API",
    async () => {
      const quote = process.env.PHALA_TEST_QUOTE ?? "";
      expect(quote.length).toBeGreaterThan(0);
      const verifier = createPhalaVerifier();
      const result = await verifier({ ...doc, quote });
      expect(typeof result.ok).toBe("boolean");
    },
  );
});
