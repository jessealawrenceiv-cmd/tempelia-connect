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
    select: (cols: "id") => { maybeSingle: () => Promise<{ data: { id: string } | null; error: unknown }> };
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
  return { id: data?.id ?? null, error };
}


