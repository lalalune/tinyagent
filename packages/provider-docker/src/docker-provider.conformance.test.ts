import { createConnection } from "node:net";
import Docker from "dockerode";
import getPort from "get-port";
import { afterAll, describe, expect, it, vi } from "vitest";
import type {
  ExecChunk,
  ExecSpec,
  Sandbox,
  SandboxSpec,
} from "@tinyagent/core";
import { providerConformanceSuite } from "@tinyagent/provider-core";
import { DockerProvider } from "./docker-provider.js";

const IMAGE = "alpine:3.20";
const REMOTE_PORT = 8080;
const RUN_ID = `tinyagent-docker-conformance-${Date.now()}-${Math.floor(
  Math.random() * 1e6,
)}`;
const LABEL_KEY = "tinyagent.test";

vi.setConfig({ testTimeout: 120000, hookTimeout: 60000 });

const docker = new Docker();

/**
 * alpine's default command (`/bin/sh`) exits immediately without a TTY, so a
 * provisioned container would not stay running for exec/file/forward tests.
 * This subclass keeps the container alive by injecting a long sleep as the
 * container command, while otherwise reusing the production provision logic's
 * port publishing so `forwardPort` resolves to a real published host port.
 */
class KeepaliveDockerProvider extends DockerProvider {
  private readonly raw: Docker;
  constructor(d: Docker) {
    super(d);
    this.raw = d;
  }

  async provision(spec: SandboxSpec): Promise<Sandbox> {
    const exposedPorts: Record<string, Record<string, never>> = {};
    const portBindings: Record<string, Array<{ HostPort: string }>> = {};
    for (const port of spec.agent.ports) {
      const key = `${port.port}/tcp`;
      const hostPort = await getPort();
      exposedPorts[key] = {};
      portBindings[key] = [{ HostPort: String(hostPort) }];
    }
    const container = await this.raw.createContainer({
      Image: spec.image,
      name: spec.name,
      Cmd: ["sleep", "3600"],
      Env: Object.entries(spec.environment).map(([k, v]) => `${k}=${v}`),
      Labels: spec.labels,
      ExposedPorts: exposedPorts,
      HostConfig: {
        AutoRemove: false,
        PortBindings: portBindings,
      },
    });
    return {
      id: container.id,
      name: spec.name,
      provider: "local-docker",
      status: "provisioned",
      metadata: Object.fromEntries(
        Object.entries(portBindings).map(([k, b]) => [
          `port:${k}`,
          b[0]?.HostPort ?? "",
        ]),
      ),
    };
  }
}

const provider = new KeepaliveDockerProvider(docker);

function specFor(name: string): SandboxSpec {
  return {
    name: `${RUN_ID}-${name}`,
    provider: "local-docker",
    image: IMAGE,
    environment: {},
    mounts: [],
    labels: { [LABEL_KEY]: RUN_ID },
    agent: {
      name: "conformance-agent",
      dependencies: [],
      ports: [{ name: "http", port: REMOTE_PORT, protocol: "tcp" }],
      stateDirs: [],
      modelModes: [],
      secretTargets: [],
      headlessCaveats: [],
      brain: false,
    },
  } as SandboxSpec;
}

async function waitFor(
  predicate: () => Promise<boolean>,
  { timeoutMs = 15000, intervalMs = 200 } = {},
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return false;
}

function fetchTunnelBytes(port: number, timeoutMs = 5000): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = createConnection({ host: "127.0.0.1", port }, () => {
      socket.write("GET / HTTP/1.0\r\nHost: localhost\r\n\r\n");
    });
    const chunks: Buffer[] = [];
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error("tunnel read timed out"));
    }, timeoutMs);
    socket.on("data", (d) => chunks.push(Buffer.from(d)));
    socket.on("end", () => {
      clearTimeout(timer);
      resolve(Buffer.concat(chunks).toString("utf8"));
    });
    socket.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
  });
}

afterAll(async () => {
  try {
    const containers = await docker.listContainers({
      all: true,
      filters: { label: [`${LABEL_KEY}=${RUN_ID}`] },
    });
    await Promise.all(
      containers.map((c) =>
        docker
          .getContainer(c.Id)
          .remove({ force: true })
          .catch(() => {}),
      ),
    );
  } catch {
    // Cleanup failures should not hide the test failure that created them.
  }
});

providerConformanceSuite("docker", {
  provider,
  sandbox: specFor("suite"),
  remotePort: REMOTE_PORT,
});

describe("DockerProvider real-daemon end-to-end (WP-13)", () => {
  it("provision -> start -> exec -> files -> active port forward -> stop -> destroy", async () => {
    const spec = specFor("e2e");
    const sandbox = await provider.provision(spec);
    let tunnelPort: number | undefined;
    let tunnelClose: (() => Promise<void>) | undefined;

    try {
      await provider.start(sandbox);

      const out: ExecChunk[] = [];
      for await (const chunk of provider.exec(sandbox, {
        command: ["sh", "-lc", "printf hello-stdout; printf err 1>&2; exit 7"],
        env: {
          NODE_OPTIONS: "--max-old-space-size=512",
          npm_config_jobs: "1",
          npm_config_cache: "/tmp/npm-cache",
        },
      })) {
        out.push(chunk);
      }
      const stdout = out.find((c) => c.stream === "stdout");
      const stderr = out.find((c) => c.stream === "stderr");
      const exit = out.find((c) => c.stream === "exit");
      expect(stdout && new TextDecoder().decode(stdout.data)).toBe(
        "hello-stdout",
      );
      expect(stderr && new TextDecoder().decode(stderr.data)).toBe("err");
      expect(exit?.exitCode).toBe(7);

      const payload = `roundtrip-${RUN_ID}`;
      await provider.putFiles(sandbox, [
        {
          path: "/tmp/roundtrip.txt",
          content: new TextEncoder().encode(payload),
        },
      ]);
      const blobs = await provider.getFiles(sandbox, ["/tmp/roundtrip.txt"]);
      expect(blobs[0]?.path).toBe("/tmp/roundtrip.txt");
      expect(new TextDecoder().decode(blobs[0]?.content)).toBe(payload);

      // alpine:3.20 busybox has no httpd applet, so use a busybox-nc loop that
      // serves a fixed HTTP/1.0 response on every inbound connection. The loop
      // is detached (nohup + background + redirected fds) so the exec stream
      // closes and the call returns immediately.
      const body = `tunnel-ok-${RUN_ID}`;
      const httpResponse = `HTTP/1.0 200 OK\r\nContent-Length: ${body.length}\r\nConnection: close\r\n\r\n${body}`;
      const serverScript = [
        "while true; do",
        `  printf '%s' "$RESP" | nc -l -p ${REMOTE_PORT} >/dev/null 2>&1`,
        "done",
      ].join("\n");
      await provider.putFiles(sandbox, [
        {
          path: "/srv.sh",
          content: new TextEncoder().encode(serverScript),
          mode: "0755",
        },
      ]);
      const launch: ExecChunk[] = [];
      for await (const chunk of provider.exec(sandbox, {
        command: [
          "sh",
          "-lc",
          "export RESP; nohup sh /srv.sh >/dev/null 2>&1 & echo launched",
        ],
        env: { RESP: httpResponse },
      })) {
        launch.push(chunk);
      }
      const launchExit = launch.find((c) => c.stream === "exit");
      expect(launchExit?.exitCode).toBe(0);

      const tunnel = await provider.forwardPort(sandbox, REMOTE_PORT, 0);
      tunnelPort = tunnel.localPort;
      tunnelClose = () => tunnel.close();
      expect(tunnel.remotePort).toBe(REMOTE_PORT);
      expect(tunnel.localPort).toBeGreaterThan(0);

      let response = "";
      const ok = await waitFor(async () => {
        try {
          response = await fetchTunnelBytes(tunnel.localPort);
          return response.includes(body);
        } catch {
          return false;
        }
      });
      expect(ok, `tunnel response was: ${response}`).toBe(true);
      expect(response).toContain(body);

      await tunnel.close();
      tunnelClose = undefined;
      await expect(fetchTunnelBytes(tunnelPort, 1500)).rejects.toBeTruthy();

      const attestation = await provider.attest(
        sandbox,
        new Uint8Array([1, 2, 3]),
      );
      expect(attestation).toBeNull();

      await provider.stop(sandbox);
      await provider.destroy(sandbox);

      const gone = await waitFor(async () => {
        const list = await docker.listContainers({
          all: true,
          filters: { label: [`${LABEL_KEY}=${RUN_ID}`] },
        });
        return list.every((c) => c.Names.every((n) => !n.includes("-e2e")));
      });
      expect(gone).toBe(true);
    } finally {
      if (tunnelClose) await tunnelClose().catch(() => {});
      await provider.destroy(sandbox).catch(() => {});
    }
  }, 120000);
});

describe("DockerProvider Lowkey runner evidence (WP-14)", () => {
  it("installs and verifies the stateless codex-cli pack inside tinyagent-runner:test", async () => {
    try {
      await docker.getImage("tinyagent-runner:test").inspect();
    } catch {
      console.warn(
        "skipping codex-cli Lowkey runner evidence: tinyagent-runner:test image is missing",
      );
      return;
    }

    const runnerProvider = new DockerProvider(docker);
    const spec: SandboxSpec = {
      name: `${RUN_ID}-codex-lowkey`,
      provider: "local-docker",
      image: "tinyagent-runner:test",
      environment: {},
      mounts: [],
      labels: { [LABEL_KEY]: RUN_ID },
      agent: {
        name: "codex-cli",
        dependencies: [],
        ports: [],
        stateDirs: [],
        modelModes: ["gpt-5.4"],
        secretTargets: [],
        headlessCaveats: [],
        brain: false,
      },
    };
    const sandbox = await runnerProvider.provision(spec);

    try {
      await runnerProvider.start(sandbox);
      const install = await execOutput(runnerProvider, sandbox, {
        command: [
          "bash",
          "-lc",
          "cd /opt/lowkey && CODEX_CLI_VERSION=latest ./packs/codex-cli/install.sh",
        ],
        env: {},
        timeoutMs: 180000,
      });
      expect(install.exitCode, install.stderr).toBe(0);
      expect(install.stdout).toContain(
        "Marker written: /tmp/pack-codex-cli-done",
      );

      const readiness = await execOutput(runnerProvider, sandbox, {
        command: [
          "bash",
          "-lc",
          "grep -q 'codex --version' /opt/lowkey/packs/codex-cli/manifest.yaml && test -f /tmp/pack-codex-cli-done && codex --version",
        ],
        env: {},
      });
      expect(readiness.exitCode, readiness.stderr).toBe(0);
      expect(readiness.stdout).toMatch(/codex-cli \d+\.\d+\.\d+/);
    } finally {
      await runnerProvider.destroy(sandbox).catch(() => {});
    }
  }, 240000);

  it("installs OpenClaw and starts its token-authenticated gateway inside tinyagent-runner:test", async () => {
    try {
      await docker.getImage("tinyagent-runner:test").inspect();
    } catch {
      console.warn(
        "skipping OpenClaw Lowkey runner evidence: tinyagent-runner:test image is missing",
      );
      return;
    }

    const runnerProvider = new DockerProvider(docker);
    const spec: SandboxSpec = {
      name: `${RUN_ID}-openclaw-lowkey`,
      provider: "local-docker",
      image: "tinyagent-runner:test",
      environment: {},
      mounts: [],
      labels: { [LABEL_KEY]: RUN_ID },
      agent: {
        name: "openclaw",
        dependencies: [],
        ports: [{ name: "gateway", port: 3001, protocol: "tcp" }],
        stateDirs: ["/data/openclaw"],
        modelModes: ["api-key"],
        secretTargets: [],
        headlessCaveats: [],
        brain: true,
      },
    };
    const sandbox = await runnerProvider.provision(spec);
    let tunnelClose: (() => Promise<void>) | undefined;

    try {
      await runnerProvider.start(sandbox);
      const installCommand = {
        command: [
          "bash",
          "-lc",
          "cd /opt/lowkey && ./packs/openclaw/install.sh --model-mode api-key --provider-key dummy-provider-key --token test-token --skip-telemetron",
        ],
        env: {
          NODE_OPTIONS: "--max-old-space-size=512",
          npm_config_cache: "/tmp/npm-cache",
          npm_config_jobs: "1",
        },
        timeoutMs: 240000,
      };
      const firstInstall = await execOutput(
        runnerProvider,
        sandbox,
        installCommand,
      );
      expect(
        firstInstall.exitCode,
        `stdout:\n${firstInstall.stdout}\n\nstderr:\n${firstInstall.stderr}`,
      ).toBe(0);
      expect(firstInstall.stdout).toContain(
        "Marker written: /tmp/pack-openclaw-done",
      );

      await expectOpenClawReady(runnerProvider, sandbox);

      const stopped = await execOutput(runnerProvider, sandbox, {
        command: [
          "bash",
          "-lc",
          "systemctl --user stop openclaw-gateway.service",
        ],
        env: {},
      });
      expect(
        stopped.exitCode,
        `stdout:\n${stopped.stdout}\n\nstderr:\n${stopped.stderr}`,
      ).toBe(0);

      const secondInstall = await execOutput(
        runnerProvider,
        sandbox,
        installCommand,
      );
      expect(
        secondInstall.exitCode,
        `stdout:\n${secondInstall.stdout}\n\nstderr:\n${secondInstall.stderr}`,
      ).toBe(0);
      expect(secondInstall.stdout).toContain(
        "OpenClaw already installed: OpenClaw 2026.5.3-1",
      );
      expect(secondInstall.stdout).toContain(
        "Marker written: /tmp/pack-openclaw-done",
      );

      await expectOpenClawReady(runnerProvider, sandbox);

      const tunnel = await runnerProvider.forwardPort(sandbox, 3001, 0);
      tunnelClose = () => tunnel.close();
      let gatewayHealth: unknown;
      const gatewayReady = await waitFor(
        async () => {
          const controller = new AbortController();
          const timeout = setTimeout(() => controller.abort(), 10000);
          try {
            const response = await fetch(
              `http://127.0.0.1:${tunnel.localPort}/health`,
              {
                headers: { Authorization: "Bearer test-token" },
                signal: controller.signal,
              },
            );
            if (response.status !== 200) return false;
            gatewayHealth = await response.json();
            return true;
          } catch {
            return false;
          } finally {
            clearTimeout(timeout);
          }
        },
        {
          timeoutMs: 60000,
          intervalMs: 1000,
        },
      );
      expect(gatewayReady).toBe(true);
      expect(gatewayHealth).toEqual({ ok: true, status: "live" });
    } finally {
      if (tunnelClose) await tunnelClose().catch(() => {});
      await runnerProvider.destroy(sandbox).catch(() => {});
    }
  }, 300000);
});

async function execOutput(
  provider: DockerProvider,
  sandbox: Sandbox,
  command: ExecSpec,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  let stdout = "";
  let stderr = "";
  let exitCode = 0;
  for await (const chunk of provider.exec(sandbox, command)) {
    if (chunk.stream === "stdout" && chunk.data !== undefined) {
      stdout += new TextDecoder().decode(chunk.data);
    }
    if (chunk.stream === "stderr" && chunk.data !== undefined) {
      stderr += new TextDecoder().decode(chunk.data);
    }
    if (chunk.stream === "exit") exitCode = chunk.exitCode ?? 0;
  }
  return { stdout, stderr, exitCode };
}

async function expectOpenClawReady(
  provider: DockerProvider,
  sandbox: Sandbox,
): Promise<void> {
  const readiness = await execOutput(provider, sandbox, {
    command: [
      "bash",
      "-lc",
      `
        test -f /tmp/pack-openclaw-done
        for i in $(seq 1 90); do
          if systemctl --user is-active openclaw-gateway.service >/tmp/openclaw-active.txt 2>/dev/null && curl -fsS -H 'Authorization: Bearer test-token' http://127.0.0.1:3001/health; then
            cat /tmp/openclaw-active.txt
            openclaw --version
            exit 0
          fi
          sleep 1
        done
        systemctl --user status openclaw-gateway.service || true
        cat /run/user/$(id -u)/tinyagent-systemctl/logs/openclaw-gateway.service.log 2>/dev/null || true
        exit 1
      `,
    ],
    env: {},
  });
  expect(
    readiness.exitCode,
    `stdout:\n${readiness.stdout}\n\nstderr:\n${readiness.stderr}`,
  ).toBe(0);
  expect(readiness.stdout).toContain("active");
  expect(readiness.stdout).toContain('"ok":true');
  expect(readiness.stdout).toContain("OpenClaw 2026.5.3-1");
}
