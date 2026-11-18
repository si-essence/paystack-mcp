#!/usr/bin/env node
/**
 * MCP live check against the local Paystack mock only.
 * Does not call api.paystack.co, does not use a live key, and does not move money.
 */
import { createHmac } from "node:crypto";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

delete process.env["DATABASE_URL"];

const MOCK_KEY = "sk_test_mockpaystackkey0001";
const root = fileURLToPath(new URL("..", import.meta.url));
const port = (process.env["PAYSTACK_MOCK_PORT"] ?? "").trim();
if (!/^[0-9]+$/.test(port)) {
  process.stderr.write("PAYSTACK_MOCK_PORT is required.\n");
  process.exit(1);
}
const baseUrl = `http://127.0.0.1:${port}`;
const realTestKeyPresent =
  typeof process.env["PAYSTACK_TEST_SECRET_KEY"] === "string" &&
  process.env["PAYSTACK_TEST_SECRET_KEY"].startsWith("sk_");

const secrets = [MOCK_KEY, "AUTH_mocksecret01", "SIG_mocksecret01", "0123456789"];

function redact(text) {
  let out = String(text);
  for (const secret of secrets) {
    if (secret.length < 4) continue;
    out = out.split(secret).join("[redacted]");
    out = out.split(encodeURIComponent(secret)).join("[redacted]");
  }
  return out.replace(/sk_(test|live)_[A-Za-z0-9_]+/g, "[redacted]");
}

let failed = 0;
let passed = 0;

function record(name, ok, detail) {
  if (ok) passed += 1;
  else failed += 1;
  const line = `${ok ? "PASS" : "FAIL"}  ${name}  ${redact(detail).replace(/\s+/g, " ").slice(0, 240)}`;
  process.stdout.write(`${line}\n`);
}

function textOf(result) {
  const structured = result.structuredContent;
  if (structured !== undefined) return JSON.stringify(structured);
  const content = result.content;
  if (!Array.isArray(content)) return JSON.stringify(result);
  return content
    .map((block) => (block !== null && typeof block === "object" && "text" in block ? String(block.text) : ""))
    .join("\n");
}

async function open(extra) {
  const env = { ...process.env };
  delete env["DATABASE_URL"];
  delete env["PAYSTACK_TEST_SECRET_KEY"];
  delete env["PAYSTACK_ALLOW_LIVE_KEY"];
  delete env["PAYSTACK_SECRET_KEY"];
  env["PAYSTACK_SECRET_KEY"] = MOCK_KEY;
  env["PAYSTACK_BASE_URL"] = baseUrl;
  env["PAYSTACK_ALLOW_WRITES"] = extra.writes === true ? "true" : "false";
  env["PAYSTACK_ALLOW_MONEY_MOVEMENT"] = extra.money === true ? "true" : "false";
  const transport = new StdioClientTransport({
    command: "node",
    args: ["dist/index.js"],
    cwd: root,
    env,
    stderr: "pipe",
  });
  const client = new Client({ name: "paystack-live-check", version: "0.0.0" });
  await client.connect(transport);
  const stderr = transport.stderr;
  if (stderr !== null && stderr !== undefined) {
    stderr.on("data", () => {});
  }
  return {
    client,
    async close() {
      await client.close();
      await transport.close();
    },
  };
}

async function call(session, name, args) {
  return session.client.callTool({ name, arguments: args });
}

async function main() {
  process.stdout.write(
    `mock ${baseUrl} real_test_key_present=${realTestKeyPresent} target=local-mock-only\n`,
  );
  const health = await fetch(`${baseUrl}/health`);
  record("mock health", health.ok, `status ${health.status}`);

  const fixtureResponse = await fetch(`${baseUrl}/_fixture/webhook`);
  const fixture = await fixtureResponse.json();
  const expected = createHmac("sha512", MOCK_KEY).update(String(fixture.raw), "utf8").digest("hex");
  record(
    "webhook fixture",
    fixture.signature === expected && fixture.raw.includes("ref_mock_1"),
    "signed locally by the mock",
  );

  const read = await open({ writes: false, money: false });
  try {
    const tools = await read.client.listTools();
    const names = tools.tools.map((tool) => tool.name);
    record("tool list", names.length === 12 && names.includes("paystack_webhook"), names.join(","));
    const listed = await call(read, "paystack_transactions", {
      action: "list",
      perPage: 2,
      page: 2,
      use_cursor: true,
      next: "cursor_page_2",
      currency: "GHS",
    });
    const listedText = textOf(listed);
    record(
      "transactions list",
      listed.isError !== true && listedText.includes("ref_mock_1") && listedText.includes("cursor_page_2"),
      listedText,
    );
    const banks = await call(read, "paystack_lookups", {
      action: "banks",
      country: "ghana",
      type: "mobile_money",
    });
    const banksText = textOf(banks);
    record("ghana momo banks", banks.isError !== true && banksText.includes("MTN"), banksText);
    const balance = await call(read, "paystack_balance", { action: "balance" });
    const balanceText = textOf(balance);
    record("balance", balance.isError !== true && balanceText.includes("GHS"), balanceText);
    const settlements = await call(read, "paystack_settlements", { action: "list", perPage: 1, page: 1 });
    record("settlements", settlements.isError !== true && textOf(settlements).includes("/settlement"), textOf(settlements));
    const preview = await call(read, "paystack_customers", {
      action: "create",
      confirm: true,
      email: "ada@example.com",
      first_name: "Ada",
    });
    const previewText = textOf(preview);
    record(
      "write preview blocked",
      preview.isError !== true && previewText.includes("PAYSTACK_ALLOW_WRITES=true") && previewText.includes("\"executed\":false"),
      previewText,
    );
    const moneyPreview = await call(read, "paystack_transactions", {
      action: "charge_authorization",
      confirm: true,
      email: "ada@example.com",
      amount: 15000,
      authorization_code: "AUTH_fixturecode01",
      currency: "GHS",
    });
    const moneyText = textOf(moneyPreview);
    record(
      "money preview names both switches",
      moneyPreview.isError !== true &&
        moneyText.includes("PAYSTACK_ALLOW_MONEY_MOVEMENT=true") &&
        moneyText.includes("PAYSTACK_ALLOW_WRITES=true") &&
        !moneyText.includes("AUTH_fixturecode01"),
      moneyText,
    );
    for (const code of ["401", "403", "404", "422", "429"]) {
      const result = await call(read, "paystack_transactions", { action: "fetch", id: `err-${code}` });
      const body = textOf(result);
      const needle = code === "429" ? "retry after 7s" : `HTTP ${code}`;
      record(`error ${code}`, result.isError === true && body.includes(needle), body);
    }
    const missing = await call(read, "paystack_webhook", {
      action: "verify_signature",
      raw_body: String(fixture.raw),
    });
    record("webhook missing header", textOf(missing).includes("missing_header"), textOf(missing));
    const shortSig = await call(read, "paystack_webhook", {
      action: "verify_signature",
      raw_body: String(fixture.raw),
      signature: "abc",
    });
    record("webhook length mismatch", textOf(shortSig).includes("length_mismatch"), textOf(shortSig));
    const bad = await call(read, "paystack_webhook", {
      action: "verify_signature",
      raw_body: `${fixture.raw} `,
      signature: String(fixture.signature),
    });
    record("webhook tampered body", textOf(bad).includes("mismatch") && !textOf(bad).includes("\"valid\":true"), textOf(bad));
    const wrong = await call(read, "paystack_webhook", {
      action: "verify_signature",
      raw_body: String(fixture.raw),
      signature: createHmac("sha512", "sk_test_wrongfixturekey0001").update(String(fixture.raw), "utf8").digest("hex"),
    });
    record("webhook wrong key", textOf(wrong).includes("\"valid\":false"), textOf(wrong));
    const good = await call(read, "paystack_webhook", {
      action: "verify_signature",
      raw_body: String(fixture.raw),
      signature: String(fixture.signature),
    });
    const goodText = textOf(good);
    record(
      "webhook valid",
      goodText.includes("\"valid\":true") && !goodText.includes(MOCK_KEY),
      goodText,
    );
  } finally {
    await read.close();
  }

  const writes = await open({ writes: true, money: false });
  try {
    const created = await call(writes, "paystack_customers", {
      action: "create",
      confirm: true,
      email: "ada@example.com",
      first_name: "Ada",
    });
    const createdText = textOf(created);
    record(
      "gated write sent",
      created.isError !== true && createdText.includes("\"executed\":true") && createdText.includes("/customer"),
      createdText,
    );
    const held = await call(writes, "paystack_refunds", {
      action: "create",
      confirm: true,
      transaction: "1001",
      amount: 5000,
      currency: "GHS",
    });
    const heldText = textOf(held);
    record(
      "money held without money switch",
      held.isError !== true &&
        heldText.includes("Not sent. Missing PAYSTACK_ALLOW_MONEY_MOVEMENT=true.") &&
        heldText.includes("\"executed\":false") &&
        heldText.includes("\"blocked\":true"),
      heldText,
    );
  } finally {
    await writes.close();
  }

  const money = await open({ writes: true, money: true });
  try {
    const charged = await call(money, "paystack_transactions", {
      action: "charge_authorization",
      confirm: true,
      email: "ada@example.com",
      amount: 15000,
      authorization_code: "AUTH_fixturecode01",
      currency: "GHS",
      reference: "ref_livecheck_1",
    });
    const chargedText = textOf(charged);
    record(
      "money charge sent and masked",
      charged.isError !== true &&
        chargedText.includes("\"executed\":true") &&
        chargedText.includes("******6789") &&
        !chargedText.includes("AUTH_mocksecret01") &&
        !chargedText.includes("0123456789") &&
        !chargedText.includes(MOCK_KEY),
      chargedText,
    );
    const transfer = await call(money, "paystack_transfers", {
      action: "initiate",
      confirm: true,
      source: "balance",
      amount: 2000,
      recipient: "RCP_mock",
      currency: "GHS",
      reference: "ref_transfer_1",
    });
    record(
      "transfer initiate sent",
      transfer.isError !== true && textOf(transfer).includes("\"executed\":true"),
      textOf(transfer),
    );
  } finally {
    await money.close();
  }

  process.stdout.write(`live-check passed=${passed} failed=${failed}\n`);
  if (failed > 0) process.exit(1);
}

main().catch((error) => {
  process.stderr.write(`${redact(error instanceof Error ? error.stack ?? error.message : "live-check failed")}\n`);
  process.exit(1);
});
