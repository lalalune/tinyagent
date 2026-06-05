import { describe, expect, it } from "vitest";

type FailureModeStatus = "tested" | "unsupported";

interface FailureModeCoverage {
  readonly status: FailureModeStatus;
  readonly evidence: readonly string[];
  readonly reason?: string;
}

const REQUIRED_FAILURE_MODES = [
  "delegation expiry",
  "quota errors",
  "partial upload",
  "torn SQLite",
  "clock skew",
  "node outage",
  "symlinked state",
  "messaging/device key portability warning",
] as const;

const FAILURE_MODE_COVERAGE: Record<
  (typeof REQUIRED_FAILURE_MODES)[number],
  FailureModeCoverage
> = {
  "delegation expiry": {
    status: "tested",
    evidence: [
      "packages/tc/src/live.test.ts: renews an expired session and restores access",
      "packages/tc/src/live.test.ts: renews a delegated session via renewDelegation",
      "packages/backupd/src/index.test.ts: renews an expired delegated store and retries the backup once",
    ],
  },
  "quota errors": {
    status: "tested",
    evidence: [
      "packages/tc/src/live.test.ts: maps live quota failures from an enforcing node",
      "packages/tc/src/index.test.ts: maps SDK quota and object-size errors to TinyAgent error codes",
    ],
  },
  "partial upload": {
    status: "tested",
    evidence: [
      "packages/backup/src/strategies.test.ts: leaves latest pointing at the previous good snapshot after an interrupted upload",
      "packages/backup/src/strategies.test.ts: does not advance latest when manifest write fails",
    ],
  },
  "torn SQLite": {
    status: "tested",
    evidence: [
      "packages/backup/src/strategies.test.ts: takes a consistent online snapshot, backs up and restores row-clean",
      "packages/backup/src/strategies.test.ts: returns an explicit unsupported error when node:sqlite is unavailable",
    ],
  },
  "clock skew": {
    status: "tested",
    evidence: [
      "packages/attest/src/index.test.ts: rejects attestations outside the allowed clock-skew window",
    ],
  },
  "node outage": {
    status: "tested",
    evidence: [
      "packages/tc/src/index.test.ts: maps SDK errors to TinyAgent errors",
    ],
  },
  "symlinked state": {
    status: "tested",
    evidence: [
      "packages/backup/src/backup.test.ts: does not archive symlinked state entries",
    ],
  },
  "messaging/device key portability warning": {
    status: "unsupported",
    evidence: [
      "tinyagent/README.md: notes that local lifecycle persists project state and backup data through local filesystem-backed stores",
    ],
    reason:
      "TinyAgent does not yet implement a messaging bridge or portable device-key sync path; there is no device key to migrate or warn on.",
  },
};

describe("WP-32 failure-mode coverage inventory", () => {
  it("keeps every required failure mode tied to a test or unsupported marker", () => {
    expect(Object.keys(FAILURE_MODE_COVERAGE).sort()).toEqual(
      [...REQUIRED_FAILURE_MODES].sort(),
    );

    for (const [mode, coverage] of Object.entries(FAILURE_MODE_COVERAGE)) {
      expect(coverage.evidence.length, mode).toBeGreaterThan(0);
      if (coverage.status === "unsupported") {
        expect(coverage.reason?.length, mode).toBeGreaterThan(0);
      }
    }
  });
});
