/**
 * Conflicting-redelivery guard for the Activity log ingestion path.
 *
 * `dedupe_key` makes a redelivery idempotent: the partial unique index
 * `logs_user_dedupe_key_unique` collapses the second write onto the first row.
 * That is correct only when the redelivery carries the SAME payload. A provider
 * (or a bug in our own key composition) can also send the same key with
 * *different* content — a different customer, a different message body, a
 * different Twilio SID. Silently ignoring that write, or upserting over the
 * stored row, would quietly destroy or misattribute an audit entry.
 *
 * So before a keyed row is written we compare it against the row already stored
 * under that key. Matching payload -> idempotent no-op, as before. Conflicting
 * payload -> the write is refused with an explicit error naming every field that
 * disagrees, and the attempt is recorded in public.log_write_rejections so an
 * operator can see it instead of having to notice a missing row.
 */

/**
 * Payload fields that identify what an Activity log row means. Two rows sharing
 * a dedupe key must agree on all of them. Deliberately excludes bookkeeping
 * columns (id, created_at) and correlation fields that legitimately get filled
 * in later by a follow-up callback.
 */
export const DEDUPE_COMPARED_FIELDS = [
  "user_id",
  "customer_id",
  "action_type",
  "status",
  "message_sent",
  "twilio_message_sid",
  "recipient_phone",
  "call_sid",
  "recording_sid",
  "voicemail_url",
  "prompt_template_hash",
] as const;

export type DedupeComparedField = (typeof DEDUPE_COMPARED_FIELDS)[number];

/** Columns to select when loading the stored row for comparison. */
export const DEDUPE_COMPARE_SELECT = ["id", ...DEDUPE_COMPARED_FIELDS].join(",");

export type DedupeFieldConflict = {
  field: string;
  existing: unknown;
  incoming: unknown;
};

/** Error code kept distinct from Postgres 23514 (action_type) and 23505 (unique). */
export const DEDUPE_CONFLICT_CODE = "dedupe_key_conflict";

export type DedupeConflictError = {
  code: typeof DEDUPE_CONFLICT_CODE;
  message: string;
  hint: string;
  details: string;
  dedupe_key: string;
  existing_log_id: string | null;
  conflicts: DedupeFieldConflict[];
};

/**
 * Normalize before comparing so cosmetic provider differences do not read as a
 * conflict: null/undefined/"" all mean "absent", strings are trimmed, and
 * numbers/booleans compare by their string form (Postgres returns text).
 */
function normalize(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed === "" ? null : trimmed;
  }
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/**
 * Compare an incoming keyed row against the stored row under the same dedupe
 * key. Only fields the incoming row actually supplies are compared: a callback
 * that omits a column is not claiming it changed.
 */
export function diffDedupeRow(
  existing: Record<string, unknown> | null | undefined,
  incoming: Record<string, unknown>,
): DedupeFieldConflict[] {
  if (!existing) return [];
  const conflicts: DedupeFieldConflict[] = [];
  for (const field of DEDUPE_COMPARED_FIELDS) {
    if (!(field in incoming)) continue;
    if (incoming[field] === undefined) continue;
    const a = normalize(existing[field]);
    const b = normalize(incoming[field]);
    // An incoming row that fills in a value the stored row left empty is an
    // enrichment, not a conflict.
    if (a === null && b !== null) continue;
    if (a !== b) conflicts.push({ field, existing: existing[field] ?? null, incoming: incoming[field] ?? null });
  }
  return conflicts;
}

/** Short "field: existing -> incoming" list used in the error message. */
export function formatDedupeConflicts(conflicts: DedupeFieldConflict[]): string {
  return conflicts
    .map((c) => `${c.field}: stored=${JSON.stringify(c.existing ?? null)} incoming=${JSON.stringify(c.incoming ?? null)}`)
    .join("; ");
}

export function dedupeConflictError(
  dedupeKey: string,
  existingLogId: string | null,
  conflicts: DedupeFieldConflict[],
): DedupeConflictError {
  const fields = conflicts.map((c) => c.field).join(", ");
  return {
    code: DEDUPE_CONFLICT_CODE,
    message:
      `Refusing to write an activity log row: dedupe_key "${dedupeKey}" already exists ` +
      `with different values for ${fields}. The stored row was left untouched.`,
    hint:
      "A redelivery must carry the same payload as the original event. Differing content means " +
      "the dedupe key is not specific enough (add a discriminator) or two distinct events collided.",
    details: formatDedupeConflicts(conflicts),
    dedupe_key: dedupeKey,
    existing_log_id: existingLogId,
    conflicts,
  };
}

export function isDedupeConflictError(value: unknown): value is DedupeConflictError {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { code?: unknown }).code === DEDUPE_CONFLICT_CODE
  );
}
