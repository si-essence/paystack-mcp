import { redactUnknown, type SecretScope } from "./redact.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function sanitizePayload(
  value: unknown,
  secrets: SecretScope | readonly string[],
  extraWarnings: readonly string[] = [],
): Record<string, unknown> {
  const redacted = redactUnknown(value, secrets);
  if (Array.isArray(redacted)) {
    return extraWarnings.length === 0
      ? { items: redacted }
      : { items: redacted, warnings: [...extraWarnings] };
  }
  if (isRecord(redacted)) {
    const out: Record<string, unknown> = { ...redacted };
    if (extraWarnings.length > 0) out["warnings"] = [...extraWarnings];
    return out;
  }
  if (typeof redacted === "string") return { text: redacted };
  if (typeof redacted === "number" || typeof redacted === "boolean" || redacted === null) {
    return { value: redacted };
  }
  return { value: null };
}
