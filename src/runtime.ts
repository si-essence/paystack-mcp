import { TtlCache } from "./cache.js";
import type { Config } from "./config.js";
import { CONNECTOR_NAME } from "./constants.js";
import { HttpClient } from "./http.js";
import { bindLogger, createLogger, type Logger } from "./log.js";
import { SlidingWindowLimiter } from "./rate-limit.js";
import { createSecretScope, type SecretScope } from "./redact.js";

export interface Runtime {
  config: Config;
  client: HttpClient;
  secrets: readonly string[];
  scope: SecretScope;
  logger: Logger;
  cacheTtlSec: number;
}

export interface RuntimeOverrides {
  fetchImpl?: typeof fetch;
  now?: () => number;
  logger?: Logger;
}

export function createRuntime(config: Config, overrides: RuntimeOverrides = {}): Runtime {
  const now = overrides.now ?? Date.now;
  const scope = createSecretScope([config.secret]);
  const logger = overrides.logger ? bindLogger(overrides.logger, scope) : createLogger(scope);
  const client = new HttpClient({
    baseUrl: config.baseUrl,
    fetchImpl: overrides.fetchImpl ?? fetch,
    timeoutMs: config.timeoutMs,
    secrets: scope.baseline,
    cache: new TtlCache(now),
    limiter: new SlidingWindowLimiter(config.perMinute, 60_000, now),
    userAgent: config.userAgent,
    logger,
    secret: config.secret,
    label: CONNECTOR_NAME,
    scope,
  });
  return {
    config,
    client,
    secrets: scope.baseline,
    scope,
    logger,
    cacheTtlSec: config.cacheTtlSec,
  };
}
