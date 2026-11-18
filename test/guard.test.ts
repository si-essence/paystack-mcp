import { describe, expect, it } from "vitest";
import { OPERATIONS } from "../src/operations.js";
import { dispatch } from "../src/handlers.js";
import { inputSchemaFor } from "../src/fields.js";
import { jsonResponse, runtimeWith, sampleArgs } from "./support.js";

const gated = OPERATIONS.filter((operation) => operation.risk !== "read");

function requestUrl(input: Parameters<typeof fetch>[0]): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

function flags(writes: boolean, money: boolean): Record<string, string> {
  return {
    ...(writes ? { PAYSTACK_ALLOW_WRITES: "true" } : {}),
    ...(money ? { PAYSTACK_ALLOW_MONEY_MOVEMENT: "true" } : {}),
  };
}

describe("write and money guard matrix", () => {
  it("covers every write and money operation", () => {
    const writes = OPERATIONS.filter((operation) => operation.risk === "write");
    const money = OPERATIONS.filter((operation) => operation.risk === "money");
    expect(writes.length).toBeGreaterThan(0);
    expect(money.map((operation) => operation.action).sort()).toEqual([
      "bulk",
      "charge_authorization",
      "create",
      "finalize",
      "initialize",
      "initiate",
      "partial_debit",
    ]);
    expect(gated.length).toBe(writes.length + money.length);
  });

  for (const operation of gated) {
    const label = `${operation.tool}.${operation.action}`;

    it(`${label} does not send when confirm is missing`, async () => {
      let calls = 0;
      const runtime = runtimeWith(flags(true, true), () => {
        calls += 1;
        return Promise.resolve(jsonResponse(200, { status: true, data: {} }));
      });
      const result = await dispatch(runtime, operation.tool, sampleArgs(operation));
      expect(calls).toBe(0);
      expect(result["executed"]).toBe(false);
      expect(result["dry_run"]).toBe(true);
      expect(result["blocked"]).toBe(false);
      expect(String(result["reason"])).toContain("confirm:true");
    });

    it(`${label} does not send when confirm is false`, async () => {
      let calls = 0;
      const runtime = runtimeWith(flags(true, true), () => {
        calls += 1;
        return Promise.resolve(jsonResponse(200, { status: true, data: {} }));
      });
      const result = await dispatch(runtime, operation.tool, { ...sampleArgs(operation), confirm: false });
      expect(calls).toBe(0);
      expect(result["executed"]).toBe(false);
      expect(String(result["reason"])).toContain("confirm:true");
    });

    it(`${label} does not send when writes are off`, async () => {
      let calls = 0;
      const runtime = runtimeWith(flags(false, true), () => {
        calls += 1;
        return Promise.resolve(jsonResponse(200, { status: true, data: {} }));
      });
      const result = await dispatch(runtime, operation.tool, { ...sampleArgs(operation), confirm: true });
      expect(calls).toBe(0);
      expect(result["blocked"]).toBe(true);
      expect(String(result["reason"])).toContain("PAYSTACK_ALLOW_WRITES=true");
    });

    it(`${label} honours the money switch`, async () => {
      let calls = 0;
      const runtime = runtimeWith(flags(true, false), () => {
        calls += 1;
        return Promise.resolve(jsonResponse(200, { status: true, data: { reference: "ref_1" } }));
      });
      const result = await dispatch(runtime, operation.tool, { ...sampleArgs(operation), confirm: true });
      if (operation.risk === "money") {
        expect(calls).toBe(0);
        expect(result["blocked"]).toBe(true);
        expect(String(result["reason"])).toContain("PAYSTACK_ALLOW_MONEY_MOVEMENT=true");
        expect(String(result["reason"])).not.toContain("PAYSTACK_ALLOW_WRITES=true");
      } else {
        expect(calls).toBe(1);
        expect(result["executed"]).toBe(true);
      }
    });

    it(`${label} sends only when every required switch is on`, async () => {
      let calls = 0;
      let seen = "";
      const runtime = runtimeWith(flags(true, true), (input) => {
        calls += 1;
        seen = requestUrl(input);
        return Promise.resolve(jsonResponse(200, { status: true, data: { ok: true } }));
      });
      const result = await dispatch(runtime, operation.tool, { ...sampleArgs(operation), confirm: true });
      expect(calls).toBe(1);
      expect(result["executed"]).toBe(true);
      expect(result["dry_run"]).toBe(false);
      expect(seen).toContain(operation.path.replace(/\{[^}]+\}/g, "").split("/").filter(Boolean)[0] ?? "");
    });
  }
});

describe("pagination and strict input", () => {
  it("sends perPage, page, and cursor query params", async () => {
    let url = "";
    const runtime = runtimeWith({}, (input) => {
      url = requestUrl(input);
      return Promise.resolve(
        jsonResponse(200, {
          status: true,
          data: [],
          meta: { page: 2, perPage: 20, next: "cursor_page_3", previous: null },
        }),
      );
    });
    const result = await dispatch(runtime, "paystack_transactions", {
      action: "list",
      perPage: 20,
      page: 2,
      use_cursor: true,
      next: "cursor_page_3",
    });
    expect(url).toContain("perPage=20");
    expect(url).toContain("page=2");
    expect(url).toContain("use_cursor=true");
    expect(url).toContain("next=cursor_page_3");
    expect(result["meta"]).toMatchObject({ next: "cursor_page_3" });
  });

  it("rejects unknown fields and non-integer amounts", () => {
    const schema = inputSchemaFor("paystack_transactions");
    expect(schema.safeParse({ action: "list", extra: true }).success).toBe(false);
    expect(schema.safeParse({ action: "initialize", amount: 10.5, email: "a@b.co" }).success).toBe(false);
    expect(schema.safeParse({ action: "initialize", amount: 0, email: "a@b.co" }).success).toBe(false);
    expect(schema.safeParse({ action: "initialize", amount: 100, email: "a@b.co", currency: "GBP" }).success).toBe(
      false,
    );
    expect(schema.safeParse({ action: "list", currency: "XOF" }).success).toBe(true);
    expect(schema.safeParse({ action: "nope" }).success).toBe(false);
  });

  it("redacts authorization codes and account numbers in a preview", async () => {
    const runtime = runtimeWith({}, () => {
      throw new Error("should not send");
    });
    const result = await dispatch(runtime, "paystack_transactions", {
      action: "charge_authorization",
      email: "ada@example.com",
      amount: 15000,
      authorization_code: "AUTH_fixturecode01",
      currency: "GHS",
    });
    const text = JSON.stringify(result);
    expect(text).not.toContain("AUTH_fixturecode01");
    expect(text).toContain("[redacted]");
    expect(text).toContain("PAYSTACK_ALLOW_WRITES=true");
    expect(text).toContain("PAYSTACK_ALLOW_MONEY_MOVEMENT=true");
  });
});
