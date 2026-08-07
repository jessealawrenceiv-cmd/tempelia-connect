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
import {
  logActionTypeSchema,
  logActionTypeFilterSchema,
  logActionTypeListSchema,
  logRowSchema,
  logRowsSchema,
  parseLogActionType,
  safeParseLogActionType,
} from "./log-action-types.schema";

export { LOG_ACTION_TYPES, LogAction };
export {
  logActionTypeSchema,
  logActionTypeFilterSchema,
  logActionTypeListSchema,
  logRowSchema,
  logRowsSchema,
  parseLogActionType,
  safeParseLogActionType,
};
export type { LogActionType };

const ALLOWED = new Set<string>(LOG_ACTION_TYPES);


export function isLogActionType(value: unknown): value is LogActionType {
  return typeof value === "string" && ALLOWED.has(value);
}

/** Throws on anything outside the whitelist. Case- and whitespace-sensitive, like the DB. */
export function assertLogActionType(value: unknown): LogActionType {
  // Single implementation: the Zod enum built from the generated whitelist.
  return parseLogActionType(value);
}

/**
 * Callers MUST pass a value from the generated `LogAction` enum; a bare string
 * (or any value outside the whitelist) is a compile-time error here and is
 * re-checked at runtime by `assertLogActionType` below.
 */
type LogRowInput = { action_type: LogActionType; [key: string]: unknown };

/**
 * Validating insert for public.logs. Accepts a single row or an array and
 * rejects the write locally when any action_type is not whitelisted.
 *
 * This is the ONLY place in the app allowed to call `.from("logs").insert(...)`.
 * `src/lib/log-insert-bypass.test.ts` fails the build if any other module does.
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

type SelectIdBuilder = {
  insert: (rows: never) => {
    select: (cols: "id") => { maybeSingle: () => PromiseLike<{ data: unknown; error: unknown }> };
  };
};

/**
 * Validating insert that returns the new row id — for callers that need the
 * generated log id (e.g. Twilio voicemail callbacks).
 */
export async function insertLogReturningId(
  client: { from: (table: "logs") => SelectIdBuilder },
  row: LogRowInput,
) {
  assertLogActionType(row?.action_type);
  const { data, error } = await client.from("logs").insert(row as never).select("id").maybeSingle();
  const id = (data as { id?: string } | null)?.id ?? null;
  return { id, error };
}


