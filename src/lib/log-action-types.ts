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

import { LOG_ACTION_TYPES, LogAction, type LogActionType } from "./log-action-types.generated";
import { LOG_DEDUPE_CONFLICT_TARGET, hasDedupeKey, logDedupeKey } from "./log-dedupe";
import {
  DEDUPE_COMPARE_SELECT,
  dedupeConflictError,
  diffDedupeRow,
  isDedupeConflictError,
  type DedupeConflictError,
} from "./log-dedupe-conflict";

import {
  logActionTypeSchema,
  LOG_ACTION_TYPE_CONSTRAINT,
  LogActionTypeViolationError,
  logActionTypeViolation,
  checkLogActionType,
  checkLogRowsActionTypes,
  type LogActionTypeViolation,
  logActionTypeFilterSchema,
  logActionTypeListSchema,
  logRowSchema,
  logRowsSchema,
  parseLogActionType,
  safeParseLogActionType,
} from "./log-action-types.schema";

export { LOG_ACTION_TYPES, LogAction };
export { logDedupeKey };
export {
  logActionTypeSchema,
  LOG_ACTION_TYPE_CONSTRAINT,
  LogActionTypeViolationError,
  logActionTypeViolation,
  checkLogActionType,
  checkLogRowsActionTypes,
  logActionTypeFilterSchema,
  logActionTypeListSchema,
  logRowSchema,
  logRowsSchema,
  parseLogActionType,
  safeParseLogActionType,
};
export type { LogActionType, LogActionTypeViolation };

const ALLOWED = new Set<string>(LOG_ACTION_TYPES);

export function isLogActionType(value: unknown): value is LogActionType {
  return typeof value === "string" && ALLOWED.has(value);
}

/** Throws on anything outside the whitelist. Case- and whitespace-sensitive, like the DB. */
export function assertLogActionType(value: unknown): LogActionType {
  const checked = checkLogActionType(value);
  if (!checked.ok) throw new LogActionTypeViolationError(value);
  return checked.value;
}

/**
 * Callers MUST pass a value from the generated `LogAction` enum; a bare string
 * (or any value outside the whitelist) is a compile-time error here and is
 * re-checked at runtime by `assertLogActionType` below.
 *
 * `dedupe_key` is optional and only set by the ingestion path (webhooks). When
 * present, the write becomes idempotent: the partial unique index
 * `logs_user_dedupe_key_unique` guarantees a redelivered event cannot land twice.
 */
export type LogRowInput = {
  action_type: LogActionType;
  dedupe_key?: string | null;
  [key: string]: unknown;
};

/**
 * Client-side pre-validation: rejects any row whose action_type is not in the
 * generated LogAction whitelist. Call this before calling `insertLog` to keep
 * invalid values from ever reaching the logs write API.
 */
export function validateLogInsertActionTypes(
  rows: unknown,
): { ok: true } | { ok: false; error: LogActionTypeViolation } {
  return checkLogRowsActionTypes(rows);
}

// The generated Supabase client types are structural here on purpose: these
// helpers accept both the real client and the lightweight fakes used in tests.
/* eslint-disable @typescript-eslint/no-explicit-any */
type UpsertCapableClient = {
  from: (table: "logs") => {
    upsert?: (rows: any, options?: any) => any;
    select?: (cols: any) => any;
  };
};
/* eslint-enable @typescript-eslint/no-explicit-any */

/**
 * Idempotent write for keyed rows: `ignoreDuplicates` turns a redelivery into a
 * no-op instead of an error, so handlers stay simple and Twilio still gets a 2xx.
 * Falls back to a plain insert when the client fake has no `upsert` (older tests).
 */
function upsertBuilder(client: unknown, rows: LogRowInput | LogRowInput[]) {
  const table = (client as UpsertCapableClient).from("logs");
  if (typeof table.upsert !== "function") return null;
  return table.upsert(rows, {
    onConflict: LOG_DEDUPE_CONFLICT_TARGET,
    ignoreDuplicates: true,
  });
}

/**
 * Validating insert for public.logs. Accepts a single row or an array and
 * rejects the write locally when any action_type is not whitelisted.
 *
 * Rows carrying `dedupe_key` go through an idempotent upsert so repeated event
 * deliveries collapse onto the existing row instead of duplicating it.
 *
 * This is the ONLY place in the app allowed to call `.from("logs").insert(...)`.
 * `src/lib/log-insert-bypass.test.ts` fails the build if any other module does.
 */
export async function insertLog(
  client: { from: (table: "logs") => { insert: (rows: never) => unknown } },
  rows: LogRowInput | LogRowInput[],
) {
  const checked = checkLogRowsActionTypes(rows);
  if (!checked.ok) {
    // Never reaches Postgres: same 23514 shape the DB would return, plus a hint.
    console.error("[logs] blocked insert:", checked.error.message, checked.error.hint);
    return { error: checked.error };
  }
  const list = Array.isArray(rows) ? rows : [rows];
  if (list.some(hasDedupeKey)) {
    // A redelivery with a different payload is a real problem, not a duplicate:
    // refuse it loudly instead of letting ignoreDuplicates discard it.
    const conflict = await checkDedupeConflicts(client, rows);
    if (conflict) return { error: conflict };
    const builder = upsertBuilder(client, rows);
    if (builder) return (await builder) as { error: { message: string } | null };
  }

  return (await client.from("logs").insert(rows as never)) as { error: { message: string } | null };
}

type SelectIdBuilder = {
  insert: (rows: never) => {
    select: (cols: "id") => { maybeSingle: () => PromiseLike<{ data: unknown; error: unknown }> };
  };
};

/**
 * Load the row already stored under this (user_id, dedupe_key) so the caller can
 * compare payloads and resolve the original log id.
 */
async function fetchDedupeRow(
  client: unknown,
  row: LogRowInput,
): Promise<Record<string, unknown> | null> {
  const table = (client as UpsertCapableClient).from("logs");
  if (typeof table.select !== "function") return null;
  try {
    const { data } = await table
      .select(DEDUPE_COMPARE_SELECT)
      .eq("user_id", row["user_id"])
      .eq("dedupe_key", row.dedupe_key)
      .maybeSingle();
    return (data as Record<string, unknown> | null) ?? null;
  } catch (e) {
    console.error("[logs] dedupe lookup failed", (e as Error).message);
    return null;
  }
}

/** Original log id for a redelivery that collided with an existing row. */
async function findDedupedId(client: unknown, row: LogRowInput): Promise<string | null> {
  const existing = await fetchDedupeRow(client, row);
  return (existing?.["id"] as string | undefined) ?? null;
}

/**
 * Best-effort audit trail for a refused write. Never throws and never changes the
 * outcome: the conflict error is returned to the caller either way.
 */
async function recordDedupeConflict(client: unknown, row: LogRowInput, error: DedupeConflictError) {
  try {
    const table = (client as { from?: (t: string) => { insert?: (r: unknown) => unknown } }).from?.(
      "log_write_rejections",
    );
    if (!table || typeof table.insert !== "function") return;
    await table.insert({
      user_id: (row["user_id"] as string | undefined) ?? null,
      rejected_action_type: row.action_type,
      rejected_action_types: [row.action_type],
      blocked_at: "dedupe_conflict_guard",
      error_code: error.code,
      error_message: `${error.message} (${error.details})`,
      attempted_row: row as unknown as Record<string, unknown>,
      correlation_id: error.dedupe_key,
    });
  } catch (e) {
    console.error("[logs] failed to record dedupe conflict", (e as Error).message);
  }
}

/**
 * Pre-flight guard: refuse a keyed write whose payload disagrees with the row
 * already stored under the same dedupe key, instead of letting the idempotent
 * upsert swallow it. Returns the first conflict found, or null when every keyed
 * row is either new or a faithful redelivery.
 */
export async function checkDedupeConflicts(
  client: unknown,
  rows: LogRowInput | LogRowInput[],
): Promise<DedupeConflictError | null> {
  const list = (Array.isArray(rows) ? rows : [rows]).filter(hasDedupeKey);
  for (const row of list) {
    const existing = await fetchDedupeRow(client, row);
    if (!existing) continue;
    const conflicts = diffDedupeRow(existing, row as Record<string, unknown>);
    if (conflicts.length === 0) continue;
    const error = dedupeConflictError(
      String(row.dedupe_key),
      (existing["id"] as string | undefined) ?? null,
      conflicts,
    );
    console.error("[logs] dedupe conflict:", error.message, error.details);
    await recordDedupeConflict(client, row, error);
    return error;
  }
  return null;
}

/**
 * Validating insert that returns the new row id — for callers that need the
 * generated log id (e.g. Twilio voicemail callbacks).
 *
 * With a `dedupe_key`, a redelivery returns the id of the row written by the
 * first delivery rather than creating a second one — unless its payload
 * conflicts, in which case the write is refused with a dedupe conflict error.
 */
export async function insertLogReturningId(
  client: { from: (table: "logs") => SelectIdBuilder },
  row: LogRowInput,
) {
  const checked = checkLogRowsActionTypes(row);
  if (!checked.ok) {
    console.error("[logs] blocked insert:", checked.error.message, checked.error.hint);
    return { id: null, error: checked.error };
  }
  if (hasDedupeKey(row)) {
    const conflict = await checkDedupeConflicts(client, row);
    if (conflict) return { id: conflict.existing_log_id, error: conflict };
    const builder = upsertBuilder(client, row);
    if (builder) {
      const { data, error } = await builder.select("id").maybeSingle();
      const id = (data as { id?: string } | null)?.id ?? null;
      // ignoreDuplicates returns no row for a collision — resolve the original.
      if (!id && !error) return { id: await findDedupedId(client, row), error: null };
      return { id, error };
    }
  }
  const { data, error } = await client
    .from("logs")
    .insert(row as never)
    .select("id")
    .maybeSingle();
  const id = (data as { id?: string } | null)?.id ?? null;
  return { id, error };
}


