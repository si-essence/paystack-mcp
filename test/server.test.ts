import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import { createServer } from "../src/server.js";
import { jsonResponse, KEY, runtimeWith } from "./support.js";

async function session(flags: Record<string, string> = {}): Promise<{
  client: Client;
  calls: { count: number };
}> {
  const calls = { count: 0 };
  const runtime = runtimeWith(flags, () => {
    calls.count += 1;
    return Promise.resolve(
      jsonResponse(200, {
        status: true,
        message: "OK",
        data: [{ currency: "GHS", balance: 250000 }],
      }),
    );
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "paystack-test", version: "0.0.0" });
  await createServer(runtime).connect(serverTransport);
  await client.connect(clientTransport);
  return { client, calls };
}

describe("MCP server", () => {
  it("lists action tools including the local webhook tool", async () => {
    const { client } = await session();
    const listed = await client.listTools();
    const names = listed.tools.map((tool) => tool.name).sort();
    expect(names).toContain("paystack_transactions");
    expect(names).toContain("paystack_webhook");
    expect(names).toHaveLength(12);
    const balance = listed.tools.find((tool) => tool.name === "paystack_balance");
    expect(balance?.annotations?.readOnlyHint).toBe(true);
    const transfers = listed.tools.find((tool) => tool.name === "paystack_transfers");
    expect(transfers?.annotations?.readOnlyHint).toBe(false);
  });

  it("rejects unknown fields through the tool schema", async () => {
    const { client, calls } = await session();
    const result = await client.callTool({
      name: "paystack_transactions",
      arguments: { action: "list", not_a_field: true },
    });
    expect(result.isError).toBe(true);
    const text = JSON.stringify(result.content);
    expect(text).toContain("Unrecognized key");
    expect(text).not.toContain(KEY);
    expect(calls.count).toBe(0);
  });

  it("reads balance and verifies a webhook without echoing the key", async () => {
    const { client } = await session();
    const balance = await client.callTool({
      name: "paystack_balance",
      arguments: { action: "balance" },
    });
    expect(balance.isError).toBeFalsy();
    const balanceText = JSON.stringify(balance.structuredContent ?? balance.content);
    expect(balanceText).toContain("GHS");
    expect(balanceText).not.toContain(KEY);
    const checked = await client.callTool({
      name: "paystack_webhook",
      arguments: { action: "verify_signature", raw_body: "{}", signature: "abc" },
    });
    const checkedText = JSON.stringify(checked.structuredContent ?? checked.content);
    expect(checkedText).toContain("length_mismatch");
    expect(checkedText).not.toContain(KEY);
  });
});
