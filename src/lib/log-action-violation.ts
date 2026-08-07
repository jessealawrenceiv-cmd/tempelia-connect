/**
 * User-facing presentation for `logs_action_type_check` rejections.
 *
 * Both paths produce the same shape:
 *  - client-side pre-validation (see `validateLogInsertActionTypes`), and
 *  - a real Postgres 23514 error when a write somehow reaches the database.
 *
 * `describeLogActionTypeViolation` normalizes either one into copy we can put
 * in a toast or an inline alert, including the allowed action_type hints.
 */
import { toast } from "sonner";

import {
  LOG_ACTION_TYPE_CONSTRAINT,
  LOG_ACTION_TYPES,
} from "@/lib/log-action-types.generated";

export type LogActionTypeViolationDisplay = {
  /** Short headline for a toast title or alert heading. */
  title: string;
  /** One-sentence explanation naming the rejected value. */
  description: string;
  /** The rejected action_type, when we can determine it. */
  rejected: string | null;
  /** Full allowed list, straight from the generated LogAction values. */
  allowed: readonly string[];
  /** Ready-to-render hint line listing the allowed values. */
  hint: string;
  /** Raw database/technical message, for the "technical details" disclosure. */
  technical: string;
};

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/**
 * Returns display copy when `error` is a logs_action_type_check violation,
 * or `null` for any unrelated error (caller should fall back to generic copy).
 */
export function describeLogActionTypeViolation(
  error: unknown,
): LogActionTypeViolationDisplay | null {
  if (!error || typeof error !== "object") return null;
  const e = error as Record<string, unknown>;
  const message = text(e["message"]);
  const constraint = text(e["constraint"]);
  const code = text(e["code"]);
  const details = text(e["details"]);

  const isViolation =
    constraint === LOG_ACTION_TYPE_CONSTRAINT ||
    message.includes(LOG_ACTION_TYPE_CONSTRAINT) ||
    details.includes(LOG_ACTION_TYPE_CONSTRAINT) ||
    (code === "23514" && (message + details).includes("action_type"));
  if (!isViolation) return null;

  const rejected =
    text(e["rejectedActionType"]) ||
    (/action_type\s+"?([^"\s]+)"?/i.exec(message + " " + details)?.[1] ?? "") ||
    "";

  const hint = `Allowed action_type values: ${LOG_ACTION_TYPES.join(", ")}.`;

  return {
    title: "Activity log write rejected",
    description: rejected
      ? `“${rejected}” is not an allowed action_type, so nothing was written to the activity log.`
      : "That action_type is not allowed, so nothing was written to the activity log.",
    rejected: rejected || null,
    allowed: LOG_ACTION_TYPES,
    hint,
    technical: message || `${LOG_ACTION_TYPE_CONSTRAINT} violation (23514)`,
  };
}

/**
 * Shows a toast when `error` is a logs_action_type_check violation.
 * Returns true when a violation toast was shown.
 */
export function toastLogActionTypeViolation(error: unknown): boolean {
  const display = describeLogActionTypeViolation(error);
  if (!display) return false;
  toast.error(display.title, {
    description: `${display.description} ${display.hint}`,
    duration: 12_000,
  });
  return true;
}
