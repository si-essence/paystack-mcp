import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { fixedError } from "./zod-messages.js";

const invalid = fixedError("invalid");

export const webhookInput = z
  .object({
    action: z.enum(["verify_signature"], { error: invalid }),
    raw_body: z.string({ error: invalid }).max(1_000_000, { error: invalid }),
    signature: z.string({ error: invalid }).max(512, { error: invalid }).optional(),
  })
  .strict();

export type WebhookInput = z.infer<typeof webhookInput>;

export interface SignatureResult {
  valid: boolean;
  reason: "ok" | "missing_header" | "length_mismatch" | "mismatch";
}

/**
 * Paystack signs the raw body with HMAC-SHA512 and the secret key.
 * Compare in constant time. Never return the key or the digest.
 */
export function verifyPaystackSignature(
  rawBody: string,
  header: string | undefined,
  secret: string,
): SignatureResult {
  if (header === undefined || header.trim().length === 0) {
    return { valid: false, reason: "missing_header" };
  }
  const digest = createHmac("sha512", secret).update(rawBody, "utf8").digest("hex");
  const left = Buffer.from(digest, "utf8");
  const right = Buffer.from(header.trim(), "utf8");
  if (left.length !== right.length) {
    return { valid: false, reason: "length_mismatch" };
  }
  const valid = timingSafeEqual(left, right);
  return valid ? { valid: true, reason: "ok" } : { valid: false, reason: "mismatch" };
}

export function handleWebhook(args: WebhookInput, secret: string): Record<string, unknown> {
  const result = verifyPaystackSignature(args.raw_body, args.signature, secret);
  return {
    valid: result.valid,
    reason: result.reason,
    algorithm: "HMAC-SHA512",
    header: "x-paystack-signature",
  };
}
