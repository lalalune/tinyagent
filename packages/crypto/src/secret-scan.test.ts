import { describe, expect, it } from "vitest";
import { deriveBackupKeypair } from "./backup-key.js";
import { randomBytes, sealContentKey } from "./sealed-box.js";
import { scanForSecretMaterial } from "./secret-scan.js";
import { b64u, hex } from "./encoding.js";

describe("scanForSecretMaterial", () => {
  it("catches a planted private-key leak (hex form) and reports clean logs", async () => {
    const keypair = await deriveBackupKeypair(
      "tinycloud:pkh:eip155:1:0xabc:tinyagent",
      new Uint8Array(65).fill(7),
    );
    const secrets = [keypair.privateKey];

    const cleanLog = JSON.stringify({
      msg: "derived backup keypair",
      publicKeyId: keypair.publicKeyId,
      publicKey: b64u(keypair.publicKey),
    });
    expect(scanForSecretMaterial(cleanLog, secrets)).toEqual([]);

    const leakyLog = JSON.stringify({
      msg: "derived backup keypair",
      publicKeyId: keypair.publicKeyId,
      privateKey: hex(keypair.privateKey),
    });
    const leaks = scanForSecretMaterial(leakyLog, secrets);
    expect(leaks.length).toBeGreaterThan(0);
    expect(leaks[0]).toMatchObject({ secretIndex: 0, encoding: "hex" });
  });

  it("detects leaks across base64, base64url, and utf8 encodings", async () => {
    const secret = await randomBytes(32);
    const utf8Secret = new TextEncoder().encode(
      "super-secret-passphrase-value",
    );
    const secrets = [secret, utf8Secret];

    const b64Leak = Buffer.from(secret).toString("base64");
    expect(scanForSecretMaterial(`token=${b64Leak}`, secrets)[0]).toMatchObject(
      { secretIndex: 0, encoding: "base64" },
    );

    const b64uLeak = b64u(secret);
    expect(
      scanForSecretMaterial(`token=${b64uLeak}`, secrets)[0],
    ).toMatchObject({ secretIndex: 0, encoding: "base64url" });

    const utf8Leak = "config: super-secret-passphrase-value loaded";
    expect(scanForSecretMaterial(utf8Leak, secrets)[0]).toMatchObject({
      secretIndex: 1,
      encoding: "utf8",
    });
  });

  it("does not flag the public sealed-key envelope", async () => {
    const keypair = await deriveBackupKeypair(
      "space",
      new Uint8Array(65).fill(9),
    );
    const contentKey = await randomBytes(32);
    const sealed = await sealContentKey(
      contentKey,
      keypair.publicKey,
      keypair.publicKeyId,
    );

    const snapshot = JSON.stringify(sealed);
    expect(
      scanForSecretMaterial(snapshot, [keypair.privateKey, contentKey]),
    ).toEqual([]);
  });

  it("accepts Uint8Array input (e.g. raw buffered log bytes)", async () => {
    const secret = await randomBytes(32);
    const buf = new TextEncoder().encode(`leaked: ${hex(secret)}`);
    expect(scanForSecretMaterial(buf, [secret])[0]).toMatchObject({
      secretIndex: 0,
      encoding: "hex",
    });
  });

  it("ignores empty/short secrets to avoid false positives", () => {
    expect(
      scanForSecretMaterial("anything at all", [new Uint8Array(0)]),
    ).toEqual([]);
  });
});
