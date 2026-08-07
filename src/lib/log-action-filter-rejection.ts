/**
 * Wire shape for a rejected logs `action_type` filter.
 *
 * The list view and the CSV export must tell the same story: a mixed or unknown
 * action_type filter is rejected on the server with HTTP 400 and a payload the
 * UI can run through `describeLogRequestError` — including the exact
 * `logs_action_type_check` constraint text, the allowed whitelist and the
 * correlation ID.
 *
 * Client-safe on purpose (no server-only imports) so the UI, the server guard
 * and the contract tests all share one definition.
 */

import { LOGS_ACTION_TYPE_CONSTRAINT, LOG_ACTION_TYPES } from "./log-action-types.generated";
import { LOG_REQUEST_ID_PREFIX } from "./log-request-id";

export type LogActionFilterRejection = {
  /** Stable machine code for the guard. */
  error: "invalid_action_type_filter";
  /** Postgres check-constraint code, so client parsing matches the list path. */
  code: "23514";
  status: 400;
  /** Human-readable text containing the constraint name and the whitelist. */
  message: string;
  /** Which values were refused. */
  details: string;
  hint: string;
  endpoint: string;
  rejected: string[];
  allowed: readonly string[];
  requestId: string;
};

export type LogActionFilterRejectionSource = {
  endpoint: string;
  rejected: string[];
  requestId: string;
  allowed?: readonly string[];
};

/** Builds the 400 body shared by every logs endpoint that filters action_type. */
export function logActionFilterRejectionPayload(
  source: LogActionFilterRejectionSource,
): LogActionFilterRejection {
  const allowed = source.allowed ?? LOG_ACTION_TYPES;
  const listed = source.rejected.length > 0 ? source.rejected.join(", ") : "(empty filter)";
  return {
    error: "invalid_action_type_filter",
    code: "23514",
    status: 400,
    message:
      `Request rejected for ${source.endpoint}: value violates check constraint ` +
      `"${LOGS_ACTION_TYPE_CONSTRAINT}". Allowed values: ${allowed.join(", ")}. ` +
      `${LOG_REQUEST_ID_PREFIX}${source.requestId}`,
    details: `Rejected action_type value(s): ${listed}.`,
    hint: `Use one of the allowed record types: ${allowed.join(", ")}.`,
    endpoint: source.endpoint,
    rejected: source.rejected,
    allowed,
    requestId: source.requestId,
  };
}

export function isLogActionFilterRejection(value: unknown): value is LogActionFilterRejection {
  return (
    !!value &&
    typeof value === "object" &&
    (value as Record<string, unknown>)['error'] === "invalid_action_type_filter" &&
    typeof (value as Record<string, unknown>)['message'] === "string"
  );
}
