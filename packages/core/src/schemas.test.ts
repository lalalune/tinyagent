import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  AgentSpecSchema,
  AttestationDocSchema,
  BackupManifestSchema,
  ExecChunkSchema,
  SandboxSchema,
  SandboxSpecSchema,
  backupKvPaths,
} from "./schemas.js";
import { redactObject, redactText } from "./redaction.js";

describe("core schemas", () => {
  it("parses a minimal agent spec", () => {
    const spec = AgentSpecSchema.parse({ name: "openclaw" });
    expect(spec.dependencies).toEqual([]);
    expect(spec.brain).toBe(false);
  });

  it("rejects incomplete backup manifests", () => {
    expect(() => BackupManifestSchema.parse({ agent: "ada" })).toThrow();
  });

  it("parses timed-out exec chunks explicitly", () => {
    expect(
      ExecChunkSchema.parse({
        stream: "exit",
        exitCode: 124,
        timedOut: true,
        timeoutMs: 50,
      }),
    ).toEqual({
      stream: "exit",
      exitCode: 124,
      timedOut: true,
      timeoutMs: 50,
    });
  });

  it("builds stable backup paths", () => {
    expect(backupKvPaths("ada")).toEqual({
      chunksPrefix: "tinyagent/ada/chunks/",
      snapshotsPrefix: "tinyagent/ada/snapshots/",
      latest: "tinyagent/ada/latest",
      meta: "tinyagent/ada/meta.json",
    });
  });

  it("redacts nested secret-looking fields without erasing non-secret diagnostics", () => {
    expect(
      redactObject({
        registry: {
          path: "/tmp/registry.json",
          apiKey: "sk-live",
          auth: { privateKey: "wallet-secret" },
        },
        secretTargets: [{ name: "OPENAI_API_KEY", env: "OPENAI_API_KEY" }],
        token: "top-secret",
      }),
    ).toEqual({
      registry: {
        path: "/tmp/registry.json",
        apiKey: "[REDACTED]",
        auth: { privateKey: "[REDACTED]" },
      },
      secretTargets: [{ name: "OPENAI_API_KEY", env: "OPENAI_API_KEY" }],
      token: "[REDACTED]",
    });
  });

  it("redacts inline secrets in diagnostic text", () => {
    expect(
      redactText(
        "OPENAI_API_KEY=sk-test-secret Authorization: Bearer abc123 token: raw-token",
      ),
    ).toBe(
      "OPENAI_API_KEY=[REDACTED] Authorization: [REDACTED] token: [REDACTED]",
    );
  });

  it("keeps CONTRACTS.md aligned with persisted schema field names", async () => {
    const contracts = await readFile(
      join(process.cwd(), "CONTRACTS.md"),
      "utf8",
    );

    expect(contracts).toContain("`ComputeProvider`");
    expect(contracts).toContain("`attest(sandbox, nonce)`");

    for (const field of requiredObjectKeys(SandboxSpecSchema)) {
      expect(contracts, `SandboxSpec.${field}`).toContain(field);
    }
    for (const field of requiredObjectKeys(SandboxSchema)) {
      expect(contracts, `Sandbox.${field}`).toContain(field);
    }
    for (const field of requiredObjectKeys(AttestationDocSchema)) {
      expect(contracts, `AttestationDoc.${field}`).toContain(field);
    }
    for (const field of requiredObjectKeys(BackupManifestSchema)) {
      expect(contracts, `BackupManifest.${field}`).toContain(field);
    }
    for (const field of requiredObjectKeys(AgentSpecSchema)) {
      expect(contracts, `AgentSpec.${field}`).toContain(field);
    }
  });
});

function requiredObjectKeys(schema: {
  shape: Record<string, { isOptional(): boolean }>;
}): string[] {
  return Object.entries(schema.shape)
    .filter(([, value]) => !value.isOptional())
    .map(([key]) => key);
}
