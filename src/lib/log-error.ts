/**
 * Client-side handling for logs.action_type CHECK failures.
 *
 * App code validates action_type before inserting (see insertLog), so a
 * Postgres 23514 / logs_action_type_check error means the whitelist in the
 * database and the whitelist in the app have drifted apart. When that happens
 * the user should see a clear message that names the rejected value instead of
 * a raw Postgres string.
 */
import { toast } from "sonner";
import { LOG_ACTION_TYPES } from "./log-action-types.generated";

export const LOGS_ACTION_TYPE_CONSTRAINT = "logs_action_type_check";
export const CHECK_VIOLATION_CODE = "23514";

type MaybePostgrestError = {
  code?: string | null;
  message?: string | null;
  details?: string | null;
  hint?: string | null;
};

function asError(error: unknown): MaybePostgrestError | null {
  return error && typeof error === "object" ? (error as MaybePostgrestError) : null;
}

/** True when the given error is the logs.action_type CHECK constraint violation. */
export function isLogActionTypeCheckViolation(error: unknown): boolean {
  const e = asError(error);
  if (!e) return false;
  const message = e.message ?? "";
  return e.code === CHECK_VIOLATION_CODE && message.includes(LOGS_ACTION_TYPE_CONSTRAINT);
}

const ALLOWED = new Set<string>(LOG_ACTION_TYPES);

/**
 * Best-effort recovery of the offending value from the Postgres "Failing row
 * contains (...)" details: the rejected action_type is the only snake_case-ish
 * token in the row that is not part of the current whitelist.
 */
export function extractRejectedActionType(error: unknown, attempted?: string | null): string | null {
  if (attempted != null && attempted !== "") return attempted;
  const details = asError(error)?.details ?? "";
  const inner = details.match(/^Failing row contains \((.*)\)\.?$/s)?.[1];
  if (!inner) return null;
  for (const raw of inner.split(",")) {
    const token = raw.trim();
    if (!token || token === "null" || ALLOWED.has(token)) continue;
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(token)) continue; // uuid
    if (/^\d{4}-\d{2}-\d{2}/.test(token)) continue; // timestamp
    if (/^[a-z][a-z0-9]*(?:[_ ][a-z0-9]+)*$/i.test(token)) return token;
  }
  return null;
}

/** Human-readable message for the constraint failure, naming the rejected value. */
export function describeLogActionTypeError(error: unknown, attempted?: string | null): string {
  const rejected = extractRejectedActionType(error, attempted);
  const shown = rejected === "" ? "(empty)" : rejected;
  return shown
    ? `The activity log rejected the record type “${shown}”. It isn’t an allowed type, so nothing was recorded.`
    : "The activity log rejected that record type. It isn’t an allowed type, so nothing was recorded.";
}

/**
 * Shows a clear toast for a failed log write. Returns true when the failure was
 * the action_type whitelist violation, so callers can branch if needed.
 */
export function reportLogInsertError(
  error: unknown,
  options: { attempted?: string | null; context?: string } = {},
): boolean {
  const { attempted, context } = options;
  if (isLogActionTypeCheckViolation(error)) {
    toast.error("Couldn’t record that activity", {
      description: `${describeLogActionTypeError(error, attempted)}${
        context ? ` (${context})` : ""
      } Everything else you did was saved.`,
    });
    return true;
  }
  // Locally-rejected values never reach the database; surface them the same way.
  const message = asError(error)?.message ?? (error instanceof Error ? error.message : "");
  if (attempted && /action_type|invalid enum|Invalid option/i.test(message)) {
    toast.error("Couldn’t record that activity", {
      description: describeLogActionTypeError(error, attempted),
    });
    return true;
  }
  toast.error("Couldn’t record that activity", {
    description: message || "Please try again.",
  });
  return false;
}
