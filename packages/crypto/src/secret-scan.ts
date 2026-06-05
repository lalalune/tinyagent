import { b64u, hex } from "./encoding.js";

function encodingsOf(secret: Uint8Array): string[] {
  const forms = new Set<string>();
  const hexLower = hex(secret);
  forms.add(hexLower);
  forms.add(hexLower.toUpperCase());

  const std = Buffer.from(secret).toString("base64");
  forms.add(std);
  forms.add(std.replace(/=+$/g, ""));
  forms.add(b64u(secret));

  const utf8 = Buffer.from(secret).toString("utf8");
  if (
    utf8.length > 0 &&
    Buffer.from(utf8, "utf8").equals(Buffer.from(secret))
  ) {
    forms.add(utf8);
  }

  return [...forms].filter((f) => f.length >= 8);
}

export interface SecretLeak {
  /** Index of the secret in the provided `secrets` array. */
  secretIndex: number;
  /** Which encoding form was found (hex, base64, base64url, utf8). */
  encoding: "hex" | "base64" | "base64url" | "utf8";
  /** The exact substring that matched. */
  match: string;
}

function classify(form: string, secret: Uint8Array): SecretLeak["encoding"] {
  if (form === hex(secret) || form === hex(secret).toUpperCase()) return "hex";
  if (form === b64u(secret)) return "base64url";
  const std = Buffer.from(secret).toString("base64");
  if (form === std || form === std.replace(/=+$/g, "")) return "base64";
  return "utf8";
}

export function scanForSecretMaterial(
  input: string | Uint8Array,
  secrets: Uint8Array[],
): SecretLeak[] {
  const text =
    typeof input === "string" ? input : Buffer.from(input).toString("utf8");
  const leaks: SecretLeak[] = [];

  for (let i = 0; i < secrets.length; i++) {
    const secret = secrets[i];
    if (!secret || secret.length === 0) continue;
    for (const form of encodingsOf(secret)) {
      if (text.includes(form)) {
        leaks.push({
          secretIndex: i,
          encoding: classify(form, secret),
          match: form,
        });
      }
    }
  }

  return leaks;
}
