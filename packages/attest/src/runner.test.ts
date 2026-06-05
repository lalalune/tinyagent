import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildRunnerAppCompose,
  computeComposeHash,
  serializeAppCompose,
} from "./compose.js";

const lowkeyRef =
  "inceptionstack/lowkey@5e18dac550f8cf0ac509e51679a6e41a6a90e528";
const image = "ghcr.io/tinycloudlabs/tinyagent-runner:0.1.0-lowkey-5e18dac";
const allowedEnvs = [
  "ANTHROPIC_API_KEY",
  "AWS_REGION",
  "BEDROCK_REGION",
  "GATEWAY_TOKEN",
  "OPENAI_API_KEY",
  "TINYAGENT_BACKUP_PUBLIC_KEY",
];

describe("committed runner image artifacts", () => {
  it("keeps app-compose.json byte-identical to the deterministic generator", async () => {
    const appCompose = buildRunnerAppCompose({
      name: "tinyagent-openclaw",
      image,
      pack: "openclaw",
      lowkeyRef,
      gatewayPort: 3001,
      allowedEnvs,
    });

    const serialized = `${serializeAppCompose(appCompose)}\n`;
    const committed = await readFile(
      join(process.cwd(), "runner", "app-compose.json"),
      "utf8",
    );
    const hash = `${computeComposeHash(appCompose)}\n`;
    const committedHash = await readFile(
      join(process.cwd(), "runner", "app-compose.sha256"),
      "utf8",
    );

    expect(committed).toBe(serialized);
    expect(committedHash).toBe(hash);
    expect(computeComposeHash(appCompose)).toBe(
      "sha256:71629fd79f5a1a76ba60d8e99b214379654f26ac659809df43ed34e75679a897",
    );
    expect(computeComposeHash(appCompose)).toBe(
      computeComposeHash(
        buildRunnerAppCompose({
          name: "tinyagent-openclaw",
          image,
          pack: "openclaw",
          lowkeyRef,
          gatewayPort: 3001,
          allowedEnvs: [...allowedEnvs].reverse(),
        }),
      ),
    );
  });

  it("pins runner image inputs and includes OpenClaw prerequisites", async () => {
    const dockerfile = await readFile(
      join(process.cwd(), "runner", "Dockerfile"),
      "utf8",
    );
    const entrypoint = await readFile(
      join(process.cwd(), "runner", "entrypoint.sh"),
      "utf8",
    );
    const vendor = JSON.parse(
      await readFile(
        join(process.cwd(), "vendor", "lowkey", "TINYAGENT_VENDOR.json"),
        "utf8",
      ),
    ) as { ref: string };

    expect(vendor.ref).toBe(lowkeyRef);
    expect(dockerfile).toContain("FROM oven/bun:1.1.38-debian");
    expect(dockerfile).not.toContain(":latest");
    expect(dockerfile).toContain(
      "bun install --frozen-lockfile --ignore-scripts",
    );
    expect(dockerfile).toContain("COPY vendor/lowkey /opt/lowkey");
    expect(dockerfile).toContain(
      "COPY runner/systemctl-shim.sh /usr/local/bin/systemctl",
    );
    expect(dockerfile).toContain(
      "COPY runner/loginctl-shim.sh /usr/local/bin/loginctl",
    );
    expect(dockerfile).toContain(
      "test -x /opt/lowkey/packs/openclaw/install.sh",
    );
    expect(dockerfile).toContain("test -f /opt/lowkey/deploy/brain/AGENTS.md");
    expect(dockerfile).toContain("tini");
    expect(dockerfile).toContain("gettext-base");
    expect(dockerfile).toContain("jq");
    expect(dockerfile).toContain("NODE_VERSION=22.21.1");
    expect(dockerfile).toContain("https://nodejs.org/dist/v${NODE_VERSION}");
    expect(dockerfile).toContain("npm --version");
    expect(dockerfile).toContain("openssh-client");
    expect(entrypoint).toContain("openclaw gateway");
    expect(entrypoint).toContain('--port "${GATEWAY_PORT}"');
  });

  it("keeps reproducible runner-image CI wired to publish measurements", async () => {
    const workflow = await readFile(
      join(process.cwd(), "..", ".github", "workflows", "tinyagent-runner.yml"),
      "utf8",
    );

    expect(workflow).toContain("TinyAgent Runner Reproducibility");
    expect(workflow).toContain("docker build");
    expect(workflow).toContain("--iidfile runner-measurements.image-id.txt");
    expect(workflow).toContain("runner-measurements.json");
    expect(workflow).toContain("actions/upload-artifact@v4");
    expect(workflow).toContain("tinyagent-runner-measurements");
    expect(workflow).toContain("runner/app-compose.sha256");
  });
});
