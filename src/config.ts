import { z } from "zod";
import { brandBaseUrl, brandSecret, type BaseUrl, type Secret } from "./brand.js";
import { CONNECTOR_NAME, CONNECTOR_VERSION, DEFAULT_BASE_URL } from "./constants.js";
import { ConnectorError } from "./errors.js";
import { fixedError } from "./zod-messages.js";

const invalid = fixedError("invalid");

const EnvSchema = z.object({
  PAYSTACK_SECRET_KEY: z.string({ error: invalid }).min(1, { error: invalid }).max(4096, { error: invalid }),
  PAYSTACK_BASE_URL: z.string({ error: invalid }).optional(),
  PAYSTACK_ALLOW_WRITES: z.string({ error: invalid }).optional(),
  PAYSTACK_ALLOW_MONEY_MOVEMENT: z.string({ error: invalid }).optional(),
  PAYSTACK_ALLOW_LIVE_KEY: z.string({ error: invalid }).optional(),
  PAYSTACK_PER_MINUTE: z.string({ error: invalid }).regex(/^[0-9]+$/, { error: invalid }).optional(),
  PAYSTACK_TIMEOUT_MS: z.string({ error: invalid }).regex(/^[0-9]+$/, { error: invalid }).optional(),
  PAYSTACK_CONTACT: z.string({ error: invalid }).trim().min(1, { error: invalid }).max(120, { error: invalid }).optional(),
  PAYSTACK_CACHE_TTL_SEC: z.string({ error: invalid }).regex(/^[0-9]+$/, { error: invalid }).optional(),
  MCP_TRANSPORT: z.enum(["stdio", "http"], { error: invalid }).optional(),
  PORT: z.string({ error: invalid }).regex(/^[0-9]+$/, { error: invalid }).optional(),
});

export interface Config {
  secret: Secret;
  baseUrl: BaseUrl;
  allowWrites: boolean;
  allowMoney: boolean;
  loopback: boolean;
  perMinute: number;
  timeoutMs: number;
  contact: string;
  transport: "stdio" | "http";
  port: number;
  cacheTtlSec: number;
  userAgent: string;
}

export type KeyKind = "test" | "live" | "public" | "rejected";

function hasControlChar(value: string): boolean {
  for (const char of value) {
    const code = char.charCodeAt(0);
    if (code <= 31 || code === 127) return true;
  }
  return false;
}

function blank(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

function read(env: NodeJS.ProcessEnv, name: string): string | undefined {
  return blank(env[name]);
}

function enabled(env: NodeJS.ProcessEnv, name: string): boolean {
  return read(env, name) === "true";
}

function boundedInt(raw: string | undefined, fallback: number, min: number, max: number, field: string): number {
  if (raw === undefined) return fallback;
  const parsed = z.number().int().min(min).max(max).safeParse(Number(raw));
  if (!parsed.success) {
    throw new ConnectorError("config", `Invalid environment: ${field} (out_of_range).`);
  }
  return parsed.data;
}

function userAgentFor(contact: string): string {
  const clean = contact.replace(/[\r\n]+/g, " ").trim().slice(0, 120);
  return `${CONNECTOR_NAME}/${CONNECTOR_VERSION} (${clean.length > 0 ? clean : "contact@example.com"})`;
}

export function isLoopbackHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  return host === "localhost" || host === "::1" || host.startsWith("127.");
}

export function classifyKey(secret: string): KeyKind {
  if (secret.startsWith("pk_")) return "public";
  if (/^sk_test_[A-Za-z0-9_]{8,}$/.test(secret)) return "test";
  if (/^sk_live_[A-Za-z0-9_]{8,}$/.test(secret)) return "live";
  return "rejected";
}

export function normalizeBaseUrl(value: string): { baseUrl: BaseUrl; loopback: boolean } {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ConnectorError("config", "Invalid environment: PAYSTACK_BASE_URL (invalid_url).");
  }
  if (url.username !== "" || url.password !== "") {
    throw new ConnectorError("config", "Invalid environment: PAYSTACK_BASE_URL (userinfo).");
  }
  if (url.search !== "" || url.hash !== "") {
    throw new ConnectorError("config", "Invalid environment: PAYSTACK_BASE_URL (query_or_hash).");
  }
  const loopback = isLoopbackHost(url.hostname);
  if (url.protocol === "http:") {
    if (!loopback) {
      throw new ConnectorError(
        "config",
        "Invalid environment: PAYSTACK_BASE_URL (https_required). Only a loopback host may use http.",
      );
    }
  } else if (url.protocol !== "https:") {
    throw new ConnectorError("config", "Invalid environment: PAYSTACK_BASE_URL (https_required).");
  }
  const path = url.pathname.replace(/\/+$/, "") || "/";
  if (path !== "/") {
    throw new ConnectorError(
      "config",
      "Invalid environment: PAYSTACK_BASE_URL (origin_only). Pass the origin. The client adds the API path.",
    );
  }
  return { baseUrl: brandBaseUrl(url.origin), loopback };
}

/**
 * Refuse public keys, unknown key shapes, live keys without the opt-in, and
 * any live key aimed at loopback (a mock must never see sk_live_).
 */
export function assertSecretKey(secret: string, allowLive: boolean, loopback: boolean): void {
  if (hasControlChar(secret)) {
    throw new ConnectorError("config", "Invalid environment: PAYSTACK_SECRET_KEY (control_char).");
  }
  const kind = classifyKey(secret);
  if (kind === "public") {
    throw new ConnectorError(
      "config",
      "Invalid environment: PAYSTACK_SECRET_KEY (public_key). Public keys (pk_) are not a secret.",
    );
  }
  if (kind === "rejected") {
    throw new ConnectorError(
      "config",
      "Invalid environment: PAYSTACK_SECRET_KEY (rejected). Use an sk_test_ key, or an sk_live_ key with PAYSTACK_ALLOW_LIVE_KEY=true.",
    );
  }
  if (kind === "live" && loopback) {
    throw new ConnectorError(
      "config",
      "Invalid environment: PAYSTACK_SECRET_KEY (live_on_loopback). A live key is never sent to a loopback base URL.",
    );
  }
  if (kind === "live" && !allowLive) {
    throw new ConnectorError(
      "config",
      "Invalid environment: PAYSTACK_SECRET_KEY (live_key). Live keys are refused unless PAYSTACK_ALLOW_LIVE_KEY=true.",
    );
  }
}

export function loadConfig(env: NodeJS.ProcessEnv, argv: readonly string[]): Config {
  const secretRaw = read(env, "PAYSTACK_SECRET_KEY");
  if (secretRaw === undefined) {
    throw new ConnectorError(
      "config",
      "Invalid environment: PAYSTACK_SECRET_KEY (required). Use an sk_test_ key unless PAYSTACK_ALLOW_LIVE_KEY=true.",
    );
  }
  const parsed = EnvSchema.safeParse({
    PAYSTACK_SECRET_KEY: secretRaw,
    PAYSTACK_BASE_URL: read(env, "PAYSTACK_BASE_URL"),
    PAYSTACK_ALLOW_WRITES: read(env, "PAYSTACK_ALLOW_WRITES"),
    PAYSTACK_ALLOW_MONEY_MOVEMENT: read(env, "PAYSTACK_ALLOW_MONEY_MOVEMENT"),
    PAYSTACK_ALLOW_LIVE_KEY: read(env, "PAYSTACK_ALLOW_LIVE_KEY"),
    PAYSTACK_PER_MINUTE: read(env, "PAYSTACK_PER_MINUTE"),
    PAYSTACK_TIMEOUT_MS: read(env, "PAYSTACK_TIMEOUT_MS"),
    PAYSTACK_CONTACT: read(env, "PAYSTACK_CONTACT"),
    PAYSTACK_CACHE_TTL_SEC: read(env, "PAYSTACK_CACHE_TTL_SEC"),
    MCP_TRANSPORT: read(env, "MCP_TRANSPORT"),
    PORT: read(env, "PORT"),
  });
  if (!parsed.success) {
    throw new ConnectorError("config", "Invalid environment: PAYSTACK_SECRET_KEY (invalid).");
  }
  const baseRaw = parsed.data.PAYSTACK_BASE_URL ?? DEFAULT_BASE_URL;
  const { baseUrl, loopback } = normalizeBaseUrl(baseRaw);
  const allowLive = enabled(env, "PAYSTACK_ALLOW_LIVE_KEY");
  assertSecretKey(secretRaw, allowLive, loopback);
  const transport = argv.includes("--http") ? "http" : (parsed.data.MCP_TRANSPORT ?? "stdio");
  const contact = parsed.data.PAYSTACK_CONTACT ?? "contact@example.com";
  return {
    secret: brandSecret(secretRaw),
    baseUrl,
    allowWrites: enabled(env, "PAYSTACK_ALLOW_WRITES"),
    allowMoney: enabled(env, "PAYSTACK_ALLOW_MONEY_MOVEMENT"),
    loopback,
    perMinute: boundedInt(parsed.data.PAYSTACK_PER_MINUTE, 60, 1, 600, "PAYSTACK_PER_MINUTE"),
    timeoutMs: boundedInt(parsed.data.PAYSTACK_TIMEOUT_MS, 20_000, 1000, 120_000, "PAYSTACK_TIMEOUT_MS"),
    contact,
    transport,
    port: boundedInt(parsed.data.PORT, 3000, 1, 65535, "PORT"),
    cacheTtlSec: boundedInt(parsed.data.PAYSTACK_CACHE_TTL_SEC, 0, 0, 3600, "PAYSTACK_CACHE_TTL_SEC"),
    userAgent: userAgentFor(contact),
  };
}
