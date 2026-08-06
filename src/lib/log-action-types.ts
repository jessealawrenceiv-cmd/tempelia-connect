/**
 * Single source of truth for public.logs.action_type.
 *
 * The allowed values are GENERATED from the database CHECK constraint
 * (logs_action_type_check) into ./log-action-types.generated.ts by
 * `node scripts/generate-log-action-types.mjs`. Never hand-edit that list: add
 * values with a migration first, then regenerate.
 *
 * This module wraps the generated enum with validation helpers so server code
 * rejects arbitrary strings BEFORE any insert is attempted, instead of relying
 * on a Postgres 23514 error after the fact.
 */

import {
  LOG_ACTION_TYPES,
  LogAction,
  type LogActionType,
} from "./log-action-types.generated";

export { LOG_ACTION_TYPES, LogAction };
export type { LogActionType };

const ALLOWED = new Set<string>(LOG_ACTION_TYPES);


export function isLogActionType(value: unknown): value is LogActionType {
  return typeof value === "string" && ALLOWED.has(value);
}

/** Throws on anything outside the whitelist. Case- and whitespace-sensitive, like the DB. */
export function assertLogActionType(value: unknown): LogActionType {
  if (!isLogActionType(value)) {
    throw new Error(
      `Invalid logs.action_type ${JSON.stringify(value)}. Allowed values: ${LOG_ACTION_TYPES.join(", ")}`,
    );
  }
  return value;
}

type LogRowInput = { action_type: string; [key: string]: unknown };

/**
 * Validating insert for public.logs. Accepts a single row or an array and
 * rejects the write locally when any action_type is not whitelisted.
 */
export async function insertLog(
  client: { from: (table: "logs") => { insert: (rows: never) => unknown } },
  rows: LogRowInput | LogRowInput[],
) {
  for (const row of Array.isArray(rows) ? rows : [rows]) {
    assertLogActionType(row?.action_type);
  }
  return (await client.from("logs").insert(rows as never)) as { error: { message: string } | null };
}

