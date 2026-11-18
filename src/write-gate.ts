import type { QueryMap } from "./http.js";
import { requireMoneyCheck, type MoneyOperation, type WriteOperation } from "./operations.js";
import {
  asSecretScope,
  createSecretScope,
  currentSecretScope,
  redact,
  redactUnknown,
  type SecretScope,
} from "./redact.js";
import type { Runtime } from "./runtime.js";
import { ConnectorError } from "./errors.js";

export interface MoneyPermission {
  readonly allowMoneyMovement: true;
}

export function moneyPermission(allowed: boolean): MoneyPermission | undefined {
  if (!allowed) return undefined;
  return { allowMoneyMovement: true };
}

export interface WritePlan {
  readonly method: "POST" | "PUT" | "PATCH" | "DELETE";
  readonly path: string;
  readonly query: QueryMap | undefined;
  readonly body: unknown;
  readonly summary: string;
  readonly warnings: readonly string[];
}

export type GatedOperation = WriteOperation | MoneyOperation;

export function missingRequirements(
  operation: GatedOperation,
  confirm: boolean | undefined,
  allowWrites: boolean,
  permission: MoneyPermission | undefined,
): string[] {
  const missing: string[] = [];
  if (confirm !== true) missing.push("confirm:true");
  if (!allowWrites) missing.push("PAYSTACK_ALLOW_WRITES=true");
  if (operation.risk === "money" && permission?.allowMoneyMovement !== true) {
    missing.push("PAYSTACK_ALLOW_MONEY_MOVEMENT=true");
  }
  return missing;
}

export function previewWrite(
  plan: WritePlan,
  blocked: boolean,
  reason: string,
  secrets: SecretScope | readonly string[],
): Record<string, unknown> {
  const scope = createSecretScope(asSecretScope(secrets).all, plan.body, plan.query);
  const payload: Record<string, unknown> = {
    executed: false,
    dry_run: true,
    blocked,
    method: plan.method,
    path: redact(plan.path, scope.maskable),
    summary: plan.summary,
    reason,
    warnings: [...plan.warnings],
  };
  if (plan.query !== undefined) payload["query"] = redactUnknown(plan.query, scope);
  if (plan.body !== undefined) payload["body"] = redactUnknown(plan.body, scope);
  return payload;
}

export function decideWrite(
  operation: GatedOperation,
  confirm: boolean | undefined,
  allowWrites: boolean,
  permission: MoneyPermission | undefined,
  plan: WritePlan,
  secrets: SecretScope | readonly string[],
): { kind: "preview"; payload: Record<string, unknown> } | { kind: "execute" } {
  const missing = missingRequirements(operation, confirm, allowWrites, permission);
  if (missing.length > 0) {
    const blocked = missing.some((item) => item !== "confirm:true");
    return {
      kind: "preview",
      payload: previewWrite(plan, blocked, `Not sent. Missing ${missing.join(", ")}.`, secrets),
    };
  }
  return { kind: "execute" };
}

export async function withGatedWrite(
  runtime: Runtime,
  operation: GatedOperation,
  confirm: boolean | undefined,
  permission: MoneyPermission | undefined,
  plan: WritePlan,
  run: () => Promise<Record<string, unknown>>,
): Promise<Record<string, unknown>> {
  const scope = currentSecretScope(runtime.scope);
  const decision = decideWrite(
    operation,
    confirm,
    runtime.config.allowWrites,
    permission,
    plan,
    scope,
  );
  if (decision.kind === "preview") return decision.payload;
  if (operation.risk === "money") {
    requireMoneyCheck(operation);
    if (permission?.allowMoneyMovement !== true) {
      throw new ConnectorError("config", "Money movement was blocked.");
    }
  }
  const result = await run();
  return {
    executed: true,
    dry_run: false,
    blocked: false,
    warnings: [...plan.warnings],
    result,
  };
}
