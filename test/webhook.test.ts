import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { handleWebhook, verifyPaystackSignature } from "../src/webhook.js";
import { KEY } from "./support.js";

const RAW = '{"event":"charge.success","data":{"reference":"ref_mock_1","amount":15000}}';

function sign(body: string, key = KEY): string {
  return createHmac("sha512", key).update(body, "utf8").digest("hex");
}

describe("webhook signature", () => {
  it("accepts a valid HMAC-SHA512 signature", () => {
    const signature = sign(RAW);
    expect(verifyPaystackSignature(RAW, signature, KEY)).toEqual({ valid: true, reason: "ok" });
    const result = handleWebhook({ action: "verify_signature", raw_body: RAW, signature }, KEY);
    expect(result["valid"]).toBe(true);
    expect(JSON.stringify(result)).not.toContain(KEY);
    expect(JSON.stringify(result)).not.toContain(signature);
  });

  it("rejects a tampered body", () => {
    const signature = sign(RAW);
    const result = verifyPaystackSignature(`${RAW} `, signature, KEY);
    expect(result.valid).toBe(false);
    expect(result.reason).toBe("mismatch");
  });

  it("rejects a signature from the wrong key", () => {
    const signature = sign(RAW, "sk_test_anotherfixturekey9");
    expect(verifyPaystackSignature(RAW, signature, KEY).reason).toBe("mismatch");
  });

  it("rejects a missing header", () => {
    expect(verifyPaystackSignature(RAW, undefined, KEY).reason).toBe("missing_header");
    expect(verifyPaystackSignature(RAW, "   ", KEY).reason).toBe("missing_header");
    const result = handleWebhook({ action: "verify_signature", raw_body: RAW }, KEY);
    expect(result["reason"]).toBe("missing_header");
    expect(JSON.stringify(result)).not.toContain(KEY);
  });

  it("rejects a length mismatch without throwing", () => {
    expect(verifyPaystackSignature(RAW, "abc", KEY)).toEqual({ valid: false, reason: "length_mismatch" });
  });
});
