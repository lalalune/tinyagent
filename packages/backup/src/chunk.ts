export interface PlainChunk {
  offset: number;
  bytes: Uint8Array;
}

export function fixedSizeChunks(
  bytes: Uint8Array,
  chunkSize = 1024 * 1024,
): PlainChunk[] {
  if (chunkSize <= 0) throw new Error("chunkSize must be positive");
  const chunks: PlainChunk[] = [];
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    chunks.push({
      offset,
      bytes: bytes.slice(offset, Math.min(offset + chunkSize, bytes.length)),
    });
  }
  if (bytes.length === 0) chunks.push({ offset: 0, bytes: new Uint8Array() });
  return chunks;
}

export interface FastCdcOptions {
  min?: number;
  avg?: number;
  max?: number;
}

const DEFAULT_FASTCDC: Required<FastCdcOptions> = {
  min: 256 * 1024,
  avg: 1024 * 1024,
  max: 4 * 1024 * 1024,
};

const GEAR = buildGearTable(0x1bf52);

function buildGearTable(seed: number): Uint32Array {
  const table = new Uint32Array(256);
  let state = seed >>> 0;
  for (let i = 0; i < 256; i++) {
    state = (state + 0x9e3779b9) >>> 0;
    let z = state;
    z = (Math.imul(z ^ (z >>> 16), 0x21f0aaad) >>> 0) >>> 0;
    z = (Math.imul(z ^ (z >>> 15), 0x735a2d97) >>> 0) >>> 0;
    z = (z ^ (z >>> 15)) >>> 0;
    table[i] = z >>> 0;
  }
  return table;
}

function maskBits(avg: number): number {
  return Math.max(1, Math.round(Math.log2(avg)));
}

export function fastCdcChunks(
  bytes: Uint8Array,
  options: FastCdcOptions = {},
): PlainChunk[] {
  const min = options.min ?? DEFAULT_FASTCDC.min;
  const avg = options.avg ?? DEFAULT_FASTCDC.avg;
  const max = options.max ?? DEFAULT_FASTCDC.max;
  if (min <= 0 || avg <= 0 || max <= 0) {
    throw new Error("fastCdcChunks sizes must be positive");
  }
  if (!(min <= avg && avg <= max)) {
    throw new Error("fastCdcChunks requires min <= avg <= max");
  }

  if (bytes.length === 0) return [{ offset: 0, bytes: new Uint8Array() }];

  const bits = maskBits(avg);
  const maskS = makeMask(bits + 1);
  const maskL = makeMask(bits - 1);

  const chunks: PlainChunk[] = [];
  let start = 0;
  const len = bytes.length;

  while (start < len) {
    const cut = nextCut(bytes, start, min, avg, max, maskS, maskL);
    chunks.push({ offset: start, bytes: bytes.slice(start, cut) });
    start = cut;
  }
  return chunks;
}

function makeMask(bits: number): number {
  const b = Math.max(1, Math.min(31, bits));
  return ((1 << b) - 1) >>> 0;
}

function nextCut(
  bytes: Uint8Array,
  start: number,
  min: number,
  avg: number,
  max: number,
  maskS: number,
  maskL: number,
): number {
  const len = bytes.length;
  let end = start + max;
  if (end > len) end = len;

  let avgEnd = start + avg;
  if (avgEnd > end) avgEnd = end;

  let hash = 0;
  let i = start + min;
  if (i >= len) return len;

  for (; i < avgEnd; i++) {
    hash = ((hash << 1) + GEAR[bytes[i]!]!) >>> 0;
    if ((hash & maskS) === 0) return i + 1;
  }
  for (; i < end; i++) {
    hash = ((hash << 1) + GEAR[bytes[i]!]!) >>> 0;
    if ((hash & maskL) === 0) return i + 1;
  }
  return end;
}
