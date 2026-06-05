import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import { SiweMessage } from "siwe";

const HOST = "127.0.0.1";
const PORT = Number(process.env.E2E_CONTROL_PLANE_PORT ?? "8088");
const WEB_ORIGIN = process.env.E2E_WEB_ORIGIN ?? "http://127.0.0.1:3100";
const WEB_HOST = new URL(WEB_ORIGIN).host;
const ANVIL_PORT = Number(
  process.env.NEXT_PUBLIC_E2E_RPC?.split(":").pop() ?? "8545",
);
const sessions = new Map();
const nonces = new Set();

const anvil = spawn(
  "anvil",
  ["--host", "127.0.0.1", "--port", String(ANVIL_PORT), "--silent"],
  { stdio: "inherit" },
);

anvil.on("exit", (code, signal) => {
  if (signal === null && code !== 0) process.exit(code ?? 1);
});

const server = createServer(async (request, response) => {
  const origin = request.headers.origin;
  response.setHeader("Access-Control-Allow-Origin", origin || WEB_ORIGIN);
  response.setHeader("Access-Control-Allow-Credentials", "true");
  response.setHeader("Access-Control-Allow-Headers", "content-type");
  response.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");

  if (request.method === "OPTIONS") {
    response.writeHead(204).end();
    return;
  }

  try {
    const url = new URL(request.url ?? "/", `http://${HOST}:${PORT}`);

    if (request.method === "GET" && url.pathname === "/health") {
      json(response, 200, { ok: true });
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/auth/nonce") {
      const nonce = randomBytes(12).toString("base64url");
      nonces.add(nonce);
      json(response, 200, { nonce });
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/auth/verify") {
      const { message, signature } = await readJson(request);
      if (typeof message !== "string" || typeof signature !== "string") {
        json(response, 400, { error: "message and signature are required" });
        return;
      }

      const siwe = new SiweMessage(message);
      if (!nonces.delete(siwe.nonce)) {
        json(response, 401, { error: "nonce is unknown or already used" });
        return;
      }

      const verification = await siwe.verify({
        signature,
        domain: WEB_HOST,
        nonce: siwe.nonce,
      });
      if (!verification.success) {
        console.error("SIWE verification failed", verification.error);
        json(response, 401, { error: "SIWE verification failed" });
        return;
      }

      const session = randomBytes(18).toString("base64url");
      sessions.set(session, siwe.address);
      response.setHeader(
        "Set-Cookie",
        `tinyagent_e2e_session=${session}; HttpOnly; SameSite=Lax; Path=/; Max-Age=3600`,
      );
      json(response, 200, { address: siwe.address });
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/auth/logout") {
      const session = sessionFromCookie(request.headers.cookie);
      if (session) sessions.delete(session);
      response.setHeader(
        "Set-Cookie",
        "tinyagent_e2e_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0",
      );
      json(response, 200, { ok: true });
      return;
    }

    const address = authenticatedAddress(request);
    if (!address) {
      json(response, 401, { error: "unauthenticated" });
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/me") {
      json(response, 200, { address });
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/packs") {
      json(response, 200, packs());
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/agents") {
      json(response, 200, agents());
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/billing/config") {
      json(response, 200, {
        chainId: 31337,
        token: "0x0000000000000000000000000000000000000001",
        contract: "0x0000000000000000000000000000000000000002",
        decimals: 6,
      });
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/billing/balance") {
      json(response, 200, { balanceUnits: "25000000" });
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/billing/quote") {
      json(response, 200, {
        hours: Number(url.searchParams.get("hours") ?? "1"),
        resources: {
          vcpu: Number(url.searchParams.get("vcpu") ?? "2"),
          memMiB: Number(url.searchParams.get("memMiB") ?? "4096"),
          diskGiB: Number(url.searchParams.get("diskGiB") ?? "40"),
        },
        phalaCostUsd: 1,
        markup: 0.2,
        priceUsd: 1.2,
        marginUsd: 0.2,
      });
      return;
    }

    json(response, 404, {
      error: `unhandled e2e route: ${request.method} ${url.pathname}`,
    });
  } catch (error) {
    json(response, 500, {
      error: error instanceof Error ? error.message : String(error),
    });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`e2e control-plane listening on http://${HOST}:${PORT}`);
});

function packs() {
  return [
    {
      name: "openclaw",
      type: "agent",
      description: "OpenClaw - stateful AI agent with persistent gateway",
      brain: true,
      ports: { gateway: 3001 },
      dataVolumeGiB: 80,
      defaultModel: "us.anthropic.claude-opus-4-6-v1",
      runtime: "lowkey",
      needs: {
        docker: false,
        postgres: false,
        gpu: false,
        interactiveLogin: false,
      },
      modelModes: ["bedrock", "api-key"],
      language: "shell",
    },
    {
      name: "base-shell",
      type: "base",
      description: "Open Linux shell runtime for Lightning sandboxes",
      brain: false,
      ports: {},
      dataVolumeGiB: 0,
      runtime: "lightning",
      needs: {},
      modelModes: ["api-key"],
      language: "shell",
    },
  ];
}

function agents() {
  return [
    {
      name: "scribe",
      pack: "openclaw",
      provider: "dstack-cvm",
      sandboxId: "dstack-e2e-scribe",
      spaceId: "space:e2e",
      agentDid:
        "did:pkh:eip155:31337:0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266",
      stateDir: "/state",
      runnerImage: "tinyagent-runner:test",
      composeHash: "e2e-compose",
      modelMode: "bedrock",
      gatewayPort: 3001,
      createdAt: new Date("2026-01-01T00:00:00.000Z").toISOString(),
    },
    {
      name: "workspace",
      pack: "base-shell",
      provider: "lightning",
      sandboxId: "lightning-e2e-workspace",
      spaceId: "space:e2e",
      agentDid:
        "did:pkh:eip155:31337:0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266",
      stateDir: "/state",
      runnerImage: "tinyagent-runner:test",
      modelMode: "api-key",
      gatewayPort: 3001,
      createdAt: new Date("2026-01-02T00:00:00.000Z").toISOString(),
    },
  ];
}

function authenticatedAddress(request) {
  const session = sessionFromCookie(request.headers.cookie);
  return session === undefined ? undefined : sessions.get(session);
}

function sessionFromCookie(cookie = "") {
  return cookie
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith("tinyagent_e2e_session="))
    ?.slice("tinyagent_e2e_session=".length);
}

function readJson(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"));
      } catch (error) {
        reject(error);
      }
    });
    request.on("error", reject);
  });
}

function json(response, status, body) {
  response.writeHead(status, { "Content-Type": "application/json" });
  response.end(JSON.stringify(body));
}

function shutdown() {
  server.close();
  anvil.kill("SIGTERM");
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
