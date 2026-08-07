/**
 * Zod schemas for public.logs, built from the GENERATED action_type whitelist.
 *
 * Use these at every API boundary that can receive an action_type from outside
 * the app (server functions, server routes/webhooks, MCP tools). They reject
 * arbitrary strings with a readable error before any query or insert runs.
 */

import { z } from "zod";
import { LOG_ACTION_TYPES, type LogActionType } from "./log-action-types.generated";

/** A single allowed logs.action_type value. */
export const logActionTypeSchema = z.enum(LOG_ACTION_TYPES);

/** Optional filter form: undefined means "no action_type filter". */
export const logActionTypeFilterSchema = logActionTypeSchema.optional();

/** A non-empty list of allowed action types (for `.in(...)` style filters). */
export const logActionTypeListSchema = z.array(logActionTypeSchema).min(1);

/** Shape of an incoming log-write request. Unknown extra keys are stripped. */
export const logRowSchema = z.object({
  action_type: logActionTypeSchema,
  status: z.string().max(64).optional(),
  message_sent: z.string().max(2000).nullable().optional(),
  customer_id: z.string().uuid().nullable().optional(),
  recipient_phone: z.string().max(32).nullable().optional(),
  twilio_message_sid: z.string().max(64).nullable().optional(),
});

export const logRowsSchema = z.union([logRowSchema, z.array(logRowSchema).min(1)]);

export type LogActionTypeInput = z.infer<typeof logActionTypeSchema>;

/** Parse-or-throw helper with the allowed values spelled out in the message. */
export function parseLogActionType(value: unknown): LogActionType {
  const result = logActionTypeSchema.safeParse(value);
  if (!result.success) {
    throw new Error(
      `Invalid logs.action_type ${JSON.stringify(value)}. Allowed values: ${LOG_ACTION_TYPES.join(", ")}`,
    );
  }
  return result.data;
}

/** Non-throwing variant for boundaries that prefer returning an error payload. */
export function safeParseLogActionType(value: unknown) {
  const result = logActionTypeSchema.safeParse(value);
  return result.success
    ? ({ ok: true as const, value: result.data })
    : ({
        ok: false as const,
        error: `Invalid action_type ${JSON.stringify(value)}. Allowed values: ${LOG_ACTION_TYPES.join(", ")}`,
      });
}

/* ------------------------------------------------------------------ *
 * Response-side schemas
 *
 * Reads are validated too: a row whose action_type is not in the
 * generated whitelist never reaches client code. Unknown values are
 * dropped and reported so drift is visible instead of silently typed
 * as `string`.
 * ------------------------------------------------------------------ */

/** A log row as returned by the API: action_type narrowed to the enum. */
export const logResponseRowSchema = z
  .object({ action_type: logActionTypeSchema })
  .passthrough();

export type LogResponseRow<T> = Omit<T, "action_type"> & { action_type: LogActionType };

export type ParsedLogRowsResult<T> = {
  /** Rows whose action_type is a known LogAction value. */
  rows: LogResponseRow<T>[];
  /** Distinct unknown action_type values that were dropped. */
  unknownActionTypes: string[];
  /** Number of rows dropped because of an unknown action_type. */
  droppedCount: number;
};

/**
 * Narrows an API result set so `action_type` is a LogActionType everywhere.
 * Rows carrying an unrecognised action_type are excluded from `rows`.
 */
export function parseLogRowsResponse<T extends { action_type: unknown }>(
  rows: readonly T[] | null | undefined,
): ParsedLogRowsResult<T> {
  const kept: LogResponseRow<T>[] = [];
  const unknown = new Set<string>();
  let dropped = 0;

  for (const row of rows ?? []) {
    if (logActionTypeSchema.safeParse(row.action_type).success) {
      kept.push(row as LogResponseRow<T>);
    } else {
      dropped += 1;
      unknown.add(typeof row.action_type === "string" ? row.action_type : String(row.action_type));
    }
  }

  return { rows: kept, unknownActionTypes: [...unknown], droppedCount: dropped };
}

/** Strict variant for boundaries that must fail loudly rather than drop rows. */
export function parseLogRowsResponseStrict<T extends { action_type: unknown }>(
  rows: readonly T[] | null | undefined,
): LogResponseRow<T>[] {
  const result = parseLogRowsResponse(rows);
  if (result.droppedCount > 0) {
    throw new Error(
      `Unknown logs.action_type value(s) in API response: ${result.unknownActionTypes.join(", ")}. ` +
        `Allowed values: ${LOG_ACTION_TYPES.join(", ")}`,
    );
  }
  return result.rows;
}
