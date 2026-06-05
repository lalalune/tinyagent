import { describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { deriveBackupKeypair } from "./backup-key.js";
import { b64u, fromB64u } from "./encoding.js";
import {
  decryptChunk,
  encryptChunk,
  openContentKey,
  sealContentKey,
  randomBytes,
} from "./sealed-box.js";

const execFileAsync = promisify(execFile);

describe("wallet-derived backup key", () => {
  it("is deterministic for the same signature and space", async () => {
    const signature = new Uint8Array(65).fill(7);
    const a = await deriveBackupKeypair(
      "tinycloud:pkh:eip155:1:0xabc:tinyagent",
      signature,
    );
    const b = await deriveBackupKeypair(
      "tinycloud:pkh:eip155:1:0xabc:tinyagent",
      signature,
    );

    expect(Buffer.from(a.publicKey).toString("hex")).toEqual(
      Buffer.from(b.publicKey).toString("hex"),
    );
    expect(Buffer.from(a.privateKey).toString("hex")).toEqual(
      Buffer.from(b.privateKey).toString("hex"),
    );
    expect(a.publicKeyId).toEqual(b.publicKeyId);
    expect(Buffer.from(a.publicKey).toString("hex")).toBe(
      "61d83ccd109773e3cf3b76b1a4db1ebc2f6b76892011c19cb84afb2ad3c84a79",
    );
    expect(Buffer.from(a.privateKey).toString("hex")).toBe(
      "5b4ed1a6fce903fed13d0fc183e7c08640fd36489cc043c67f7f119aa04bc039",
    );
    expect(a.publicKeyId).toBe("bpk_cdac7c32bd3d41bf6c9b9fa1");
  });

  it("is deterministic across processes", async () => {
    const moduleUrl = new URL("./backup-key.ts", import.meta.url).href;
    const script = `
      const { deriveBackupKeypair } = await import(${JSON.stringify(moduleUrl)});
      const keypair = await deriveBackupKeypair("space", new Uint8Array(65).fill(7));
      console.log(Buffer.from(keypair.publicKey).toString("hex") + ":" + keypair.publicKeyId);
    `;

    const [a, b] = await Promise.all([
      execFileAsync("bun", ["--eval", script]),
      execFileAsync("bun", ["--eval", script]),
    ]);

    expect(a.stdout.trim()).toBe(b.stdout.trim());
  });

  it("opens sealed keys only with the matching wallet-derived key", async () => {
    const signature = new Uint8Array(65).fill(9);
    const wrongSignature = new Uint8Array(65).fill(10);
    const keypair = await deriveBackupKeypair("space", signature);
    const wrong = await deriveBackupKeypair("space", wrongSignature);
    const contentKey = await randomBytes(32);

    const sealed = await sealContentKey(
      contentKey,
      keypair.publicKey,
      keypair.publicKeyId,
    );
    const opened = await openContentKey(
      sealed,
      keypair.publicKey,
      keypair.privateKey,
    );
    expect(Buffer.from(opened).toString("hex")).toEqual(
      Buffer.from(contentKey).toString("hex"),
    );

    await expect(
      openContentKey(sealed, wrong.publicKey, wrong.privateKey),
    ).rejects.toThrow();
  });

  it("rejects tampered sealed content keys and encrypted chunks", async () => {
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

    const tamperedSealedBytes = fromB64u(sealed.ciphertext);
    tamperedSealedBytes[0] = tamperedSealedBytes[0]! ^ 1;
    const tamperedSealed = {
      ...sealed,
      ciphertext: b64u(tamperedSealedBytes),
    };
    await expect(
      openContentKey(tamperedSealed, keypair.publicKey, keypair.privateKey),
    ).rejects.toThrow();

    const chunk = await encryptChunk(
      new TextEncoder().encode("state"),
      contentKey,
    );
    const tamperedCiphertext = new Uint8Array(chunk.ciphertext);
    tamperedCiphertext[0] = tamperedCiphertext[0]! ^ 1;
    await expect(
      decryptChunk({ ...chunk, ciphertext: tamperedCiphertext }, contentKey),
    ).rejects.toThrow();
  });
});
