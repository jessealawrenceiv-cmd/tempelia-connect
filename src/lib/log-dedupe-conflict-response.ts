/**
 * Consistent conflict responses for refused Activity-log writes.
 *
 * `checkDedupeConflicts` (src/lib/log-action-types.ts) refuses a keyed write
 * whose payload disagrees with the row already stored under the same
 * `dedupe_key`. That refusal has to reach the caller in a *predictable* shape,
 * whatever the surface: a Twilio webhook, a JSON API route, or a server
 * function. Otherwise a real integrity problem shows up as a silent success on
 * one endpoint and an opaque 500 on the next.
 *
 * Every surface therefore reports the same thing:
 *
 *   - HTTP 409 Conflict — the request is well-formed and authenticated; it is
 *     the *content* that disagrees with stored state. Never 500 (that reads as
 *     "retry me", and a conflicting payload can never succeed on retry) and
 *     never 200 (that would hide the lost row).
 *   - `X-Temaro-Log-Conflict: dedupe_key` plus the differing field names in
 *     `X-Temaro-Log-Conflict-Fields`, readable even when the body is TwiML.
 *   - A body that names the dedupe key, the surviving log row, and for each
 *     differing field its stored and incoming value.
 */

import {
  DEDUPE_CONFLICT_CODE,
  formatDedupeConflicts,
  isDedupeConflictError,
  type DedupeConflictError,
  type DedupeFieldConflict,
} from "./log-dedupe-conflict";

/** Conflict, not a server error: a retry with the same payload cannot succeed. */
export const DEDUPE_CONFLICT_STATUS = 409;

export const DEDUPE_CONFLICT_HEADER = "X-Temaro-Log-Conflict";
export const DEDUPE_CONFLICT_FIELDS_HEADER = "X-Temaro-Log-Conflict-Fields";
export const DEDUPE_CONFLICT_LOG_HEADER = "X-Temaro-Log-Conflict-Log-Id";

/** Stable JSON envelope, identical on every endpoint that can hit this. */
export type DedupeConflictBody = {
  ok: false;
  error: {
    code: typeof DEDUPE_CONFLICT_CODE;
    status: typeof DEDUPE_CONFLICT_STATUS;
    message: string;
    hint: string;
    details: string;
    dedupe_key: string;
    /** The row that stayed authoritative — nothing was overwritten. */
    existing_log_id: string | null;
    /** Field names only, for quick logging/alerting. */
    conflict_fields: string[];
    /** Per-field stored vs incoming values. */
    conflicts: { field: string; stored: unknown; incoming: unknown }[];
    retryable: false;
  };
};

/** Narrow an unknown thrown value / `{ error }` result to a dedupe conflict. */
export function asDedupeConflict(value: unknown): DedupeConflictError | null {
  if (isDedupeConflictError(value)) return value;
  if (typeof value === "object" && value !== null) {
    const nested = (value as { error?: unknown }).error;
    if (isDedupeConflictError(nested)) return nested;
    const cause = (value as { cause?: unknown }).cause;
    if (isDedupeConflictError(cause)) return cause;
  }
  return null;
}

export function conflictFieldNames(conflicts: DedupeFieldConflict[]): string[] {
  return conflicts.map((c) => c.field);
}

export function dedupeConflictBody(error: DedupeConflictError): DedupeConflictBody {
  return {
    ok: false,
    error: {
      code: DEDUPE_CONFLICT_CODE,
      status: DEDUPE_CONFLICT_STATUS,
      message: error.message,
      hint: error.hint,
      details: error.details || formatDedupeConflicts(error.conflicts),
      dedupe_key: error.dedupe_key,
      existing_log_id: error.existing_log_id,
      conflict_fields: conflictFieldNames(error.conflicts),
      conflicts: error.conflicts.map((c) => ({
        field: c.field,
        stored: c.existing ?? null,
        incoming: c.incoming ?? null,
      })),
      retryable: false,
    },
  };
}

export function dedupeConflictHeaders(error: DedupeConflictError): Record<string, string> {
  const headers: Record<string, string> = {
    [DEDUPE_CONFLICT_HEADER]: DEDUPE_CONFLICT_CODE,
    [DEDUPE_CONFLICT_FIELDS_HEADER]: conflictFieldNames(error.conflicts).join(","),
  };
  if (error.existing_log_id) headers[DEDUPE_CONFLICT_LOG_HEADER] = error.existing_log_id;
  return headers;
}

/** One-line human summary reused by TwiML/plain-text bodies and server logs. */
export function dedupeConflictSummary(error: DedupeConflictError): string {
  return `${error.message} Differing fields — ${error.details || formatDedupeConflicts(error.conflicts)}`;
}

/**
 * The response body format a surface can actually consume:
 *  - `json`  — API routes and fetch callers
 *  - `twiml` — Twilio voice/SMS webhooks (XML only; details go in headers and
 *              an XML comment so they survive Twilio's debugger)
 *  - `text`  — Twilio status callbacks and other plain-text webhooks
 */
export type DedupeConflictFormat = "json" | "twiml" | "text";

function xmlCommentSafe(s: string): string {
  return s.replace(/--+/g, "-").replace(/>/g, "&gt;").replace(/</g, "&lt;");
}

export function dedupeConflictResponse(
  error: DedupeConflictError,
  format: DedupeConflictFormat = "json",
): Response {
  const headers = dedupeConflictHeaders(error);
  if (format === "json") {
    return new Response(JSON.stringify(dedupeConflictBody(error)), {
      status: DEDUPE_CONFLICT_STATUS,
      headers: { ...headers, "Content-Type": "application/json" },
    });
  }
  if (format === "twiml") {
    const xml =
      `<?xml version="1.0" encoding="UTF-8"?>` +
      `<Response><!-- ${xmlCommentSafe(dedupeConflictSummary(error))} --></Response>`;
    return new Response(xml, {
      status: DEDUPE_CONFLICT_STATUS,
      headers: { ...headers, "Content-Type": "text/xml" },
    });
  }
  return new Response(dedupeConflictSummary(error), {
    status: DEDUPE_CONFLICT_STATUS,
    headers: { ...headers, "Content-Type": "text/plain" },
  });
}

/**
 * Server-function equivalent of the 409: server functions signal failure by
 * throwing, so carry the same code, field list, and hint on the thrown error.
 */
export class LogDedupeConflictError extends Error {
  readonly code = DEDUPE_CONFLICT_CODE;
  readonly status = DEDUPE_CONFLICT_STATUS;
  readonly retryable = false;
  readonly hint: string;
  readonly details: string;
  readonly dedupeKey: string;
  readonly existingLogId: string | null;
  readonly conflicts: DedupeFieldConflict[];
  readonly conflictFields: string[];

  constructor(error: DedupeConflictError) {
    super(dedupeConflictSummary(error));
    this.name = "LogDedupeConflictError";
    this.hint = error.hint;
    this.details = error.details;
    this.dedupeKey = error.dedupe_key;
    this.existingLogId = error.existing_log_id;
    this.conflicts = error.conflicts;
    this.conflictFields = conflictFieldNames(error.conflicts);
  }

  toJSON(): DedupeConflictBody["error"] {
    return dedupeConflictBody({
      code: DEDUPE_CONFLICT_CODE,
      message: this.message,
      hint: this.hint,
      details: this.details,
      dedupe_key: this.dedupeKey,
      existing_log_id: this.existingLogId,
      conflicts: this.conflicts,
    }).error;
  }
}

/**
 * Re-raise a refused log write from a server function. Pass the `{ error }`
 * result of `insertLog` / `insertLogReturningId`; non-conflict errors (and
 * successes) are left alone so callers keep their existing behaviour.
 */
export function throwOnDedupeConflict(result: unknown): void {
  const conflict = asDedupeConflict(result);
  if (conflict) throw new LogDedupeConflictError(conflict);
}
