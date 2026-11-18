import { z, type ZodObject, type ZodRawShape, type ZodType } from "zod";
import { CURRENCIES } from "./constants.js";
import { ConnectorError } from "./errors.js";
import { operationsForTool, toolNames, type FieldSchema } from "./operations.js";
import { jsonDocumentSchema } from "./schemas.js";
import { fixedError } from "./zod-messages.js";

const invalid = fixedError("invalid");

const cache = new Map<string, ZodObject<ZodRawShape>>();

function fieldSchema(type: string): ZodType {
  switch (type) {
    case "string":
      return z.string({ error: invalid }).min(1, { error: invalid }).max(4000, { error: invalid });
    case "page":
      return z.number({ error: invalid }).int({ error: invalid }).min(1, { error: invalid }).max(200, { error: invalid });
    case "integer":
      return z.number({ error: invalid }).int({ error: invalid }).min(0, { error: invalid }).max(1_000_000, { error: invalid });
    case "subunit":
      return z
        .number({ error: invalid })
        .int({ error: invalid })
        .min(1, { error: invalid })
        .max(100_000_000_000, { error: invalid });
    case "boolean":
      return z.boolean({ error: invalid });
    case "currency":
      return z.enum(CURRENCIES, { error: invalid });
    case "risk_action":
      return z.enum(["allow", "deny"], { error: invalid });
    case "resolution":
      return z.enum(["merchant-accepted", "declined"], { error: invalid });
    case "source":
      return z.enum(["balance"], { error: invalid });
    case "json":
      return jsonDocumentSchema;
    default:
      throw new ConnectorError("config", `Unknown field type ${type}.`);
  }
}

export function inputSchemaFor(tool: string): ZodObject<ZodRawShape> {
  const cached = cache.get(tool);
  if (cached !== undefined) return cached;
  const operations = operationsForTool(tool);
  if (operations.length === 0) {
    throw new ConnectorError("config", `No operations for ${tool}.`);
  }
  const actions = operations.map((operation) => operation.action);
  const first = actions[0];
  if (first === undefined) {
    throw new ConnectorError("config", `No actions for ${tool}.`);
  }
  const shape: Record<string, ZodType> = {
    action: z.enum([first, ...actions.slice(1)], { error: invalid }),
    confirm: z.boolean({ error: invalid }).optional(),
  };
  const seen = new Map<string, string>();
  for (const operation of operations) {
    for (const field of operation.fields) {
      const previous = seen.get(field.name);
      if (previous !== undefined && previous !== field.type) {
        throw new ConnectorError("config", `Field ${field.name} has two types on ${tool}.`);
      }
      if (previous === undefined) {
        seen.set(field.name, field.type);
        shape[field.name] = fieldSchema(field.type).optional();
      }
    }
  }
  const schema = z.object(shape).strict();
  cache.set(tool, schema);
  return schema;
}

export function schemas(): ReadonlyMap<string, ZodObject<ZodRawShape>> {
  for (const name of toolNames()) inputSchemaFor(name);
  return cache;
}

export function fieldNames(fields: readonly FieldSchema[]): string[] {
  return fields.map((field) => field.name);
}
