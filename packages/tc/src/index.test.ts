import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import {
  createLocalTinyCloudPlane,
  TinyCloudStore,
  TinyCloudVaultSecretStore,
} from "./index.js";

describe("local TinyCloud plane", () => {
  it("round-trips Store objects and secrets", async () => {
    const root = await mkdtemp(join(tmpdir(), "tinyagent-tc-"));
    const plane = createLocalTinyCloudPlane({ rootDir: root });

    const put = await plane.store.put({
      key: "tinyagent/ada/chunks/a",
      bytes: new TextEncoder().encode("chunk"),
    });
    expect(put.ok).toBe(true);

    const head = await plane.store.head("tinyagent/ada/chunks/a");
    expect(head.ok && head.value?.size).toBe(5);

    const list = await plane.store.list("tinyagent/ada/");
    expect(list.ok && list.value.map((entry) => entry.key)).toEqual([
      "tinyagent/ada/chunks/a",
    ]);

    const secretSet = await plane.secrets.set(
      "ANTHROPIC_API_KEY",
      new TextEncoder().encode("sk-test"),
    );
    expect(secretSet.ok).toBe(true);
    const secretList = await plane.secrets.list();
    expect(secretList.ok && secretList.value).toEqual(["ANTHROPIC_API_KEY"]);
    const secret = await plane.secrets.get("ANTHROPIC_API_KEY");
    expect(secret.ok && new TextDecoder().decode(secret.value)).toBe("sk-test");
  });

  it("rejects unsafe keys", async () => {
    const root = await mkdtemp(join(tmpdir(), "tinyagent-tc-"));
    const plane = createLocalTinyCloudPlane({ rootDir: root });
    const put = await plane.store.put({
      key: "../escape",
      bytes: new Uint8Array(),
    });
    expect(put.ok).toBe(false);

    const nestedEscape = await plane.store.put({
      key: "safe/../escape",
      bytes: new Uint8Array(),
    });
    expect(nestedEscape.ok).toBe(false);

    const dottedName = await plane.store.put({
      key: "safe/a..b",
      bytes: new Uint8Array(),
    });
    expect(dottedName.ok).toBe(true);
  });

  it("rejects unsafe secret paths", async () => {
    const root = await mkdtemp(join(tmpdir(), "tinyagent-tc-"));
    const plane = createLocalTinyCloudPlane({ rootDir: root });

    const set = await plane.secrets.set(
      "nested/../TOKEN",
      new TextEncoder().encode("secret"),
    );
    expect(set.ok).toBe(false);
  });
});

describe("TinyCloudStore", () => {
  it("adapts SDK KV results to byte Store results", async () => {
    const kv = new FakeKv();
    const store = new TinyCloudStore(kv);
    const bytes = new TextEncoder().encode("chunk");

    const put = await store.put({ key: "tinyagent/ada/chunks/a", bytes });
    expect(put.ok && put.value.size).toBe(bytes.byteLength);

    const get = await store.get("tinyagent/ada/chunks/a");
    expect(get.ok && new TextDecoder().decode(get.value)).toBe("chunk");

    const list = await store.list("tinyagent/ada/");
    expect(list.ok && list.value).toEqual([
      { key: "tinyagent/ada/chunks/a", size: 0 },
    ]);

    const deleted = await store.delete("tinyagent/ada/chunks/a");
    expect(deleted.ok).toBe(true);
  });

  it("decodes live-sdk string envelopes and rejects malformed values", async () => {
    const kv = new FakeKv({ stringifyValues: true });
    const store = new TinyCloudStore(kv);
    const bytes = new TextEncoder().encode("chunk");

    await store.put({ key: "tinyagent/ada/chunks/a", bytes });
    const get = await store.get("tinyagent/ada/chunks/a");
    expect(get.ok && new TextDecoder().decode(get.value)).toBe("chunk");

    kv.values.set("bad-json", "not-json");
    const badJson = await store.get("bad-json");
    expect(badJson.ok).toBe(false);
    expect(!badJson.ok && "code" in badJson.error && badJson.error.code).toBe(
      "TC_STORE_BAD_ENCODING",
    );

    kv.values.set("bad-envelope", JSON.stringify({ encoding: "raw" }));
    const badEnvelope = await store.get("bad-envelope");
    expect(badEnvelope.ok).toBe(false);
    expect(
      !badEnvelope.ok && "code" in badEnvelope.error && badEnvelope.error.code,
    ).toBe("TC_STORE_BAD_ENCODING");
  });

  it("maps missing head to null", async () => {
    const head = await new TinyCloudStore(new FakeKv()).head("missing");
    expect(head.ok && head.value).toBeNull();
  });

  it("maps SDK errors to TinyAgent errors", async () => {
    const kv = new FakeKv();
    kv.fail = true;
    const result = await new TinyCloudStore(kv).get("tinyagent/ada/chunks/a");
    expect(result.ok).toBe(false);
    expect(!result.ok && "code" in result.error && result.error.code).toBe(
      "TC_NETWORK_ERROR",
    );
  });

  it.each([
    ["STORAGE_QUOTA_EXCEEDED", "TC_STORE_QUOTA_EXCEEDED"],
    ["STORAGE_LIMIT_REACHED", "TC_STORE_QUOTA_EXCEEDED"],
    ["PAYLOAD_TOO_LARGE", "TC_STORE_OBJECT_TOO_LARGE"],
    ["OBJECT_TOO_LARGE", "TC_STORE_OBJECT_TOO_LARGE"],
  ])("normalizes SDK %s errors", async (sdkCode, expectedCode) => {
    const kv = new FakeKv();
    kv.failCode = sdkCode;
    const result = await new TinyCloudStore(kv).put({
      key: "tinyagent/ada/chunks/a",
      bytes: new Uint8Array([1]),
    });
    expect(result.ok).toBe(false);
    expect(!result.ok && "code" in result.error && result.error.code).toBe(
      expectedCode,
    );
    expect(
      !result.ok &&
        "details" in result.error &&
        (result.error.details as { sdkCode?: string }).sdkCode,
    ).toBe(sdkCode);
  });
});

describe("TinyCloudVaultSecretStore", () => {
  it("maps SecretStore operations to Data Vault keys", async () => {
    const vault = new FakeVault();
    const secrets = new TinyCloudVaultSecretStore(vault);
    const value = new TextEncoder().encode("sk-test");

    const set = await secrets.set("OPENAI_API_KEY", value);
    expect(set.ok).toBe(true);
    expect(vault.values.has("tinyagent/secrets/OPENAI_API_KEY")).toBe(true);

    const list = await secrets.list();
    expect(list.ok && list.value).toEqual(["OPENAI_API_KEY"]);

    const get = await secrets.get("OPENAI_API_KEY");
    expect(get.ok && new TextDecoder().decode(get.value)).toBe("sk-test");

    const deleted = await secrets.delete("OPENAI_API_KEY");
    expect(deleted.ok).toBe(true);
    expect(await secrets.list()).toEqual({ ok: true, value: [] });
  });

  it("rejects unsafe vault secret names before calling the SDK", async () => {
    const vault = new FakeVault();
    const secrets = new TinyCloudVaultSecretStore(vault);
    const set = await secrets.set("../TOKEN", new Uint8Array([1]));
    expect(set.ok).toBe(false);
    expect(vault.values.size).toBe(0);
  });

  it("maps locked vault errors to TinyAgent errors", async () => {
    const vault = new FakeVault();
    vault.locked = true;
    const result = await new TinyCloudVaultSecretStore(vault).set(
      "TOKEN",
      new Uint8Array([1]),
    );
    expect(result.ok).toBe(false);
    expect(!result.ok && "code" in result.error && result.error.code).toBe(
      "TC_VAULT_VAULT_LOCKED",
    );
  });
});

class FakeKv {
  fail = false;
  failCode: string | undefined;
  readonly values = new Map<string, unknown>();

  constructor(private readonly options: { stringifyValues?: boolean } = {}) {}

  async put(key: string, value: unknown) {
    if (this.failCode !== undefined) return sdkErr(this.failCode);
    if (this.fail) return sdkErr("NETWORK_ERROR");
    this.values.set(
      key,
      this.options.stringifyValues ? JSON.stringify(value) : value,
    );
    return sdkOk({
      data: undefined,
      headers: headersFor(JSON.stringify(value).length),
    });
  }

  async get<T>(key: string) {
    if (this.failCode !== undefined) return sdkErr(this.failCode);
    if (this.fail) return sdkErr("NETWORK_ERROR");
    const value = this.values.get(key);
    if (!value) return sdkErr("KV_NOT_FOUND");
    return sdkOk({
      data: value as T,
      headers: headersFor(JSON.stringify(value).length),
    });
  }

  async head(key: string) {
    if (this.failCode !== undefined) return sdkErr(this.failCode);
    if (this.fail) return sdkErr("NETWORK_ERROR");
    const value = this.values.get(key);
    if (!value) return sdkErr("KV_NOT_FOUND");
    return sdkOk({
      data: undefined,
      headers: headersFor(JSON.stringify(value).length),
    });
  }

  async list({ prefix }: { prefix?: string } = {}) {
    if (this.failCode !== undefined) return sdkErr(this.failCode);
    if (this.fail) return sdkErr("NETWORK_ERROR");
    return sdkOk({
      keys: [...this.values.keys()].filter((key) =>
        key.startsWith(prefix ?? ""),
      ),
    });
  }

  async delete(key: string) {
    if (this.failCode !== undefined) return sdkErr(this.failCode);
    if (this.fail) return sdkErr("NETWORK_ERROR");
    this.values.delete(key);
    return sdkOk(undefined);
  }
}

class FakeVault {
  locked = false;
  readonly values = new Map<string, Uint8Array>();

  async put(
    key: string,
    value: unknown,
    options: { serialize?: (value: unknown) => Uint8Array } = {},
  ) {
    if (this.locked) return vaultErr("VAULT_LOCKED");
    this.values.set(key, options.serialize?.(value) ?? (value as Uint8Array));
    return sdkOk(undefined);
  }

  async get<T>(
    key: string,
    options: { deserialize?: (bytes: Uint8Array) => T } = {},
  ) {
    if (this.locked) return vaultErr("VAULT_LOCKED");
    const value = this.values.get(key);
    if (!value) return vaultErr("KEY_NOT_FOUND");
    return sdkOk({
      value: options.deserialize?.(value) ?? (value as T),
      metadata: {},
      keyId: "fake-key",
    });
  }

  async list({
    prefix = "",
    removePrefix = false,
  }: { prefix?: string; removePrefix?: boolean } = {}) {
    if (this.locked) return vaultErr("VAULT_LOCKED");
    const keys = [...this.values.keys()]
      .filter((key) => key.startsWith(prefix))
      .map((key) => (removePrefix ? key.slice(prefix.length) : key));
    return sdkOk(keys);
  }

  async delete(key: string) {
    if (this.locked) return vaultErr("VAULT_LOCKED");
    this.values.delete(key);
    return sdkOk(undefined);
  }
}

function sdkOk<T>(data: T) {
  return { ok: true, data } as const;
}

function sdkErr(code: string) {
  return {
    ok: false,
    error: { code, message: code.toLowerCase(), service: "kv" },
  } as const;
}

function vaultErr(code: string) {
  return {
    ok: false,
    error: { code, message: code.toLowerCase(), service: "vault" },
  } as const;
}

function headersFor(contentLength: number) {
  return {
    contentLength,
    etag: "etag",
    get(name: string) {
      if (name === "content-length") return String(contentLength);
      if (name === "etag") return "etag";
      return null;
    },
  };
}
