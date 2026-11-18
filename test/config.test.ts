import { describe, expect, it } from "vitest";
import { classifyKey, loadConfig } from "../src/config.js";
import { ConnectorError } from "../src/errors.js";
import { KEY } from "./support.js";

const LIVE = "sk_live_fixturekeyvalue01";

function load(env: Record<string, string>): ReturnType<typeof loadConfig> {
  return loadConfig(env, []);
}

describe("config", () => {
  it("accepts an sk_test_ key and defaults the base URL", () => {
    const config = load({ PAYSTACK_SECRET_KEY: KEY });
    expect(config.baseUrl).toBe("https://api.paystack.co");
    expect(config.allowWrites).toBe(false);
    expect(config.allowMoney).toBe(false);
    expect(config.loopback).toBe(false);
    expect(config.secret).toBe(KEY);
  });

  it("accepts a test key against loopback http", () => {
    const config = load({ PAYSTACK_SECRET_KEY: KEY, PAYSTACK_BASE_URL: "http://127.0.0.1:38771" });
    expect(config.loopback).toBe(true);
    expect(config.baseUrl).toBe("http://127.0.0.1:38771");
  });

  it("refuses a live key by default", () => {
    expect(() => load({ PAYSTACK_SECRET_KEY: LIVE })).toThrow(/live_key/);
  });

  it("accepts a live key only with the opt-in on the public https API", () => {
    const config = load({
      PAYSTACK_SECRET_KEY: LIVE,
      PAYSTACK_ALLOW_LIVE_KEY: "true",
      PAYSTACK_BASE_URL: "https://api.paystack.co",
    });
    expect(config.secret).toBe(LIVE);
    expect(config.loopback).toBe(false);
  });

  it("refuses a live key on loopback even when the opt-in is set", () => {
    expect(() =>
      load({
        PAYSTACK_SECRET_KEY: LIVE,
        PAYSTACK_ALLOW_LIVE_KEY: "true",
        PAYSTACK_BASE_URL: "http://127.0.0.1:9",
      }),
    ).toThrow(/live_on_loopback/);
    expect(() =>
      load({
        PAYSTACK_SECRET_KEY: LIVE,
        PAYSTACK_ALLOW_LIVE_KEY: "true",
        PAYSTACK_BASE_URL: "https://localhost:9",
      }),
    ).toThrow(/live_on_loopback/);
  });

  it("does not treat TRUE or 1 as the live opt-in", () => {
    expect(() => load({ PAYSTACK_SECRET_KEY: LIVE, PAYSTACK_ALLOW_LIVE_KEY: "TRUE" })).toThrow(/live_key/);
    expect(() => load({ PAYSTACK_SECRET_KEY: LIVE, PAYSTACK_ALLOW_LIVE_KEY: "1" })).toThrow(/live_key/);
  });

  it("refuses a public key", () => {
    expect(() => load({ PAYSTACK_SECRET_KEY: "pk_test_fixturekeyvalue01" })).toThrow(/public_key/);
    expect(() => load({ PAYSTACK_SECRET_KEY: "pk_live_fixturekeyvalue01" })).toThrow(/public_key/);
  });

  it("refuses restricted keys and other shapes", () => {
    expect(() => load({ PAYSTACK_SECRET_KEY: "rk_test_fixturekeyvalue01" })).toThrow(/rejected/);
    expect(() => load({ PAYSTACK_SECRET_KEY: "sk_test_short" })).toThrow(/rejected/);
  });

  it("refuses a non-https non-loopback base URL", () => {
    expect(() =>
      load({ PAYSTACK_SECRET_KEY: KEY, PAYSTACK_BASE_URL: "http://api.paystack.co" }),
    ).toThrow(/https_required/);
  });

  it("refuses userinfo and a path on the base URL", () => {
    expect(() =>
      load({ PAYSTACK_SECRET_KEY: KEY, PAYSTACK_BASE_URL: "https://user:pass@api.paystack.co" }),
    ).toThrow(/userinfo/);
    expect(() =>
      load({ PAYSTACK_SECRET_KEY: KEY, PAYSTACK_BASE_URL: "https://api.paystack.co/transaction" }),
    ).toThrow(/origin_only/);
  });

  it("enables writes and money only for the exact string true", () => {
    const config = load({
      PAYSTACK_SECRET_KEY: KEY,
      PAYSTACK_ALLOW_WRITES: "true",
      PAYSTACK_ALLOW_MONEY_MOVEMENT: "true",
    });
    expect(config.allowWrites).toBe(true);
    expect(config.allowMoney).toBe(true);
    const off = load({
      PAYSTACK_SECRET_KEY: KEY,
      PAYSTACK_ALLOW_WRITES: "1",
      PAYSTACK_ALLOW_MONEY_MOVEMENT: "yes",
    });
    expect(off.allowWrites).toBe(false);
    expect(off.allowMoney).toBe(false);
  });

  it("classifies key prefixes", () => {
    expect(classifyKey(KEY)).toBe("test");
    expect(classifyKey(LIVE)).toBe("live");
    expect(classifyKey("pk_test_fixturekeyvalue01")).toBe("public");
    expect(classifyKey("nope")).toBe("rejected");
  });

  it("requires a secret key", () => {
    expect(() => loadConfig({}, [])).toThrow(ConnectorError);
  });
});
