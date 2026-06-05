import { hkdf } from "@noble/hashes/hkdf";
import { sha256 } from "@noble/hashes/sha2";
import sodium from "libsodium-wrappers-sumo";
import { b64u, hex } from "./encoding.js";

export const BACKUP_MESSAGE_PREFIX = "tinyagent-backup-v1:";

export interface BackupKeypair {
  version: 1;
  spaceId: string;
  publicKey: Uint8Array;
  privateKey: Uint8Array;
  publicKeyId: string;
}

export async function deriveBackupKeypair(
  spaceId: string,
  walletSignature: Uint8Array,
): Promise<BackupKeypair> {
  await sodium.ready;
  const message = new TextEncoder().encode(
    `${BACKUP_MESSAGE_PREFIX}${spaceId}`,
  );
  const seed = hkdf(
    sha256,
    walletSignature,
    message,
    "tinyagent-x25519-backup-key",
    32,
  );
  const keypair = sodium.crypto_box_seed_keypair(seed);
  const idBytes = sha256(keypair.publicKey);
  return {
    version: 1,
    spaceId,
    publicKey: keypair.publicKey,
    privateKey: keypair.privateKey,
    publicKeyId: `bpk_${hex(idBytes).slice(0, 24)}`,
  };
}

export function encodeBackupPublicKey(
  keypair: Pick<
    BackupKeypair,
    "version" | "spaceId" | "publicKey" | "publicKeyId"
  >,
) {
  return {
    version: keypair.version,
    spaceId: keypair.spaceId,
    publicKey: b64u(keypair.publicKey),
    publicKeyId: keypair.publicKeyId,
  };
}
