import { describe, expect, it } from "vitest";
import { fastCdcChunks, fixedSizeChunks } from "./chunk.js";

/**
 * Build a deterministic pseudo-random buffer (no external deps). Uses a
 * SplitMix32 PRNG so the data is reproducible across runs.
 */
function pseudoRandomBytes(length: number, seed: number): Uint8Array {
  const out = new Uint8Array(length);
  let state = seed >>> 0;
  for (let i = 0; i < length; i++) {
    state = (state + 0x9e3779b9) >>> 0;
    let z = state;
    z = (Math.imul(z ^ (z >>> 16), 0x21f0aaad) >>> 0) >>> 0;
    z = (Math.imul(z ^ (z >>> 15), 0x735a2d97) >>> 0) >>> 0;
    z = (z ^ (z >>> 15)) >>> 0;
    out[i] = z & 0xff;
  }
  return out;
}

function boundaries(chunks: { offset: number }[]): number[] {
  return chunks.map((c) => c.offset);
}

describe("fastCdcChunks", () => {
  const opts = { min: 2 * 1024, avg: 8 * 1024, max: 32 * 1024 };

  it("produces chunks within [min, max] for a multi-MiB buffer", () => {
    const data = pseudoRandomBytes(4 * 1024 * 1024, 12345);
    const chunks = fastCdcChunks(data, opts);
    expect(chunks.length).toBeGreaterThan(1);

    const reassembled = new Uint8Array(data.length);
    let offset = 0;
    for (const chunk of chunks) {
      reassembled.set(chunk.bytes, offset);
      offset += chunk.bytes.length;
    }
    expect(Buffer.compare(Buffer.from(reassembled), Buffer.from(data))).toBe(0);

    for (let i = 0; i < chunks.length; i++) {
      const len = chunks[i]!.bytes.length;
      expect(len).toBeLessThanOrEqual(opts.max);
      if (i < chunks.length - 1) {
        expect(len).toBeGreaterThanOrEqual(opts.min);
      }
    }
  });

  it("is deterministic: re-chunking identical bytes yields identical boundaries", () => {
    const data = pseudoRandomBytes(3 * 1024 * 1024, 777);
    const a = fastCdcChunks(data, opts);
    const b = fastCdcChunks(data.slice(), opts);
    expect(boundaries(a)).toEqual(boundaries(b));
    expect(a.map((c) => c.bytes.length)).toEqual(b.map((c) => c.bytes.length));
  });

  it("resyncs after an early insertion (CDC property): only a bounded number of boundaries shift", () => {
    const data = pseudoRandomBytes(4 * 1024 * 1024, 2024);
    const original = fastCdcChunks(data, opts);

    const insertAt = 100;
    const inserted = new Uint8Array(data.length + 17);
    inserted.set(data.subarray(0, insertAt), 0);
    inserted.set(pseudoRandomBytes(17, 99), insertAt);
    inserted.set(data.subarray(insertAt), insertAt + 17);
    const edited = fastCdcChunks(inserted, opts);

    // Compare boundaries in the "tail" coordinate space. After resync, edited
    // boundaries should equal original boundaries shifted by +17. Count how
    // many original boundaries (past the edit) have a matching shifted
    // boundary in the edited set.
    const editedSet = new Set(boundaries(edited));
    const originalTail = boundaries(original).filter(
      (b) => b > insertAt + 1024,
    );
    let matched = 0;
    for (const b of originalTail) {
      if (editedSet.has(b + 17)) matched += 1;
    }
    expect(matched).toBeGreaterThan(originalTail.length * 0.8);

    const fixedA = fixedSizeChunks(data, 8 * 1024);
    const fixedB = fixedSizeChunks(inserted, 8 * 1024);
    const fixedBSet = new Set(boundaries(fixedB));
    const fixedMatched = boundaries(fixedA)
      .filter((b) => b > insertAt + 1024)
      .filter((b) => fixedBSet.has(b + 17)).length;
    expect(fixedMatched).toBe(0);
  });

  it("handles empty input", () => {
    const chunks = fastCdcChunks(new Uint8Array(), opts);
    expect(chunks).toEqual([{ offset: 0, bytes: new Uint8Array() }]);
  });
});
