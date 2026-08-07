/**
 * Dedupe keys for Activity log rows written by the ingestion path.
 *
 * Providers (Twilio) deliver the same webhook more than once: slow responses,
 * non-2xx replies, dropped connections, and at-least-once retries all replay a
 * payload we may already have processed. `claimWebhookDelivery` catches most of
 * that at the handler door, but it can fail open (claim bookkeeping error) or
 * race across concurrent workers.
 *
 * A dedupe key makes the write itself idempotent: it is stored on the row and
 * backed by the partial unique index `logs_user_dedupe_key_unique`
 * (user_id, dedupe_key). A redelivery therefore cannot create a second row —
 * the storage layer refuses it, regardless of what happened upstream.
 *
 * Rows without a natural provider id pass `undefined` and keep inserting freely.
 */

/** Max length kept well under any index limit while staying human-readable in the DB. */
const MAX_KEY_LENGTH = 200;

/**
 * Compose a dedupe key from the provider delivery key, the action_type, and an
 * optional discriminator for handlers that write several rows for one delivery
 * (e.g. an inbound SMS that logs both `sms_inbound` and a consent change).
 *
 * Returns undefined when there is no stable provider id, which means "do not
 * dedupe this row" rather than "dedupe against an empty key".
 */
export function logDedupeKey(
  deliveryKey: string | null | undefined,
  actionType: string,
  discriminator?: string | null,
): string | undefined {
  const base = (deliveryKey ?? "").trim();
  if (!base) return undefined;
  const parts = [base, actionType];
  const extra = (discriminator ?? "").trim();
  if (extra) parts.push(extra);
  return parts.join("|").slice(0, MAX_KEY_LENGTH);
}

/** True when a row carries a usable dedupe key. */
export function hasDedupeKey(row: { dedupe_key?: unknown }): boolean {
  return typeof row.dedupe_key === "string" && row.dedupe_key.trim().length > 0;
}

/** Postgres conflict target matching the partial unique index on public.logs. */
export const LOG_DEDUPE_CONFLICT_TARGET = "user_id,dedupe_key";
