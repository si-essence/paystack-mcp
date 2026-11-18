import { describe, expect, it } from "vitest";
import { createSecretScope, maskLast4, redact, redactUnknown } from "../src/redact.js";
import { KEY } from "./support.js";

const scope = createSecretScope([KEY]);

describe("redaction", () => {
  it("masks the secret key exact, percent-encoded, JSON-escaped, and bearer forms", () => {
    const encoded = encodeURIComponent(KEY);
    const escaped = JSON.stringify(`prefix ${KEY}`).slice(1, -1);
    const text = `key ${KEY} enc ${encoded} json ${escaped} Authorization: Bearer ${KEY}`;
    const out = redact(text, scope.maskable);
    expect(out).not.toContain(KEY);
    expect(out).not.toContain(encoded);
    expect(out).toContain("[redacted]");
  });

  it("redacts authorization codes and webhook secrets", () => {
    const code = "AUTH_fixturecode01";
    const hook = "whsec_fixturesecretvalue";
    const local = createSecretScope([KEY], { authorization_code: code, webhook_secret: hook });
    const out = redactUnknown(
      {
        authorization: { authorization_code: code, last4: "4081", signature: "SIG_fixturevalue01" },
        webhook_secret: hook,
        account_number: "0123456789",
      },
      local,
    );
    const text = JSON.stringify(out);
    expect(text).not.toContain(code);
    expect(text).not.toContain(hook);
    expect(text).not.toContain("SIG_fixturevalue01");
    expect(text).not.toContain("0123456789");
    expect(text).toContain(maskLast4("0123456789"));
    expect(text).toContain("4081");
  });

  it("does not treat a short account fragment as a global wipe when it is long enough", () => {
    const local = createSecretScope([KEY], { account_number: "0123456789" });
    expect(local.hasShort).toBe(false);
    const out = redact("balance 0123456789 ready", local.maskable);
    expect(out).not.toContain("0123456789");
  });
});
