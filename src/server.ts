import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { toolDescription, toolName } from "./brand.js";
import { CONNECTOR_NAME, CONNECTOR_TITLE, CONNECTOR_VERSION } from "./constants.js";
import { inputSchemaFor } from "./fields.js";
import { dispatch } from "./handlers.js";
import { operationsForTool, toolHasWrite, toolNames } from "./operations.js";
import type { Runtime } from "./runtime.js";
import { handleWebhook, webhookInput } from "./webhook.js";
import {
  READ_ONLY_REMOTE,
  WRITE_DESTRUCTIVE,
  registerConnectorTool,
  type ToolAnnotations,
  type ToolContext,
} from "./tools.js";

const LOCAL_WEBHOOK: ToolAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  openWorldHint: false,
  idempotentHint: true,
};

export function createServer(runtime: Runtime): McpServer {
  const server = new McpServer({
    name: CONNECTOR_NAME,
    title: CONNECTOR_TITLE,
    version: CONNECTOR_VERSION,
  });
  const ctx: ToolContext = { secrets: runtime.secrets, logger: runtime.logger };
  for (const name of toolNames()) {
    registerConnectorTool(
      server,
      {
        name: toolName(name),
        description: toolDescription(describe(name)),
        inputSchema: inputSchemaFor(name),
        annotations: toolHasWrite(name) ? WRITE_DESTRUCTIVE : READ_ONLY_REMOTE,
        handler: (args) => {
          const record: Record<string, unknown> = {};
          for (const [key, value] of Object.entries(args)) record[key] = value;
          return dispatch(runtime, name, record);
        },
      },
      ctx,
    );
  }
  registerConnectorTool(
    server,
    {
      name: toolName("paystack_webhook"),
      description: toolDescription(
        "Verify an x-paystack-signature header locally. HMAC-SHA512 of the raw body with the configured secret key, compared in constant time. No network call. The key is never returned.",
      ),
      inputSchema: webhookInput,
      annotations: LOCAL_WEBHOOK,
      handler: (args) => Promise.resolve(handleWebhook(args, runtime.config.secret)),
    },
    ctx,
  );
  return server;
}

function describe(name: string): string {
  const actions = operationsForTool(name)
    .map((operation) => `${operation.action} (${operation.risk})`)
    .join(", ");
  const gate = toolHasWrite(name)
    ? " Writes need confirm:true and PAYSTACK_ALLOW_WRITES=true. Money actions also need PAYSTACK_ALLOW_MONEY_MOVEMENT=true. Otherwise this is a preview and no request is sent."
    : " Read-only.";
  return `${name}. Actions: ${actions}.${gate} Amounts are positive integers in subunits.`;
}
