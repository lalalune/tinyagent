import sodium from "libsodium-wrappers-sumo";
import type { SealedContentKey } from "@tinyagent/core";
import { fromB64u, b64u } from "./encoding.js";

export async function randomBytes(length: number): Promise<Uint8Array> {
  await sodium.ready;
  return sodium.randombytes_buf(length);
}

export async function sealContentKey(
  contentKey: Uint8Array,
  publicKey: Uint8Array,
  bpkId: string,
): Promise<SealedContentKey> {
  await sodium.ready;
  return {
    version: 1,
    algorithm: "x25519-xsalsa20-poly1305-sealedbox",
    ciphertext: b64u(sodium.crypto_box_seal(contentKey, publicKey)),
    backupPublicKeyId: bpkId,
  };
}

export async function openContentKey(
  sealed: SealedContentKey,
  publicKey: Uint8Array,
  privateKey: Uint8Array,
): Promise<Uint8Array> {
  await sodium.ready;
  return sodium.crypto_box_seal_open(
    fromB64u(sealed.ciphertext),
    publicKey,
    privateKey,
  );
}

export interface EncryptedChunk {
  nonce: string;
  ciphertext: Uint8Array;
}

export async function encryptChunk(
  plaintext: Uint8Array,
  contentKey: Uint8Array,
): Promise<EncryptedChunk> {
  await sodium.ready;
  const nonce = sodium.randombytes_buf(
    sodium.crypto_aead_xchacha20poly1305_ietf_NPUBBYTES,
  );
  const ciphertext = sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(
    plaintext,
    null,
    null,
    nonce,
    contentKey,
  );
  return { nonce: b64u(nonce), ciphertext };
}

export async function decryptChunk(
  chunk: EncryptedChunk,
  contentKey: Uint8Array,
): Promise<Uint8Array> {
  await sodium.ready;
  return sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(
    null,
    chunk.ciphertext,
    null,
    fromB64u(chunk.nonce),
    contentKey,
  );
}
