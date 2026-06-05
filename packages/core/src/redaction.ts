const SECRET_TEXT_PATTERN =
  /\b((?:[A-Z0-9_]*API[_-]?KEY|[A-Z0-9_]*TOKEN|[A-Z0-9_]*PASSWORD|PRIVATE[_-]?KEY|AUTHORIZATION)\s*[:=]\s*)(?:"[^"]+"|'[^']+'|Bearer\s+[^\s,;]+|[^\s,;]+)/gi;
const BEARER_TEXT_PATTERN = /\b(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi;
const OPENAI_KEY_PATTERN = /\bsk-[A-Za-z0-9_-]{6,}\b/g;

export function redactValue(value: unknown): unknown {
  return redactAny(value, true);
}

export function redactObject(
  input: Record<string, unknown>,
): Record<string, unknown> {
  return redactAny(input, false) as Record<string, unknown>;
}

export function redactText(input: string): string {
  return input
    .replace(SECRET_TEXT_PATTERN, "$1[REDACTED]")
    .replace(BEARER_TEXT_PATTERN, "$1[REDACTED]")
    .replace(OPENAI_KEY_PATTERN, "[REDACTED]");
}

function redactAny(value: unknown, redactStrings: boolean): unknown {
  if (typeof value === "string") {
    if (redactStrings && value.length > 0) return "[REDACTED]";
    return redactText(value);
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactAny(item, redactStrings));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, nested]) => [
        key,
        redactAny(nested, redactStrings || shouldRedactKey(key)),
      ]),
    );
  }
  return value;
}

function shouldRedactKey(key: string): boolean {
  const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, "");
  return (
    normalized === "authorization" ||
    normalized === "authheader" ||
    normalized === "secret" ||
    normalized === "password" ||
    normalized === "apikey" ||
    normalized === "privatekey" ||
    normalized === "bearertoken" ||
    normalized === "gatewaytoken" ||
    normalized.endsWith("token") ||
    normalized.endsWith("password") ||
    normalized.endsWith("apikey") ||
    normalized.endsWith("privatekey")
  );
}
