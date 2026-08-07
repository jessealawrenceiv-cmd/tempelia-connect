/**
 * Client-side action_type guards for READ queries against public.logs.
 *
 * `insertLog` already blocks invalid action_type values on the write path.
 * These helpers close the same gap on the read path: filter values can come
 * from a shared URL, localStorage, or a stale build whose enum drifted from the
 * database, and we would rather fail locally with a readable message than send
 * a request that Postgres rejects (or, worse, that silently returns nothing).
 *
 * Every browser-side `.eq("action_type", ...)` / `.in("action_type", ...)`
 * filter must pass its value through here first.
 */

import { LOG_ACTION_TYPES, type LogActionType } from "./log-action-types.generated";
import { logActionTypeSchema } from "./log-action-types.schema";

/** Message shape is matched by friendlyLogRequestError, so keep "action_type". */
function invalid(values: unknown): Error {
  return new Error(
    `Blocked logs query: invalid action_type ${JSON.stringify(values)}. ` +
      `Allowed values: ${LOG_ACTION_TYPES.join(", ")}`,
  );
}

/** Validates one filter value before it reaches the logs API. */
export function logActionFilterValue(value: unknown): LogActionType {
  const parsed = logActionTypeSchema.safeParse(value);
  if (!parsed.success) throw invalid(value);
  return parsed.data;
}

/**
 * Validates a list filter. Empty lists are rejected because `.in()` with no
 * values matches nothing — callers must skip the filter instead.
 */
export function logActionFilterValues(values: readonly unknown[]): LogActionType[] {
  if (!Array.isArray(values) || values.length === 0) throw invalid(values);
  return values.map((v) => logActionFilterValue(v));
}

/** Non-throwing variant: keeps known values, reports the rest. */
export function pickLogActionTypes(values: readonly unknown[]): {
  valid: LogActionType[];
  invalid: string[];
} {
  const valid: LogActionType[] = [];
  const bad: string[] = [];
  for (const value of values ?? []) {
    const parsed = logActionTypeSchema.safeParse(value);
    if (parsed.success) {
      if (!valid.includes(parsed.data)) valid.push(parsed.data);
    } else {
      const text = typeof value === "string" ? value : String(value);
      if (!bad.includes(text)) bad.push(text);
    }
  }
  return { valid, invalid: bad };
}
