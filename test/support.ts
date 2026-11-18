import { loadConfig, type Config } from "../src/config.js";
import { createRuntime, type Runtime } from "../src/runtime.js";
import type { Operation } from "../src/operations.js";

export const KEY = "sk_test_fixturekeyvalue01";

export function testConfig(extra: Record<string, string> = {}): Config {
  return loadConfig(
    {
      PAYSTACK_SECRET_KEY: KEY,
      PAYSTACK_BASE_URL: "http://127.0.0.1:9",
      ...extra,
    },
    [],
  );
}

export function runtimeWith(
  extra: Record<string, string>,
  fetchImpl: typeof fetch,
): Runtime {
  return createRuntime(testConfig(extra), { fetchImpl });
}

export function jsonResponse(status: number, body: unknown, headers?: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

export function sampleArgs(operation: Operation): Record<string, unknown> {
  const args: Record<string, unknown> = { action: operation.action };
  for (const field of operation.fields) {
    args[field.name] = sampleValue(field.name, field.type);
  }
  return args;
}

function sampleValue(name: string, type: string): unknown {
  switch (type) {
    case "string":
      if (name === "email" || name === "customer_email") return "ada@example.com";
      if (name === "authorization_code") return "AUTH_fixturecode01";
      if (name === "account_number") return "0123456789";
      if (name === "otp") return "123456";
      if (name.includes("url")) return "https://example.com/callback";
      return `${name}_value`;
    case "page":
    case "integer":
      return 1;
    case "subunit":
      return 15000;
    case "boolean":
      return true;
    case "currency":
      return "GHS";
    case "risk_action":
      return "deny";
    case "resolution":
      return "declined";
    case "source":
      return "balance";
    case "json":
      if (name === "transfers") {
        return [{ amount: 15000, recipient: "RCP_fixture", reference: "ref_bulk_1" }];
      }
      if (name === "channels") return ["card", "mobile_money"];
      return { note: "fixture" };
    default:
      return "value";
  }
}
