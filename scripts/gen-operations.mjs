#!/usr/bin/env node
/**
 * Emit src/operations.ts and paystack.routes.json from spec/api-inventory.json.
 * The inventory is hand-written (method, path, purpose, risk). This script does
 * not fetch Paystack and does not invent routes.
 *
 *   node scripts/gen-operations.mjs
 *   node scripts/gen-operations.mjs --check
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const specPath = join(root, "spec", "api-inventory.json");
const routesPath = join(root, "paystack.routes.json");
const outPath = join(root, "src", "operations.ts");

const WRITE_NOTE =
  "Requires confirm:true and PAYSTACK_ALLOW_WRITES=true. Otherwise this is a dry-run preview and no request is sent.";
const MONEY_NOTE =
  "Requires confirm:true, PAYSTACK_ALLOW_WRITES=true, and PAYSTACK_ALLOW_MONEY_MOVEMENT=true. Otherwise this is a dry-run preview and no request is sent. Amounts are positive integers in subunits (kobo, pesewas, or cents).";

function loadInventory() {
  const inventory = JSON.parse(readFileSync(specPath, "utf8"));
  if (!Array.isArray(inventory.routes) || !Array.isArray(inventory.excluded)) {
    throw new Error("Inventory must have routes and excluded arrays.");
  }
  return inventory;
}

function pathParams(path) {
  const names = [];
  for (const match of path.matchAll(/\{([^}]+)\}/g)) {
    const name = match[1];
    if (name !== undefined) names.push(name);
  }
  return names;
}

function fieldsOf(route) {
  const fields = [];
  for (const name of pathParams(route.path)) {
    fields.push({ name, type: "string", required: true, in: "path" });
  }
  for (const field of route.query ?? []) {
    fields.push({
      name: field.name,
      type: field.type ?? "string",
      required: field.required === true,
      in: "query",
    });
  }
  for (const field of route.body ?? []) {
    fields.push({
      name: field.name,
      type: field.type ?? "string",
      required: field.required === true,
      in: "body",
    });
  }
  return fields;
}

function warningsFor(route) {
  const warnings = [];
  if (route.risk === "write") warnings.push(`${route.purpose} ${WRITE_NOTE}`);
  if (route.risk === "money") warnings.push(`${route.purpose} ${MONEY_NOTE}`);
  if (Array.isArray(route.notes)) warnings.push(...route.notes);
  return warnings;
}

function planOperations(inventory) {
  const seen = new Set();
  const actions = new Set();
  const rows = [];
  for (const route of inventory.routes) {
    const key = `${route.method} ${route.path}`;
    if (seen.has(key)) throw new Error(`Duplicate route ${key}`);
    seen.add(key);
    const actionKey = `${route.tool} ${route.action}`;
    if (actions.has(actionKey)) throw new Error(`Duplicate action ${actionKey}`);
    actions.add(actionKey);
    if (!["read", "write", "money"].includes(route.risk)) {
      throw new Error(`Bad risk on ${key}`);
    }
    if (route.risk === "read" && route.method !== "GET" && route.lookup !== true) {
      throw new Error(`Read route ${key} must be GET or lookup:true`);
    }
    if (route.risk === "read" && route.method === "GET" && route.lookup === true) {
      throw new Error(`GET route ${key} does not need lookup:true`);
    }
    if ((route.risk === "write" || route.risk === "money") && route.method === "GET") {
      throw new Error(`GET cannot be ${route.risk}: ${key}`);
    }
    if (route.risk === "money" && route.money !== true) {
      throw new Error(`Money route ${key} must set money:true so the money check is explicit.`);
    }
    if (route.risk !== "money" && route.money === true) {
      throw new Error(`Non-money route ${key} must not set money:true`);
    }
    if (typeof route.purpose !== "string" || route.purpose.trim().length < 12) {
      throw new Error(`Purpose too short on ${key}`);
    }
    const fields = fieldsOf(route);
    rows.push({
      method: route.method,
      path: route.path,
      routeId: route.operationId,
      operationId: route.operationId,
      tool: route.tool,
      action: route.action,
      risk: route.risk,
      write: route.risk !== "read",
      money: route.risk === "money",
      summary: route.purpose,
      pathParams: pathParams(route.path),
      queryParams: fields.filter((field) => field.in === "query").map((field) => field.name),
      fields,
      warnings: warningsFor(route),
    });
  }
  for (const excluded of inventory.excluded) {
    const key = `${excluded.method} ${excluded.path}`;
    if (seen.has(key)) throw new Error(`Excluded route is also mapped: ${key}`);
    if (typeof excluded.reason !== "string" || excluded.reason.length < 12) {
      throw new Error(`Exclusion reason too short for ${key}`);
    }
  }
  return rows;
}

function tsString(value) {
  return JSON.stringify(value);
}

function emitField(field) {
  return `{ name: ${tsString(field.name)}, type: ${tsString(field.type)}, required: ${field.required}, in: ${tsString(field.in)} }`;
}

function emitRow(row) {
  const factory = row.risk === "money" ? "moneyRow" : row.risk === "write" ? "writeRow" : "readRow";
  return `  ${factory}(${tsString(row.method)}, ${tsString(row.path)}, ${tsString(row.tool)}, {
    action: ${tsString(row.action)},
    routeId: ${tsString(row.routeId)},
    operationId: ${tsString(row.operationId)},
    summary: ${tsString(row.summary)},
    pathParams: ${tsString(row.pathParams)},
    queryParams: ${tsString(row.queryParams)},
    fields: [${row.fields.map(emitField).join(", ")}],
    warnings: ${tsString(row.warnings)},
  })`;
}

function emitExclusions(excluded) {
  return excluded
    .map(
      (item) => `  {
    method: ${tsString(item.method)},
    path: ${tsString(item.path)},
    operationId: ${tsString(item.operationId)},
    reason: ${tsString(item.reason)},
  }`,
    )
    .join(",\n");
}

function emitOperations(rows, excluded, version) {
  return `/** Generated by scripts/gen-operations.mjs from spec/api-inventory.json. Do not edit by hand. */

import { ConnectorError } from "./errors.js";

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
export type Risk = "read" | "write" | "money";

/** Present only on money operations. A money op cannot be built without it. */
export type MoneyCheck = {
  readonly moneyGate: "PAYSTACK_ALLOW_MONEY_MOVEMENT";
};

export interface FieldSchema {
  readonly name: string;
  readonly type: string;
  readonly required: boolean;
  readonly in: "path" | "query" | "body";
}

interface OpCommon {
  readonly method: HttpMethod;
  readonly path: string;
  readonly routeId: string;
  readonly tool: string;
  readonly action: string;
  readonly operationId: string;
  readonly summary: string;
  readonly pathParams: readonly string[];
  readonly queryParams: readonly string[];
  readonly fields: readonly FieldSchema[];
  readonly warnings: readonly string[];
}

export interface ReadOperation extends OpCommon {
  readonly risk: "read";
  readonly write: false;
  readonly money: false;
}

export interface WriteOperation extends OpCommon {
  readonly risk: "write";
  readonly write: true;
  readonly money: false;
}

export interface MoneyOperation extends OpCommon, MoneyCheck {
  readonly risk: "money";
  readonly write: true;
  readonly money: true;
}

export type Operation = ReadOperation | WriteOperation | MoneyOperation;

export interface ExcludedOperation {
  readonly method: HttpMethod;
  readonly path: string;
  readonly operationId: string;
  readonly reason: string;
}

interface RowOptions {
  readonly action: string;
  readonly routeId: string;
  readonly operationId: string;
  readonly summary: string;
  readonly pathParams: readonly string[];
  readonly queryParams: readonly string[];
  readonly fields: readonly FieldSchema[];
  readonly warnings: readonly string[];
}

function readRow(method: HttpMethod, path: string, tool: string, options: RowOptions): ReadOperation {
  return {
    method,
    path,
    tool,
    action: options.action,
    routeId: options.routeId,
    operationId: options.operationId,
    risk: "read",
    write: false,
    money: false,
    summary: options.summary,
    pathParams: options.pathParams,
    queryParams: options.queryParams,
    fields: options.fields,
    warnings: options.warnings,
  };
}

function writeRow(method: HttpMethod, path: string, tool: string, options: RowOptions): WriteOperation {
  return {
    method,
    path,
    tool,
    action: options.action,
    routeId: options.routeId,
    operationId: options.operationId,
    risk: "write",
    write: true,
    money: false,
    summary: options.summary,
    pathParams: options.pathParams,
    queryParams: options.queryParams,
    fields: options.fields,
    warnings: options.warnings,
  };
}

function moneyRow(method: HttpMethod, path: string, tool: string, options: RowOptions): MoneyOperation {
  return {
    method,
    path,
    tool,
    action: options.action,
    routeId: options.routeId,
    operationId: options.operationId,
    risk: "money",
    write: true,
    money: true,
    moneyGate: "PAYSTACK_ALLOW_MONEY_MOVEMENT",
    summary: options.summary,
    pathParams: options.pathParams,
    queryParams: options.queryParams,
    fields: options.fields,
    warnings: options.warnings,
  };
}

/**
 * Runtime gate. The parameter is wider than MoneyOperation so a forged object
 * without the money-check brand still typechecks at the call of this function
 * and fails here. MoneyOperation itself cannot be constructed without the brand.
 */
export function requireMoneyCheck(operation: {
  readonly tool: string;
  readonly action: string;
  readonly money: boolean;
  readonly moneyGate?: string;
}): void {
  if (!operation.money || operation.moneyGate !== "PAYSTACK_ALLOW_MONEY_MOVEMENT") {
    throw new ConnectorError(
      "config",
      \`Money operation \${operation.tool}.\${operation.action} is missing the money check.\`,
    );
  }
}

export function registerOperation(operation: Operation): Operation {
  if (operation.risk === "money") requireMoneyCheck(operation);
  return operation;
}

export const SOURCE_VERSION = ${tsString(version)};

export const OPERATIONS: readonly Operation[] = [
${rows.map(emitRow).join(",\n")},
].map(registerOperation);

export const EXCLUSIONS: readonly ExcludedOperation[] = [
${emitExclusions(excluded)},
];

export function toolNames(): string[] {
  return [...new Set(OPERATIONS.map((operation) => operation.tool))].sort();
}

export function operationsForTool(name: string): Operation[] {
  return OPERATIONS.filter((operation) => operation.tool === name);
}

export function toolHasWrite(name: string): boolean {
  return OPERATIONS.some((operation) => operation.tool === name && operation.write);
}

export function requireOp(tool: string, action: string): Operation {
  const found = OPERATIONS.find((operation) => operation.tool === tool && operation.action === action);
  if (found === undefined) {
    throw new ConnectorError("input", \`Unknown Paystack operation \${tool} \${action}.\`);
  }
  return found;
}
`;
}

function catalog(inventory, rows) {
  return {
    source: {
      project: inventory.project,
      version: inventory.version,
      license: inventory.license,
      reference: inventory.reference,
      extractor: inventory.extractor,
    },
    counts: {
      mapped: rows.length,
      excluded: inventory.excluded.length,
      read: rows.filter((row) => row.risk === "read").length,
      write: rows.filter((row) => row.risk === "write").length,
      money: rows.filter((row) => row.risk === "money").length,
    },
    operations: inventory.routes.map((route) => ({
      method: route.method,
      path: route.path,
      operationId: route.operationId,
      tool: route.tool,
      action: route.action,
      risk: route.risk,
      purpose: route.purpose,
      exclude: false,
    })),
    excluded: inventory.excluded.map((route) => ({
      method: route.method,
      path: route.path,
      operationId: route.operationId,
      exclude: true,
      reason: route.reason,
    })),
  };
}

function main() {
  const check = process.argv.includes("--check");
  const inventory = loadInventory();
  const rows = planOperations(inventory);
  const operationsText = emitOperations(rows, inventory.excluded, inventory.version);
  const catalogJson = `${JSON.stringify(catalog(inventory, rows), null, 2)}\n`;
  const summary = `${rows.length} mapped, ${inventory.excluded.length} excluded, read ${rows.filter((row) => row.risk === "read").length}, write ${rows.filter((row) => row.risk === "write").length}, money ${rows.filter((row) => row.risk === "money").length}\n`;
  if (check) {
    const currentOps = readFileSync(outPath, "utf8");
    const currentRoutes = readFileSync(routesPath, "utf8");
    if (currentOps !== operationsText || currentRoutes !== catalogJson) {
      throw new Error(
        "Generated operations are stale. Run node scripts/gen-operations.mjs and commit the result.",
      );
    }
    process.stderr.write(summary);
    return;
  }
  writeFileSync(outPath, operationsText);
  writeFileSync(routesPath, catalogJson);
  process.stderr.write(summary);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  try {
    main();
  } catch (error) {
    const message = error instanceof Error ? error.message : "generator failed";
    process.stderr.write(`${message}\n`);
    process.exit(1);
  }
}
