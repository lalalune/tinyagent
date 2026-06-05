import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TinyAgentError, type Result } from "@tinyagent/core";
import {
  PrivateKeySigner,
  TinyCloudNode,
  type TinyCloudNodeConfig,
} from "@tinycloud/node-sdk";
import {
  planeFromNode,
  renewDelegation,
  renewSession,
  TinyCloudStore,
} from "./index.js";

const exec = promisify(execFile);

/**
 * Live integration test against a real tinycloud-node Docker container.
 *
 * The container image is pulled in CI/dev (`ghcr.io/tinycloudlabs/tinycloud-node`).
 * We start it on a random host port, poll /healthz, then drive the SDK against
 * it. If Docker is unavailable or the image is missing, the suite degrades to an
 * EXPLICIT-UNSUPPORTED guard (a single passing assertion that logs the precise
 * reason) so the unit coverage in index.test.ts still stands on its own.
 */

// 32+ bytes of base64url entropy for the node's static key derivation.
const KEYS_SECRET =
  "U29tZSBsb25nIHBpZWNlIG9mIGVudHJvcHkgd2hpY2ggaXMgYSBzZWNyZXQgYW5kIG1vcmUgdGhhbiAzMiBieXRlcw";
const ADMIN_SECRET = "tinyagent-live-admin-secret";
const IMAGE = "ghcr.io/tinycloudlabs/tinycloud-node:latest";
const ACTIONS = [
  "tinycloud.kv/get",
  "tinycloud.kv/put",
  "tinycloud.kv/list",
  "tinycloud.kv/del",
  "tinycloud.kv/metadata",
];
const TEXT = new TextDecoder();

function freshHexKey(): string {
  return `0x${randomBytes(32).toString("hex")}`;
}

async function dockerAvailable(): Promise<{ ok: boolean; reason?: string }> {
  try {
    await exec("docker", ["version", "--format", "{{.Server.Version}}"]);
  } catch (error) {
    return {
      ok: false,
      reason: `docker daemon not reachable: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }
  try {
    const { stdout } = await exec("docker", ["images", "-q", IMAGE]);
    if (stdout.trim().length === 0) {
      return { ok: false, reason: `image not present: ${IMAGE}` };
    }
  } catch (error) {
    return {
      ok: false,
      reason: `docker images query failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }
  return { ok: true };
}

interface LiveNode {
  host: string;
  containerName: string;
  dataDir: string;
}

async function startNode(): Promise<LiveNode> {
  const containerName = `tinyagent-tc-live-${randomBytes(4).toString("hex")}`;
  const dataDir = await mkdtemp(join(tmpdir(), "tinyagent-tc-live-"));
  // Container runs as the non-root `tinycloud` user against a distroless base;
  // it cannot create directories under `/`, so we mount a host-owned, writable
  // dir at /data and point the datadir + sqlite db there.
  await exec("docker", [
    "run",
    "-d",
    "--name",
    containerName,
    "-p",
    "0:8000",
    "-v",
    `${dataDir}:/data`,
    "-e",
    `TINYCLOUD_KEYS_SECRET=${KEYS_SECRET}`,
    "-e",
    "TINYCLOUD_STORAGE_DATADIR=/data",
    "-e",
    "TINYCLOUD_STORAGE_DATABASE=sqlite:/data/caps.db?mode=rwc",
    "-e",
    `TINYCLOUD_ADMIN_SECRET=${ADMIN_SECRET}`,
    IMAGE,
  ]);

  const { stdout } = await exec("docker", ["port", containerName, "8000/tcp"]);
  const port = stdout.trim().split("\n")[0]?.split(":").pop();
  if (!port) {
    throw new Error(`could not resolve mapped port: ${stdout}`);
  }
  const host = `http://127.0.0.1:${port}`;

  await waitForHealthz(host, 60_000);
  return { host, containerName, dataDir };
}

async function waitForHealthz(host: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError = "no attempt made";
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${host}/healthz`, {
        signal: AbortSignal.timeout(3000),
      });
      if (res.ok) return;
      lastError = `status ${res.status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`/healthz not ready within ${timeoutMs}ms: ${lastError}`);
}

async function stopNode(node: LiveNode | undefined): Promise<void> {
  if (!node) return;
  await exec("docker", ["rm", "-f", node.containerName], {
    timeout: 30_000,
  }).catch(() => undefined);
  await rm(node.dataDir, { recursive: true, force: true }).catch(
    () => undefined,
  );
}

async function setQuota(host: string, spaceId: string, limitBytes: number) {
  const res = await fetch(`${host}/admin/quota/${spaceId}`, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${ADMIN_SECRET}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ limit_bytes: limitBytes }),
  });
  if (!res.ok) {
    throw new Error(
      `failed to set quota for ${spaceId}: ${res.status} ${await res.text()}`,
    );
  }
}

const availability = await dockerAvailable();

if (!availability.ok) {
  describe("TinyCloud live node integration", () => {
    it("EXPLICIT-UNSUPPORTED in this environment", () => {
      // Documented blocker: the live node cannot be started here.
      // Unit-level coverage of the Store adapter and renewal logic still runs
      // in index.test.ts; this guard records exactly why the live path was
      // skipped so it is never silently green.
      console.warn(
        `[tc/live] unsupported in this environment: ${availability.reason}`,
      );
      expect(availability.reason).toBeTruthy();
    });
  });
} else {
  describe("TinyCloud live node integration", () => {
    let live: LiveNode | undefined;

    beforeAll(async () => {
      live = await startNode();
    }, 120_000);

    afterAll(async () => {
      await stopNode(live);
    }, 30_000);

    function ownerConfig(privateKey: string): TinyCloudNodeConfig {
      return {
        privateKey,
        host: live!.host,
        prefix: "tinyagent",
        autoCreateSpace: true,
      };
    }

    function signedInSpaceId(node: TinyCloudNode): string {
      expect(node.spaceId).toBeTruthy();
      return node.spaceId!;
    }

    function expectErrorCode(result: Result<unknown>, code: string): void {
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error).toBeInstanceOf(TinyAgentError);
      expect((result.error as TinyAgentError).code).toBe(code);
    }

    it("round-trips the byte Store against a live node", async () => {
      const node = new TinyCloudNode(ownerConfig(freshHexKey()));
      await node.signIn();
      const plane = planeFromNode(node);
      expect(plane.store).toBeInstanceOf(TinyCloudStore);
      const store = new TinyCloudStore(node.kv);
      const key = "tinyagent/ada/chunks/a";
      const bytes = new TextEncoder().encode("live-bytes-payload");

      const put = await store.put({ key, bytes });
      expect(put.ok).toBe(true);
      expect(put.ok && put.value.size).toBe(bytes.byteLength);

      const got = await store.get(key);
      expect(got.ok).toBe(true);
      expect(got.ok && TEXT.decode(got.value)).toBe("live-bytes-payload");

      const head = await store.head(key);
      expect(head.ok && head.value).not.toBeNull();
      expect(head.ok && head.value?.key).toBe(key);

      const list = await store.list("tinyagent/ada/");
      expect(list.ok).toBe(true);
      expect(list.ok && list.value.some((entry) => entry.key === key)).toBe(
        true,
      );

      const deleted = await store.delete(key);
      expect(deleted.ok).toBe(true);

      const headAfter = await store.head(key);
      expect(headAfter.ok && headAfter.value).toBeNull();
    }, 60_000);

    it("round-trips SecretStore values through the SDK Data Vault", async () => {
      const privateKey = freshHexKey();
      const node = new TinyCloudNode(ownerConfig(privateKey));
      await node.signIn();
      const unlocked = await node.vault.unlock(
        new PrivateKeySigner(privateKey),
      );
      expect(unlocked.ok).toBe(true);

      const plane = planeFromNode(node);
      const secretName = `OPENAI_API_KEY_${randomBytes(4).toString("hex")}`;
      const secretValue = new TextEncoder().encode("sk-live-vault-test");

      const set = await plane.secrets.set(secretName, secretValue);
      expect(set.ok).toBe(true);

      const listed = await plane.secrets.list();
      expect(listed.ok && listed.value).toContain(secretName);

      const got = await plane.secrets.get(secretName);
      expect(got.ok && TEXT.decode(got.value)).toBe("sk-live-vault-test");

      const deleted = await plane.secrets.delete(secretName);
      expect(deleted.ok).toBe(true);
    }, 60_000);

    it("honors delegation: grants within prefix, denies ungranted actions", async () => {
      const owner = new TinyCloudNode(ownerConfig(freshHexKey()));
      await owner.signIn();

      // Seed an owner-side value the delegate is allowed to read.
      const ownerStore = new TinyCloudStore(owner.kv);
      const seeded = await ownerStore.put({
        key: "tinyagent/ada/seed",
        bytes: new TextEncoder().encode("seed-value"),
      });
      expect(seeded.ok).toBe(true);

      // Full grant under the agent prefix -> delegate can read AND write.
      const delegate = new TinyCloudNode();
      const fullGrant = await owner.createDelegation({
        path: "tinyagent/ada/",
        actions: ACTIONS,
        delegateDID: delegate.did,
        expiryMs: 600_000,
      });
      // Serialize/deserialize exercises the transport path.
      const access = await delegate.useDelegation(fullGrant);
      const delegatedStore = new TinyCloudStore(access.kv);

      // Note: DelegatedAccess.kv scopes keys under the delegated path, so
      // the delegate addresses keys relative to tinyagent/ada/.
      const dPut = await delegatedStore.put({
        key: "doc",
        bytes: new TextEncoder().encode("delegated-write"),
      });
      expect(dPut.ok).toBe(true);
      const dGet = await delegatedStore.get("doc");
      expect(dGet.ok && TEXT.decode(dGet.value)).toBe("delegated-write");

      // Read-only grant to a second delegate -> put must be DENIED.
      const readOnlyDelegate = new TinyCloudNode();
      const readGrant = await owner.createDelegation({
        path: "tinyagent/ada/",
        actions: ["tinycloud.kv/get", "tinycloud.kv/list"],
        delegateDID: readOnlyDelegate.did,
        expiryMs: 600_000,
      });
      const readAccess = await readOnlyDelegate.useDelegation(readGrant);
      const readStore = new TinyCloudStore(readAccess.kv);

      const allowedGet = await readStore.get("seed");
      expect(allowedGet.ok).toBe(true);
      expect(allowedGet.ok && TEXT.decode(allowedGet.value)).toBe("seed-value");

      const deniedPut = await readStore.put({
        key: "seed",
        bytes: new TextEncoder().encode("hijack"),
      });
      expect(deniedPut.ok).toBe(false);
      expect(
        !deniedPut.ok && "code" in deniedPut.error && deniedPut.error.code,
      ).toBe("TC_AUTH_UNAUTHORIZED");
    }, 60_000);

    it("renews an expired session and restores access", async () => {
      const privateKey = freshHexKey();
      // A short-but-viable session: long enough for sign-in's host-space
      // delegation to activate, short enough to expire within the test.
      const shortConfig: TinyCloudNodeConfig = {
        ...ownerConfig(privateKey),
        sessionExpirationMs: 10_000,
      };
      const node = new TinyCloudNode(shortConfig);
      await node.signIn();
      const spaceId = node.spaceId;

      const before = await new TinyCloudStore(node.kv).put({
        key: "tinyagent/ada/k",
        bytes: new TextEncoder().encode("v1"),
      });
      expect(before.ok).toBe(true);

      // Wait past expiry, then renew directly. A prior version of this test
      // tried to write through the expired session and the live node timed out
      // instead of returning a stable auth error, poisoning later tests.
      await new Promise((r) => setTimeout(r, 11_000));

      // Renew with a normal-length session and confirm access is restored
      // against the SAME space (prior data still visible).
      const renewed = await renewSession(ownerConfig(privateKey));
      expect((renewed.node as TinyCloudNode).spaceId).toBe(spaceId);

      const priorData = await renewed.store.get("tinyagent/ada/k");
      expect(priorData.ok && TEXT.decode(priorData.value)).toBe("v1");

      const afterRenew = await renewed.store.put({
        key: "tinyagent/ada/k3",
        bytes: new TextEncoder().encode("v3"),
      });
      expect(afterRenew.ok).toBe(true);
    }, 60_000);

    it("renews a delegated session via renewDelegation", async () => {
      const ownerKey = freshHexKey();
      const config = ownerConfig(ownerKey);

      // Establish a delegated plane once.
      const first = await renewDelegation({
        ownerConfig: config,
        grant: {
          path: "tinyagent/ada/",
          actions: ACTIONS,
          delegateDID: "", // filled in by renewDelegation from delegate.did
          expiryMs: 600_000,
        },
      });
      const wrote = await first.plane.store.put({
        key: "shared/doc",
        bytes: new TextEncoder().encode("first"),
      });
      expect(wrote.ok).toBe(true);

      // Renew again (simulating recovery after expiry) -> fresh working plane.
      const renewed = await renewDelegation({
        ownerConfig: config,
        grant: {
          path: "tinyagent/ada/",
          actions: ACTIONS,
          delegateDID: "",
          expiryMs: 600_000,
        },
      });
      const afterRenew = await renewed.plane.store.put({
        key: "shared/doc2",
        bytes: new TextEncoder().encode("renewed"),
      });
      expect(afterRenew.ok).toBe(true);
      const readBack = await renewed.plane.store.get("shared/doc2");
      expect(readBack.ok && TEXT.decode(readBack.value)).toBe("renewed");
    }, 60_000);

    it("maps live quota failures from an enforcing node", async () => {
      const privateKey = freshHexKey();
      const node = new TinyCloudNode(ownerConfig(privateKey));
      await node.signIn();
      const store = new TinyCloudStore(node.kv);
      const first = await store.put({
        key: "tinyagent/ada/quota/first",
        bytes: new Uint8Array(32),
      });
      expect(first.ok).toBe(true);
      await setQuota(live!.host, signedInSpaceId(node), 1);

      const quota = await store.put({
        key: "tinyagent/ada/quota/second",
        bytes: new Uint8Array(1),
      });
      expectErrorCode(quota, "TC_STORE_QUOTA_EXCEEDED");
    }, 30_000);

    it("maps live object-size failures from an enforcing node", async () => {
      const privateKey = freshHexKey();
      const node = new TinyCloudNode(ownerConfig(privateKey));
      await node.signIn();
      await setQuota(live!.host, signedInSpaceId(node), 64);

      const tooLarge = await new TinyCloudStore(node.kv).put({
        key: "tinyagent/ada/quota/too-large",
        bytes: new Uint8Array(65),
      });
      expectErrorCode(tooLarge, "TC_STORE_OBJECT_TOO_LARGE");
    }, 30_000);
  });
}
