import { describe, expect, it } from "vitest";
import { hkdf } from "@noble/hashes/hkdf";
import { sha256 } from "@noble/hashes/sha2";
import sodium from "libsodium-wrappers-sumo";

/**
 * Known-Answer Tests (KATs) against INDEPENDENT, published test vectors.
 *
 * These do not assert against our own generated output. Each vector is taken
 * verbatim from a public standard / reference implementation and the source is
 * cited inline. The goal is an external source of truth for every primitive the
 * backup crypto stack relies on:
 *   - HKDF-SHA256              (deriveBackupKeypair seed)
 *   - X25519 scalarmult        (crypto_box_seed_keypair / sealed box keys)
 *   - crypto_box xsalsa20-poly1305 (the AEAD inside crypto_box_seal)
 *   - XChaCha20-Poly1305 IETF  (encryptChunk / decryptChunk)
 */

const h = (s: string): Uint8Array =>
  Uint8Array.from((s.match(/../g) ?? []).map((b) => parseInt(b, 16)));
const hexOf = (b: Uint8Array): string => Buffer.from(b).toString("hex");

describe("KAT: HKDF-SHA256 (RFC 5869)", () => {
  // RFC 5869, Appendix A, Test Case 1 (Basic test case with SHA-256).
  // https://www.rfc-editor.org/rfc/rfc5869#appendix-A.1
  it("reproduces RFC 5869 Test Case 1 OKM", () => {
    const ikm = new Uint8Array(22).fill(0x0b);
    const salt = h("000102030405060708090a0b0c");
    const info = h("f0f1f2f3f4f5f6f7f8f9");
    const okm = hkdf(sha256, ikm, salt, info, 42);
    expect(hexOf(okm)).toBe(
      "3cb25f25faacd57a90434f64d0362f2a" +
        "2d2d0a90cf1a5a4c5db02d56ecc4c5bf" +
        "34007208d5b887185865",
    );
  });

  // RFC 5869, Appendix A, Test Case 3 (zero-length salt and info, SHA-256).
  // https://www.rfc-editor.org/rfc/rfc5869#appendix-A.3
  it("reproduces RFC 5869 Test Case 3 OKM", () => {
    const ikm = new Uint8Array(22).fill(0x0b);
    const okm = hkdf(sha256, ikm, new Uint8Array(0), new Uint8Array(0), 42);
    expect(hexOf(okm)).toBe(
      "8da4e775a563c18f715f802a063c5a31" +
        "b8a11f5c5ee1879ec3454e5f3c738d2d" +
        "9d201395faa4b61a96c8",
    );
  });
});

describe("KAT: X25519 (RFC 7748)", () => {
  // RFC 7748, Section 6.1: Curve25519 Diffie-Hellman test vectors.
  // https://www.rfc-editor.org/rfc/rfc7748#section-6.1
  it("derives Alice's public key from her private key (scalarmult_base)", async () => {
    await sodium.ready;
    const alicePriv = h(
      "77076d0a7318a57d3c16c17251b26645df4c2f87ebc0992ab177fba51db92c2a",
    );
    const alicePub = sodium.crypto_scalarmult_base(alicePriv);
    expect(hexOf(alicePub)).toBe(
      "8520f0098930a754748b7ddcb43ef75a0dbf3a0d26381af4eba4a98eaa9b4e6a",
    );
  });

  it("computes the shared secret K (scalarmult)", async () => {
    await sodium.ready;
    const alicePriv = h(
      "77076d0a7318a57d3c16c17251b26645df4c2f87ebc0992ab177fba51db92c2a",
    );
    const bobPub = h(
      "de9edb7d7b7dc1b4d35b61c2ece435373f8343c85b78674dadfc7e146f882b4f",
    );
    const shared = sodium.crypto_scalarmult(alicePriv, bobPub);
    expect(hexOf(shared)).toBe(
      "4a5d9d5ba4ce2de1728e3bf480350f25e07e21c947d19e3376f09b3c1e161742",
    );
  });
});

describe("KAT: crypto_box xsalsa20-poly1305 (NaCl reference)", () => {
  // Classic NaCl crypto_box test vector (DJB's nacl tests/box.c / box2.c).
  // Alice secret + Bob public + nonce + 163-byte message -> ciphertext.
  // The first 16 bytes are the Poly1305 tag, matching the well-known
  // "f3ffc770..." reference output.
  it("reproduces the NaCl crypto_box ciphertext", async () => {
    await sodium.ready;
    const aliceSecret = h(
      "77076d0a7318a57d3c16c17251b26645df4c2f87ebc0992ab177fba51db92c2a",
    );
    const bobPublic = h(
      "de9edb7d7b7dc1b4d35b61c2ece435373f8343c85b78674dadfc7e146f882b4f",
    );
    const nonce = h("69696ee955b62b73cd62bda875fc73d68219e0036b7a0b37");
    const message = h(
      "be075fc53c81f2d5cf141316ebeb0c7b5228c52a4c62cbd44b66849b64244ffc" +
        "e5ecbaaf33bd751a1ac728d45e6c61296cdc3c01233561f41db66cce314adb31" +
        "0e3be8250c46f06dceea3a7fa1348057e2f6556ad6b1318a024a838f21af1fde" +
        "048977eb48f59ffd4924ca1c60902e52f0a089bc76897040e082f9377638486" +
        "45e0705",
    );
    const ct = sodium.crypto_box_easy(message, nonce, bobPublic, aliceSecret);
    expect(hexOf(ct)).toBe(
      "f3ffc7703f9400e52a7dfb4b3d3305d98e993b9f48681273c29650ba32fc76ce" +
        "48332ea7164d96a4476fb8c531a1186ac0dfc17c98dce87b4da7f011ec48c972" +
        "71d2c20f9b928fe2270d6fb863d51738b48eeee314a7cc8ab932164548e526ae" +
        "90224368517acfeabd6bb3732bc0e9da99832b61ca01b6de56244a9e88d5f9b3" +
        "7973f622a43d14a6599b1f654cb45a74e355a5",
    );
    // Round-trips back to plaintext (sanity on decrypt direction).
    const back = sodium.crypto_box_open_easy(ct, nonce, bobPublic, aliceSecret);
    expect(hexOf(back)).toBe(hexOf(message));
  });
});

describe("KAT: XChaCha20-Poly1305 IETF (libsodium reference)", () => {
  // libsodium test/default/aead_xchacha20poly1305.c reference vector.
  // Adapted from the ChaCha20-Poly1305 RFC 8439 "Ladies and Gentlemen"
  // plaintext, run through the XChaCha20 24-byte-nonce construction.
  const message = h(
    "4c616469657320616e642047656e746c656d656e206f662074686520636c6173" +
      "73206f66202739393a204966204920636f756c64206f6666657220796f75206f" +
      "6e6c79206f6e652074697020666f7220746865206675747572652c2073756e73" +
      "637265656e20776f756c642062652069742e",
  );
  const ad = h("50515253c0c1c2c3c4c5c6c7");
  const nonce = h("404142434445464748494a4b4c4d4e4f5051525354555657");
  const key = h(
    "808182838485868788898a8b8c8d8e8f909192939495969798999a9b9c9d9e9f",
  );
  const expectedCt =
    "bd6d179d3e83d43b9576579493c0e939572a1700252bfaccbed2902c21396cbb" +
    "731c7f1b0b4aa6440bf3a82f4eda7e39ae64c6708c54c216cb96b72e1213b452" +
    "2f8c9ba40db5d945b11b69b982c1bb9e3f3fac2bc369488f76b2383565d3fff9" +
    "21f9664c97637da9768812f615c68b13b52ec0875924c1c7987947deafd8780a" +
    "cf49";

  it("encrypts to the published ciphertext+tag", async () => {
    await sodium.ready;
    const ct = sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(
      message,
      ad,
      null,
      nonce,
      key,
    );
    expect(hexOf(ct)).toBe(expectedCt);
  });

  it("decrypts the published ciphertext back to plaintext", async () => {
    await sodium.ready;
    const back = sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(
      null,
      h(expectedCt),
      ad,
      nonce,
      key,
    );
    expect(hexOf(back)).toBe(hexOf(message));
  });
});
