export function b64u(bytes: Uint8Array): string {
  return Buffer.from(bytes)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

export function fromB64u(input: string): Uint8Array {
  const padded = input
    .replace(/-/g, "+")
    .replace(/_/g, "/")
    .padEnd(Math.ceil(input.length / 4) * 4, "=");
  return new Uint8Array(Buffer.from(padded, "base64"));
}

export function hex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("hex");
}
