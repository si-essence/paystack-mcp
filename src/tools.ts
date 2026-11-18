import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z, type ZodObject, type ZodRawShape } from "zod";
import type { ToolDescription, ToolName } from "./brand.js";
import { ConnectorError, errorPrefix } from "./errors.js";
import type { Logger } from "./log.js";
import {
  asSecretScope,
  createSecretScope,
  GENERIC_UPSTREAM,
  MIN_SUBSTRING_SECRET,
  redact,
  redactRecord,
  runWithSecretScope,
  textContainsAnySecret,
  type SecretScope,
} from "./redact.js";

export interface ToolAnnotations {
  readOnlyHint: boolean;
  destructiveHint: boolean;
  openWorldHint: boolean;
  idempotentHint?: boolean;
}

export const READ_ONLY_REMOTE: ToolAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  openWorldHint: true,
};

export const WRITE_DESTRUCTIVE: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: true,
  openWorldHint: true,
  idempotentHint: false,
};

export interface ToolContext {
  secrets: readonly string[];
  logger: Logger;
}

export interface ToolSpec<Shape extends ZodRawShape> {
  name: ToolName;
  description: ToolDescription;
  inputSchema: ZodObject<Shape>;
  annotations: ToolAnnotations;
  handler: (args: z.output<ZodObject<Shape>>) => Promise<Record<string, unknown>>;
}

export function assertToolSpec(spec: {
  name: string;
  description: string;
  inputSchema: unknown;
}): void {
  if (!/^[a-z][a-z0-9_]{0,63}$/.test(spec.name)) {
    throw new ConnectorError("config", "Tool name must match ^[a-z][a-z0-9_]{0,63}$.");
  }
  if (spec.description.trim().length === 0) {
    throw new ConnectorError("config", `Tool ${spec.name} must have a non-empty description.`);
  }
  if (!(spec.inputSchema instanceof z.ZodObject)) {
    throw new ConnectorError("config", `Tool ${spec.name} must declare a Zod object schema.`);
  }
}

export function registerConnectorTool<Shape extends ZodRawShape>(
  server: McpServer,
  spec: ToolSpec<Shape>,
  ctx: ToolContext,
): void {
  assertToolSpec(spec);
  const annotations = toAnnotations(spec.annotations);
  server.registerTool<z.ZodRawShape, typeof spec.inputSchema>(
    spec.name,
    {
      description: spec.description,
      inputSchema: spec.inputSchema,
      annotations,
    },
    async (args): Promise<CallToolResult> => {
      const scope = createSecretScope(ctx.secrets, args);
      return runWithSecretScope(scope, async () => {
        try {
          const parsed = spec.inputSchema.parse(args);
          const raw = await spec.handler(parsed);
          const shownOnce = takeShownOnce(raw);
          const result = redactRecord(raw, scope);
          if (shownOnce !== undefined) {
            result["secret"] = shownOnce;
            const nested = result["result"];
            if (nested !== null && typeof nested === "object" && !Array.isArray(nested)) {
              (nested as Record<string, unknown>)["secret"] = shownOnce;
            }
          }
          return {
            content: [{ type: "text", text: JSON.stringify(result) }],
            structuredContent: result,
            isError: false,
          };
        } catch (error) {
          const text = toPublicMessage(error, scope);
          ctx.logger.error(`tool ${spec.name} failed: ${text}`);
          return {
            isError: true,
            content: [{ type: "text", text }],
          };
        }
      });
    },
  );
}

export function toPublicMessage(error: unknown, secrets: SecretScope | readonly string[]): string {
  const scope = asSecretScope(secrets);
  if (error instanceof ConnectorError) {
    return safeMessage(`${errorPrefix(error.code)}${error.message}`, scope);
  }
  if (error instanceof z.ZodError) {
    const fields = error.issues
      .map((issue) => (issue.path.length === 0 ? issue.code : issue.path.map(String).join(".")))
      .join(", ");
    return safeMessage(`[input] Invalid input (${fields}).`, scope);
  }
  if (error instanceof Error) {
    return safeMessage(`[upstream] ${error.message}`, scope);
  }
  return "[upstream] Unexpected error.";
}

function safeMessage(text: string, scope: SecretScope): string {
  const short = scope.all.filter(
    (secret) => secret.length > 0 && secret.length < MIN_SUBSTRING_SECRET,
  );
  if (scope.hasShort && textContainsAnySecret(text, short)) {
    const prefixMatch = text.match(/^(\[[a-z-]+\] )/);
    const prefix = prefixMatch?.[1] ?? "";
    return `${prefix}${GENERIC_UPSTREAM}`;
  }
  return redact(text, scope.maskable);
}

function takeShownOnce(value: Record<string, unknown>): string | undefined {
  const nested =
    value["result"] !== null &&
    typeof value["result"] === "object" &&
    !Array.isArray(value["result"])
      ? (value["result"] as Record<string, unknown>)
      : undefined;
  const holder =
    value["__reveal"] === true
      ? value
      : nested !== undefined && nested["__reveal"] === true
        ? nested
        : undefined;
  if (holder === undefined) return undefined;
  delete value["__reveal"];
  if (nested !== undefined) delete nested["__reveal"];
  const secret = holder["secret"];
  return typeof secret === "string" && secret.length > 0 ? secret : undefined;
}

function toAnnotations(annotations: ToolAnnotations): ToolAnnotations {
  const out: ToolAnnotations = {
    readOnlyHint: annotations.readOnlyHint,
    destructiveHint: annotations.destructiveHint,
    openWorldHint: annotations.openWorldHint,
  };
  if (annotations.idempotentHint !== undefined) {
    out.idempotentHint = annotations.idempotentHint;
  }
  return out;
}
