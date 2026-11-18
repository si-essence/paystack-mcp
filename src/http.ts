import type { ZodType } from "zod";
import type { BaseUrl, Secret } from "./brand.js";
import { TtlCache } from "./cache.js";
import { ConnectorError } from "./errors.js";
import type { Logger } from "./log.js";
import type { RateLimiter } from "./rate-limit.js";
import {
  createSecretScope,
  currentSecretScope,
  redactUnknown,
  redactUpstream,
  runWithSecretScope,
  type SecretScope,
} from "./redact.js";

const MAX_BODY = 1_000_000;

export type QueryPrimitive = string | number | boolean;
export type QueryValue = QueryPrimitive | readonly QueryPrimitive[];
export type QueryMap = Readonly<Record<string, QueryValue>>;

export interface JsonGet {
  path: string;
  query: QueryMap | undefined;
  ttlSec: number;
}

export interface JsonWrite {
  path: string;
  query: QueryMap | undefined;
  body: unknown;
}

export interface HttpClientOptions {
  baseUrl: BaseUrl;
  fetchImpl: typeof fetch;
  timeoutMs: number;
  secrets: readonly string[];
  cache: TtlCache;
  limiter: RateLimiter;
  userAgent: string;
  logger: Logger;
  secret: Secret;
  label: string;
  scope: SecretScope;
}

type Method = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export class HttpClient {
  private readonly baseUrl: BaseUrl;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly secrets: readonly string[];
  private readonly cache: TtlCache;
  private readonly limiter: RateLimiter;
  private readonly userAgent: string;
  private readonly logger: Logger;
  private readonly secret: Secret;
  private readonly label: string;
  private readonly fallbackScope: SecretScope;

  constructor(options: HttpClientOptions) {
    this.baseUrl = options.baseUrl;
    this.fetchImpl = options.fetchImpl;
    this.timeoutMs = options.timeoutMs;
    this.secrets = options.secrets;
    this.cache = options.cache;
    this.limiter = options.limiter;
    this.userAgent = options.userAgent;
    this.logger = options.logger;
    this.secret = options.secret;
    this.label = options.label;
    this.fallbackScope = options.scope;
  }

  async getJson<T>(request: JsonGet, schema: ZodType<T>): Promise<T> {
    return this.withRequest([request.query], async (scope) => {
      const url = this.buildUrl(request.path, request.query);
      const cacheKey = `GET ${url.origin}${url.pathname}${url.search}`;
      if (request.ttlSec > 0) {
        const cached = this.readCache(cacheKey, schema);
        if (cached !== undefined) return cached;
      }
      const response = await this.dispatch(url, "GET", undefined);
      const text = await readLimited(response, this.label);
      if (!response.ok) throw this.httpError(response, text);
      this.rejectHtml(text, response.status);
      const json = parseFlexibleBody(text, response.status, this.label);
      const envelope = this.envelopeError(json, response.status, scope);
      if (envelope !== undefined) throw envelope;
      return this.accept(cacheKey, request.ttlSec, schema, json, scope);
    });
  }

  async postJson<T>(request: JsonWrite, schema: ZodType<T>): Promise<T> {
    return this.sendJson("POST", request, schema);
  }

  async putJson<T>(request: JsonWrite, schema: ZodType<T>): Promise<T> {
    return this.sendJson("PUT", request, schema);
  }

  async deleteJson<T>(request: JsonWrite, schema: ZodType<T>): Promise<T> {
    return this.sendJson("DELETE", request, schema);
  }

  private async sendJson<T>(method: Method, request: JsonWrite, schema: ZodType<T>): Promise<T> {
    return this.withRequest([request.body, request.query], async (scope) => {
      const bodyText = this.serializeBody(request.body);
      const url = this.buildUrl(request.path, request.query);
      const response = await this.dispatch(url, method, bodyText);
      const text = await readLimited(response, this.label);
      if (!response.ok) throw this.httpError(response, text);
      this.rejectHtml(text, response.status);
      const json = parseFlexibleBody(text, response.status, this.label);
      const envelope = this.envelopeError(json, response.status, scope);
      if (envelope !== undefined) throw envelope;
      const accepted = this.accept(`${method} ${url.pathname}`, 0, schema, json, scope);
      this.cache.clear();
      return accepted;
    });
  }

  private async withRequest<T>(
    extra: readonly unknown[],
    run: (scope: SecretScope) => Promise<T>,
  ): Promise<T> {
    const scope = this.requestScope(extra);
    return runWithSecretScope(scope, () => run(scope));
  }

  private requestScope(extra: readonly unknown[]): SecretScope {
    const active = currentSecretScope(this.fallbackScope);
    if (extra.length === 0) return active;
    return createSecretScope(active.all, ...extra);
  }

  private activeScope(): SecretScope {
    return currentSecretScope(this.fallbackScope);
  }

  private serializeBody(body: unknown): string | undefined {
    if (body === undefined) return undefined;
    let text: string;
    try {
      text = JSON.stringify(body);
    } catch {
      throw new ConnectorError("input", "Request body could not be serialized as JSON.");
    }
    if (text.length > MAX_BODY) {
      throw new ConnectorError("input", "Request body was too large.");
    }
    this.assertNoSecret(text, "Refusing to place a secret in the request.");
    return text;
  }

  private readCache<T>(cacheKey: string, schema: ZodType<T>): T | undefined {
    const cached = this.cache.get(cacheKey);
    if (cached === undefined) return undefined;
    const parsed = schema.safeParse(cached);
    if (parsed.success) return parsed.data;
    this.cache.delete(cacheKey);
    return undefined;
  }

  private accept<T>(
    cacheKey: string,
    ttlSec: number,
    schema: ZodType<T>,
    json: unknown,
    scope: SecretScope,
  ): T {
    const parsed = schema.safeParse(json);
    if (!parsed.success) {
      throw new ConnectorError("upstream", `${this.label} response did not match the expected shape.`);
    }
    if (ttlSec > 0) {
      const safe = schema.safeParse(redactUnknown(parsed.data, scope));
      if (!safe.success) {
        throw new ConnectorError("upstream", `${this.label} response could not be returned safely.`);
      }
      this.cache.set(cacheKey, safe.data, ttlSec);
      return safe.data;
    }
    return parsed.data;
  }

  private envelopeError(json: unknown, status: number, scope: SecretScope): ConnectorError | undefined {
    if (json === null || typeof json !== "object" || Array.isArray(json)) return undefined;
    const record = json as Record<string, unknown>;
    if (record["status"] !== false) return undefined;
    const message = typeof record["message"] === "string" ? record["message"] : "status false";
    const detail = redactUpstream(message, scope);
    return new ConnectorError(
      "upstream",
      `${this.label} HTTP ${status}: Paystack status false: ${detail}`,
    );
  }

  private rejectHtml(text: string, status: number): void {
    if (/<!doctype html|<html[\s>]/i.test(text)) {
      throw new ConnectorError(
        "upstream",
        `${this.label} HTTP ${status}: the service returned an error page instead of JSON.`,
      );
    }
  }

  private buildUrl(path: string, query: QueryMap | undefined): URL {
    if (
      path.length === 0 ||
      path.startsWith("/") ||
      path.includes("?") ||
      path.includes("#") ||
      path.includes("\\") ||
      path.includes("..")
    ) {
      throw new ConnectorError("input", "Request path must be a relative path.");
    }
    this.assertNoSecret(path, "Refusing to place a secret in the request URL.");
    const base = new URL(`${this.baseUrl}/`);
    const url = new URL(path, base);
    if (url.origin !== base.origin) {
      throw new ConnectorError("input", "Request path must stay on the configured base URL.");
    }
    if (query !== undefined) {
      for (const key of Object.keys(query).sort()) {
        const value = query[key];
        if (value === undefined) continue;
        if (Array.isArray(value)) {
          for (const item of value) {
            const text = String(item);
            this.assertNoSecret(text, "Refusing to place a secret in the request URL.");
            url.searchParams.append(key, text);
          }
        } else {
          const text = String(value);
          this.assertNoSecret(text, "Refusing to place a secret in the request URL.");
          url.searchParams.set(key, text);
        }
      }
    }
    return url;
  }

  private assertNoSecret(value: string, message: string): void {
    for (const secret of this.secrets) {
      if (
        secret.length >= 8 &&
        (value.includes(secret) || value.includes(encodeURIComponent(secret)))
      ) {
        this.logger.error(message);
        throw new ConnectorError("config", message);
      }
    }
  }

  private async dispatch(url: URL, method: Method, body: BodyInit | undefined): Promise<Response> {
    this.limiter.acquire();
    const headers = new Headers();
    headers.set("accept", "application/json");
    headers.set("user-agent", this.userAgent);
    headers.set("authorization", `Bearer ${this.secret}`);
    if (body !== undefined) headers.set("content-type", "application/json");
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method,
        headers,
        redirect: "manual",
        signal: AbortSignal.timeout(this.timeoutMs),
        ...(body === undefined ? {} : { body }),
      });
    } catch (error) {
      if (error instanceof ConnectorError) throw error;
      const name = error instanceof Error ? error.name : "";
      if (name === "TimeoutError" || name === "AbortError") {
        const seconds = Math.max(1, Math.round(this.timeoutMs / 1000));
        throw new ConnectorError("timeout", `${this.label} request timed out after ${seconds}s.`);
      }
      const raw = error instanceof Error ? error.message : "network error";
      const safe = redactUpstream(raw, this.activeScope());
      this.logger.error(`${this.label} request failed: ${safe}`);
      throw new ConnectorError("network", `${this.label} request failed: ${safe}`);
    }
    if (response.status >= 300 && response.status < 400) {
      throw new ConnectorError(
        "upstream",
        `${this.label} HTTP ${response.status}: refused to follow a redirect.`,
      );
    }
    return response;
  }

  private httpError(response: Response, text: string): ConnectorError {
    const snippet = redactUpstream(messageOf(text), this.activeScope());
    const detail = snippet.length > 0 ? `: ${snippet}` : "";
    const status = response.status;
    if (status === 401) {
      return new ConnectorError("unauthorized", `${this.label} HTTP 401${detail}`);
    }
    if (status === 403) {
      return new ConnectorError("forbidden", `${this.label} HTTP 403${detail}`);
    }
    if (status === 404) {
      return new ConnectorError("not_found", `${this.label} HTTP 404${detail}`);
    }
    if (status === 409) {
      return new ConnectorError("conflict", `${this.label} HTTP 409${detail}`);
    }
    if (status === 400 || status === 422) {
      return new ConnectorError("input", `${this.label} HTTP ${status}${detail}`);
    }
    if (status === 429) {
      const retry = retryAfterSeconds(response);
      const wait = retry === null ? "" : ` retry after ${retry}s`;
      return new ConnectorError("rate_limit", `${this.label} HTTP 429${detail}${wait}`, retry);
    }
    if (status === 402) {
      return new ConnectorError("upstream", `${this.label} HTTP 402${detail}`);
    }
    if (status >= 500) {
      this.logger.error(`${this.label} HTTP ${status}${detail}`);
      return new ConnectorError("upstream", `${this.label} HTTP ${status} server error${detail}`);
    }
    this.logger.error(`${this.label} HTTP ${status}${detail}`);
    return new ConnectorError("upstream", `${this.label} HTTP ${status}${detail}`);
  }
}

function messageOf(text: string): string {
  const trimmed = text.trim();
  if (!trimmed.startsWith("{")) return text;
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      const message = (parsed as Record<string, unknown>)["message"];
      if (typeof message === "string" && message.length > 0) return message;
    }
  } catch {
    return text;
  }
  return text;
}

function parseFlexibleBody(text: string, status: number, label: string): unknown {
  if (text.trim().length === 0) return { ok: true, status };
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new ConnectorError("upstream", `${label} returned non-JSON (HTTP ${status}).`);
  }
}

async function readLimited(response: Response, label: string): Promise<string> {
  const declared = response.headers.get("content-length");
  if (declared !== null && /^[0-9]+$/.test(declared) && Number(declared) > MAX_BODY) {
    await response.body?.cancel().catch(() => undefined);
    throw new ConnectorError("upstream", `${label} response was too large to parse.`);
  }
  let text = "";
  try {
    text = await response.text();
  } catch {
    throw new ConnectorError("upstream", `${label} response could not be read.`);
  }
  if (text.length > MAX_BODY) {
    throw new ConnectorError("upstream", `${label} response was too large to parse.`);
  }
  return text;
}

function retryAfterSeconds(response: Response): number | null {
  const raw = response.headers.get("retry-after");
  if (raw === null) return null;
  if (/^[0-9]+$/.test(raw)) {
    const seconds = Number(raw);
    return seconds > 0 ? seconds : null;
  }
  const when = Date.parse(raw);
  if (Number.isNaN(when)) return null;
  return Math.max(1, Math.ceil((when - Date.now()) / 1000));
}
