import { describe, expect, it } from "vitest";
import { ConnectorError } from "../src/errors.js";
import { dispatch } from "../src/handlers.js";
import { toPublicMessage } from "../src/tools.js";
import { jsonResponse, KEY, runtimeWith } from "./support.js";

function fail(status: number, message: string, headers?: Record<string, string>): typeof fetch {
  return () => Promise.resolve(jsonResponse(status, { status: false, message }, headers));
}

async function fetchTxn(fetchImpl: typeof fetch): Promise<unknown> {
  const runtime = runtimeWith({}, fetchImpl);
  return dispatch(runtime, "paystack_transactions", { action: "fetch", id: "1" });
}

describe("Paystack error mapping", () => {
  it("maps 401 to unauthorized", async () => {
    await expect(fetchTxn(fail(401, "Invalid key"))).rejects.toMatchObject({ code: "unauthorized" });
  });

  it("maps 403 to forbidden", async () => {
    await expect(fetchTxn(fail(403, "Forbidden"))).rejects.toMatchObject({ code: "forbidden" });
  });

  it("maps 404 to not_found", async () => {
    await expect(fetchTxn(fail(404, "Not found"))).rejects.toMatchObject({ code: "not_found" });
  });

  it("maps 400 and 422 to input and keeps the envelope message", async () => {
    await expect(fetchTxn(fail(400, "Email is invalid"))).rejects.toThrow(/Email is invalid/);
    await expect(fetchTxn(fail(422, "Amount is invalid"))).rejects.toMatchObject({ code: "input" });
  });

  it("maps 429 with Retry-After and does not retry", async () => {
    let calls = 0;
    const fetchImpl: typeof fetch = () => {
      calls += 1;
      return Promise.resolve(jsonResponse(429, { status: false, message: "slow down" }, { "retry-after": "7" }));
    };
    try {
      await fetchTxn(fetchImpl);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(ConnectorError);
      const parsed = error as ConnectorError;
      expect(parsed.code).toBe("rate_limit");
      expect(parsed.retryAfterSeconds).toBe(7);
      expect(parsed.message).toContain("retry after 7s");
    }
    expect(calls).toBe(1);
  });

  it("maps 5xx to upstream", async () => {
    await expect(fetchTxn(fail(502, "bad gateway"))).rejects.toMatchObject({ code: "upstream" });
  });

  it("maps a 200 status false envelope to upstream", async () => {
    await expect(fetchTxn(fail(200, "Email is invalid"))).rejects.toThrow(/status false/);
  });

  it("does not leak the secret key from an error body", async () => {
    const runtime = runtimeWith({}, fail(401, `Invalid key ${KEY}`));
    try {
      await dispatch(runtime, "paystack_transactions", { action: "fetch", id: "1" });
      expect.unreachable();
    } catch (error) {
      const text = toPublicMessage(error, runtime.scope);
      expect(text).not.toContain(KEY);
      expect(text).toContain("[redacted]");
      expect(text.startsWith("[unauthorized]")).toBe(true);
    }
  });
});
