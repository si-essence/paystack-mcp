import { ConnectorError } from "./errors.js";
import type { QueryMap, QueryValue } from "./http.js";
import { definedBody, definedQuery, fillPath } from "./json.js";
import { requireOp, type HttpMethod, type Operation } from "./operations.js";
import { currentSecretScope, type SecretScope } from "./redact.js";
import type { Runtime } from "./runtime.js";
import { jsonValueSchema } from "./schemas.js";
import { sanitizePayload } from "./sanitize.js";
import { moneyPermission, withGatedWrite, type WritePlan } from "./write-gate.js";

function requirePresent(value: unknown, label: string): unknown {
  if (value === undefined) {
    throw new ConnectorError("input", `${label} is required for this action.`);
  }
  return value;
}

function pathParamsOf(operation: Operation, args: Record<string, unknown>): Record<string, string> {
  const params: Record<string, string> = {};
  for (const name of operation.pathParams) {
    const value = requirePresent(args[name], name);
    if (typeof value !== "string" || value.length === 0) {
      throw new ConnectorError("input", `${name} is required for this action.`);
    }
    params[name] = value;
  }
  return params;
}

function queryOf(operation: Operation, args: Record<string, unknown>): QueryMap | undefined {
  const record: Record<string, QueryValue | undefined> = {};
  for (const field of operation.fields) {
    if (field.in !== "query") continue;
    const value = args[field.name];
    if (field.required) requirePresent(value, field.name);
    if (value === undefined) continue;
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      record[field.name] = value;
      continue;
    }
    throw new ConnectorError("input", `${field.name} must be a string, number, or boolean.`);
  }
  return definedQuery(record);
}

function bodyOf(operation: Operation, args: Record<string, unknown>): unknown {
  if (!operation.fields.some((field) => field.in === "body")) return undefined;
  const record: Record<string, unknown> = {};
  for (const field of operation.fields) {
    if (field.in !== "body") continue;
    const value = args[field.name];
    if (field.required) requirePresent(value, field.name);
    if (value === undefined) continue;
    record[field.name] = value;
  }
  return definedBody(record);
}

function planFor(operation: Operation, path: string, body: unknown, query: QueryMap | undefined): WritePlan {
  if (operation.method === "GET") {
    throw new ConnectorError("config", "Write plan cannot use GET.");
  }
  return {
    method: operation.method,
    path,
    query,
    body,
    summary: operation.summary,
    warnings: operation.warnings,
  };
}

async function send(
  runtime: Runtime,
  method: HttpMethod,
  path: string,
  query: QueryMap | undefined,
  body: unknown,
): Promise<unknown> {
  if (method === "GET") {
    return runtime.client.getJson({ path, query, ttlSec: runtime.cacheTtlSec }, jsonValueSchema);
  }
  const request = { path, query, body };
  if (method === "POST") return runtime.client.postJson(request, jsonValueSchema);
  if (method === "PUT") return runtime.client.putJson(request, jsonValueSchema);
  return runtime.client.deleteJson(request, jsonValueSchema);
}

function present(operation: Operation, payload: unknown, scope: SecretScope): Record<string, unknown> {
  return sanitizePayload(payload, scope, operation.warnings);
}

export async function dispatch(
  runtime: Runtime,
  tool: string,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const action = args["action"];
  if (typeof action !== "string") {
    throw new ConnectorError("input", "action is required.");
  }
  const operation = requireOp(tool, action);
  const path = fillPath(operation.path, pathParamsOf(operation, args));
  const query = queryOf(operation, args);
  const body = bodyOf(operation, args);
  const scope = currentSecretScope(runtime.scope);
  if (operation.risk === "read") {
    const result = await send(runtime, operation.method, path, query, body);
    return present(operation, result, scope);
  }
  const confirm = args["confirm"];
  const plan = planFor(operation, path, body, query);
  return withGatedWrite(
    runtime,
    operation,
    confirm === true ? true : undefined,
    operation.risk === "money" ? moneyPermission(runtime.config.allowMoney) : undefined,
    plan,
    async () => {
      const result = await send(runtime, operation.method, plan.path, query, body);
      return present(operation, result, scope);
    },
  );
}
