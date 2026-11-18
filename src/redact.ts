import { AsyncLocalStorage } from "node:async_hooks";

export const REDACTED = "[redacted]";
/** Configured API key minimum. Substring masking uses the same floor. */
export const MIN_CONFIG_SECRET = 8;
/**
 * Secrets shorter than this are not substring-replaced. Replacing 1–7 character
 * fragments mangles unrelated text (including this connector's own words) and
 * still leaks. Upstream free-text is replaced with GENERIC_UPSTREAM instead.
 */
export const MIN_SUBSTRING_SECRET = 8;
export const GENERIC_UPSTREAM =
  "upstream detail omitted because this request carried a short credential";
const MAX_DEPTH = 32;

const SENSITIVE_PATTERN =
  /(secret|token|password|passwordhash|authorization[_-]?code|otp|bvn|document[_-]?number|jwt|api[_-]?key|apikey|credential|passphrase|private[_-]?key|webhook|signature)/i;
/** `risk_action` is allow or deny, not a credential. */
const NON_SECRET_FIELDS = new Set(["risk_action"]);
/** Bank and card numbers are shown as last4, and the full value is still a secret. */
const LAST4_FIELD = /^(account_number|accountnumber|card_number|cardnumber|nuban)$/i;
const SENSITIVE_FIELD = {
  test: (key: string): boolean =>
    SENSITIVE_PATTERN.test(key) && !NON_SECRET_FIELDS.has(key.toLowerCase()),
};
const URL_USERINFO = /([a-z][a-z0-9+.-]*:\/\/)[^\s/?#@]*@/gi;

const secretAls = new AsyncLocalStorage<SecretScope>();

export interface SecretScope {
  /** Process-lifetime secrets (configured API key). Never grows per request. */
  readonly baseline: readonly string[];
  /** Sensitive values collected from this request only. */
  readonly supplied: readonly string[];
  /** Unique baseline plus supplied values for this request. */
  readonly all: readonly string[];
  /** Secrets of length >= MIN_SUBSTRING_SECRET. Safe for substring replacement. */
  readonly maskable: readonly string[];
  /** True when any collected secret has length 1..7. */
  readonly hasShort: boolean;
}

export function isSecretScope(value: unknown): value is SecretScope {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Partial<SecretScope>;
  return (
    Array.isArray(record.baseline) &&
    Array.isArray(record.supplied) &&
    Array.isArray(record.all) &&
    Array.isArray(record.maskable) &&
    typeof record.hasShort === "boolean"
  );
}

export function asSecretScope(value: SecretScope | readonly string[]): SecretScope {
  return isSecretScope(value) ? value : createSecretScope(value);
}

export function createSecretScope(baseline: readonly string[], ...roots: unknown[]): SecretScope {
  const base = uniqueNonEmpty(baseline);
  const supplied = collectSecrets(roots);
  const all = uniqueNonEmpty([...base, ...supplied]);
  const maskable = all.filter((secret) => secret.length >= MIN_SUBSTRING_SECRET);
  return {
    baseline: base,
    supplied,
    all,
    maskable,
    hasShort: all.some((secret) => secret.length < MIN_SUBSTRING_SECRET),
  };
}

export function runWithSecretScope<T>(scope: SecretScope, fn: () => T): T {
  return secretAls.run(scope, fn);
}

export function currentSecretScope(fallback: SecretScope): SecretScope {
  return secretAls.getStore() ?? fallback;
}

/**
 * Remove maskable secrets from free text. Values shorter than
 * MIN_SUBSTRING_SECRET are ignored here; use redactUpstream for those.
 */
export function redact(text: string, secrets: readonly string[]): string {
  const forms: string[] = [];
  const seen = new Set<string>();
  for (const secret of secrets) {
    if (secret.length < MIN_SUBSTRING_SECRET) continue;
    pushForm(forms, seen, secret);
    const trimmed = secret.trim();
    if (trimmed !== secret) pushForm(forms, seen, trimmed);
  }
  forms.sort((left, right) => right.length - left.length);
  let sentinel = "\uE000";
  while (text.includes(sentinel) || forms.some((form) => form.includes(sentinel))) {
    sentinel += "\uE001";
  }
  let out = text;
  for (const value of forms) {
    out = out.split(value).join(sentinel);
    const encoded = encodeURIComponent(value);
    if (encoded !== value) {
      out = out.split(encoded).join(sentinel);
      out = out.replace(percentPattern(encoded), sentinel);
    }
    const escaped = JSON.stringify(value).slice(1, -1);
    if (escaped !== value && escaped !== encoded) out = out.split(escaped).join(sentinel);
  }
  out = out.replace(URL_USERINFO, `$1${REDACTED}@`);
  out = out.replace(
    /([?&#](?:api_key|apikey|api-key|access_token|token|key)=)[^&\s#]+/gi,
    `$1${REDACTED}`,
  );
  out = out.replace(/(authorization:\s*(?:bearer\s+|basic\s+)?)(\S+)/gi, `$1${REDACTED}`);
  out = out.replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, REDACTED);
  return out.split(sentinel).join(REDACTED);
}

export function redactText(text: string, scope: SecretScope | readonly string[]): string {
  return redact(text, asSecretScope(scope).maskable);
}

/**
 * Upstream free-text (HTTP bodies, network errors, log detail). Short credentials
 * force a fixed generic message so substring masking cannot leak or mangle them.
 */
export function redactUpstream(text: string, scope: SecretScope | readonly string[]): string {
  const resolved = asSecretScope(scope);
  if (resolved.hasShort) return GENERIC_UPSTREAM;
  let normalized = text;
  const trimmed = text.trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      normalized = JSON.stringify(redactUnknown(JSON.parse(trimmed) as unknown, resolved));
    } catch {
      normalized = text;
    }
  }
  return stripUrls(redact(normalized, resolved.maskable)).replace(/\s+/g, " ").trim().slice(0, 180);
}

export function redactLogLine(message: string, scope: SecretScope | readonly string[]): string {
  const resolved = asSecretScope(scope);
  if (resolved.hasShort && textContainsAnySecret(message, shortSecrets(resolved))) {
    return GENERIC_UPSTREAM;
  }
  return redact(message, resolved.maskable);
}

export function stripUrls(text: string): string {
  return text.replace(/https?:\/\/\S+/g, "[url]");
}

/**
 * Secrets carried on this request: every non-empty string under a sensitive key
 * at any depth, plus URL userinfo, with no length floor.
 */
export function suppliedSecrets(value: unknown): string[] {
  return collectSecrets([value]);
}

export function maskLast4(value: string): string {
  const compact = value.replace(/\s+/g, "");
  if (compact.length < 4) return REDACTED;
  return `******${compact.slice(-4)}`;
}

export function redactUnknown(
  value: unknown,
  secrets: SecretScope | readonly string[],
  depth = 0,
): unknown {
  const scope = asSecretScope(secrets);
  if (depth > MAX_DEPTH) return REDACTED;
  if (typeof value === "string") return redactStringValue(value, scope);
  if (typeof value === "number" || typeof value === "boolean" || value === null) return value;
  if (typeof value === "bigint") return redactStringValue(value.toString(), scope);
  if (Array.isArray(value)) {
    return value.map((item) => redactUnknown(item, scope, depth + 1));
  }
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      const safeKey = redact(key, scope.maskable);
      if (LAST4_FIELD.test(key) && typeof entry === "string") {
        out[safeKey] = maskLast4(entry);
        continue;
      }
      if (SENSITIVE_FIELD.test(key)) {
        out[safeKey] = REDACTED;
        continue;
      }
      out[safeKey] = redactUnknown(entry, scope, depth + 1);
    }
    return out;
  }
  return REDACTED;
}

export function redactRecord(
  value: Readonly<Record<string, unknown>>,
  secrets: SecretScope | readonly string[],
): Record<string, unknown> {
  const redacted = redactUnknown(value, secrets);
  if (redacted === null || typeof redacted !== "object" || Array.isArray(redacted)) {
    return { error: "Tool result could not be redacted." };
  }
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(redacted)) {
    out[key] = entry;
  }
  return out;
}

export function textContainsAnySecret(text: string, secrets: readonly string[]): boolean {
  for (const secret of secrets) {
    if (secret.length === 0) continue;
    for (const form of secretForms(secret)) {
      if (form.length > 0 && text.includes(form)) return true;
    }
  }
  return false;
}

function redactStringValue(value: string, scope: SecretScope): string {
  if (scope.hasShort && textContainsAnySecret(value, shortSecrets(scope))) {
    return REDACTED;
  }
  return redact(value, scope.maskable);
}

function shortSecrets(scope: SecretScope): string[] {
  return scope.all.filter((secret) => secret.length < MIN_SUBSTRING_SECRET);
}

function percentPattern(encoded: string): RegExp {
  const literal = encoded.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const caseless = literal.replace(
    /%([0-9A-F]{2})/g,
    (_match, hex: string) => `%(?:${hex}|${hex.toLowerCase()})`,
  );
  return new RegExp(caseless, "g");
}

function secretForms(value: string): string[] {
  const forms = [value];
  const encoded = encodeURIComponent(value);
  if (encoded !== value) {
    forms.push(encoded);
    const lower = encoded.replace(/%[0-9A-F]{2}/g, (hex) => hex.toLowerCase());
    if (lower !== encoded) forms.push(lower);
  }
  const escaped = JSON.stringify(value).slice(1, -1);
  if (escaped !== value && escaped !== encoded) forms.push(escaped);
  return forms;
}

function pushForm(forms: string[], seen: Set<string>, value: string): void {
  if (value.length < MIN_SUBSTRING_SECRET || seen.has(value)) return;
  seen.add(value);
  forms.push(value);
}

function uniqueNonEmpty(values: readonly string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    if (value.length === 0 || seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }
  return out;
}

function collectSecrets(roots: readonly unknown[]): string[] {
  const found: string[] = [];
  const seen = new Set<string>();
  for (const root of roots) collectFrom(root, found, seen, 0);
  return found;
}

function remember(found: string[], seen: Set<string>, value: string): void {
  if (value.length === 0 || seen.has(value)) return;
  seen.add(value);
  found.push(value);
}

function collectFrom(value: unknown, found: string[], seen: Set<string>, depth: number): void {
  if (depth > MAX_DEPTH || value === null || value === undefined) return;
  if (typeof value === "string") {
    collectUserinfo(value, found, seen);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectFrom(item, found, seen, depth + 1);
    return;
  }
  if (typeof value !== "object") return;
  for (const [key, entry] of Object.entries(value)) {
    if (LAST4_FIELD.test(key) && typeof entry === "string") remember(found, seen, entry);
    if (SENSITIVE_FIELD.test(key)) collectAll(entry, found, seen, depth + 1);
    if (typeof entry === "string" && entry.length > 0) collectUserinfo(entry, found, seen);
    collectFrom(entry, found, seen, depth + 1);
  }
}

/** Every string or number beneath a sensitive key, at any depth, is a secret. */
function collectAll(value: unknown, found: string[], seen: Set<string>, depth: number): void {
  if (depth > MAX_DEPTH || value === null || value === undefined) return;
  if (typeof value === "string") {
    remember(found, seen, value);
    const trimmed = value.trim();
    if (trimmed !== value) remember(found, seen, trimmed);
    return;
  }
  if (typeof value === "number" || typeof value === "bigint") {
    remember(found, seen, value.toString());
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectAll(item, found, seen, depth + 1);
    return;
  }
  if (typeof value === "object") {
    for (const entry of Object.values(value)) collectAll(entry, found, seen, depth + 1);
  }
}

function collectUserinfo(value: string, found: string[], seen: Set<string>): void {
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(value) || !value.includes("@")) return;
  try {
    const url = new URL(value);
    if (url.username.length > 0) remember(found, seen, decodeComponent(url.username));
    if (url.password.length > 0) remember(found, seen, decodeComponent(url.password));
  } catch {
    return;
  }
}

function decodeComponent(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}
