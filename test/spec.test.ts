import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { EXCLUSIONS, OPERATIONS, requireMoneyCheck, toolNames } from "../src/operations.js";

interface InventoryRoute {
  method: string;
  path: string;
  operationId: string;
  tool: string;
  action: string;
  risk: "read" | "write" | "money";
  purpose: string;
  money?: boolean;
}

interface Inventory {
  routes: InventoryRoute[];
  excluded: { method: string; path: string; operationId: string; reason: string }[];
}

const inventory = JSON.parse(readFileSync(new URL("../spec/api-inventory.json", import.meta.url), "utf8")) as Inventory;

const PRIORITY = [
  "transaction_list",
  "transaction_fetch",
  "transaction_verify",
  "transaction_timeline",
  "transaction_totals",
  "transaction_export",
  "transaction_initialize",
  "transaction_charge_authorization",
  "transaction_partial_debit",
  "customer_list",
  "customer_fetch",
  "customer_create",
  "customer_update",
  "customer_validate",
  "customer_set_risk_action",
  "paymentrequest_list",
  "paymentrequest_fetch",
  "paymentrequest_create",
  "paymentrequest_update",
  "paymentrequest_verify",
  "paymentrequest_notify",
  "paymentrequest_finalize",
  "paymentrequest_archive",
  "paymentrequest_totals",
  "settlement_list",
  "settlement_transactions",
  "refund_list",
  "refund_fetch",
  "refund_create",
  "dispute_list",
  "dispute_fetch",
  "dispute_transaction",
  "dispute_export",
  "dispute_update",
  "dispute_evidence",
  "dispute_resolve",
  "transfer_list",
  "transfer_fetch",
  "transfer_verify",
  "transfer_initiate",
  "transfer_finalize",
  "transfer_bulk",
  "recipient_list",
  "recipient_fetch",
  "recipient_create",
  "recipient_update",
  "recipient_delete",
  "balance_fetch",
  "balance_ledger",
  "bank_list",
  "bank_resolve",
  "country_list",
  "states_list",
  "bank_validate",
  "subaccount_list",
  "plan_list",
  "subscription_list",
  "product_list",
  "page_list",
];

describe("spec coverage", () => {
  it("maps every inventory route and no extras", () => {
    expect(OPERATIONS.length).toBe(inventory.routes.length);
    for (const route of inventory.routes) {
      const found = OPERATIONS.find((operation) => operation.operationId === route.operationId);
      expect(found, route.operationId).toBeDefined();
      expect(found?.method).toBe(route.method);
      expect(found?.path).toBe(route.path);
      expect(found?.risk).toBe(route.risk);
      expect(found?.tool).toBe(route.tool);
      expect(found?.action).toBe(route.action);
      expect(found?.summary).toBe(route.purpose);
    }
  });

  it("keeps exclusions out of the registry", () => {
    expect(EXCLUSIONS.length).toBe(inventory.excluded.length);
    const mapped = new Set(OPERATIONS.map((operation) => `${operation.method} ${operation.path}`));
    for (const route of inventory.excluded) {
      expect(mapped.has(`${route.method} ${route.path}`)).toBe(false);
      expect(route.reason.length).toBeGreaterThan(12);
    }
  });

  it("covers the Accounts Team priority list", () => {
    const ids = new Set(OPERATIONS.map((operation) => operation.operationId));
    for (const id of PRIORITY) {
      expect(ids.has(id), id).toBe(true);
    }
  });

  it("tags money operations and rejects a forged money op", () => {
    const money = OPERATIONS.filter((operation) => operation.risk === "money");
    expect(money.length).toBe(7);
    for (const operation of money) {
      requireMoneyCheck(operation);
    }
    const real = money[0];
    expect(real).toBeDefined();
    if (real === undefined) return;
    const forged: { tool: string; action: string; money: boolean } = {
      tool: real.tool,
      action: real.action,
      money: true,
    };
    expect(() => {
      requireMoneyCheck(forged);
    }).toThrow(/money check/);
  });

  it("registers one action tool per group plus the local webhook tool name is separate", () => {
    expect(toolNames()).toEqual([
      "paystack_balance",
      "paystack_catalog",
      "paystack_customers",
      "paystack_disputes",
      "paystack_invoices",
      "paystack_lookups",
      "paystack_recipients",
      "paystack_refunds",
      "paystack_settlements",
      "paystack_transactions",
      "paystack_transfers",
    ]);
  });
});
