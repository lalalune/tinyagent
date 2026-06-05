import { spawn } from "node:child_process";

const HOST = process.env.TINYAGENT_DEV_HOST ?? "127.0.0.1";
const WEB_PORT = process.env.TINYAGENT_WEB_PORT ?? "3000";
const CONTROL_PLANE_PORT = process.env.E2E_CONTROL_PLANE_PORT ?? "8088";
const RPC_PORT = process.env.TINYAGENT_E2E_RPC_PORT ?? "8545";

const webOrigin = `http://${HOST}:${WEB_PORT}`;
const controlPlaneUrl = `http://${HOST}:${CONTROL_PLANE_PORT}`;
const rpcUrl = `http://${HOST}:${RPC_PORT}`;

const children = new Set();

function run(name, command, args, options = {}) {
  const child = spawn(command, args, {
    stdio: "inherit",
    ...options,
    env: {
      ...process.env,
      ...options.env,
    },
  });
  children.add(child);
  child.on("exit", (code, signal) => {
    children.delete(child);
    if (!shuttingDown && (code !== 0 || signal)) {
      console.error(
        `${name} exited ${signal ? `with signal ${signal}` : `with code ${code}`}`,
      );
      shutdown(code ?? 1);
    }
  });
  return child;
}

let shuttingDown = false;

function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of children) child.kill("SIGTERM");
  setTimeout(() => process.exit(code), 250).unref();
}

process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));

run("control-plane", "node", ["apps/web/e2e/test-control-plane.mjs"], {
  env: {
    E2E_CONTROL_PLANE_PORT: CONTROL_PLANE_PORT,
    E2E_WEB_ORIGIN: webOrigin,
    NEXT_PUBLIC_E2E_RPC: rpcUrl,
  },
});

run("web", "bun", ["run", "dev", "--", "-H", HOST, "-p", WEB_PORT], {
  cwd: "apps/web",
  env: {
    NEXT_PUBLIC_CONTROL_PLANE_URL: controlPlaneUrl,
    NEXT_PUBLIC_E2E: "1",
    NEXT_PUBLIC_E2E_RPC: rpcUrl,
  },
});

console.log(`TinyAgent preview: ${webOrigin}`);
console.log(`Control plane: ${controlPlaneUrl}`);
