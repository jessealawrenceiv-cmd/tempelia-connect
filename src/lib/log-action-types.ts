/**
 * Single source of truth for public.logs.action_type.
 *
 * The database keeps an explicit CHECK whitelist (logs_action_type_check); this
 * module mirrors it so server code validates the value BEFORE any insert is
 * attempted, instead of relying on a Postgres 23514 error after the fact.
 *
 * Keep this list byte-identical to the database constraint. Adding a value here
 * without a migration (or vice-versa) is a bug.
 */

export const LOG_ACTION_TYPES = [
  "missed_call_text",
  "missed_call_autotext",
  "missed_call_excluded",
  "voicemail_notify",
  "review_request",
  "reactivation_text",
  "customer_email_updated",
  "quote_sms",
  "quote_decline_followup",
  "quote_decline_reason_captured",
  "sms_inbound",
  "customer_consent_preserved",
  "quote_deposit_status",
  "status_refresh",
  "automation_status_change",
  "invoice_balance_status",
  "invoice_sms",
] as const;

export type LogActionType = (typeof LOG_ACTION_TYPES)[number];

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
 */
export async function insertLog<
  TClient extends {
    from: (table: "logs") => { insert: (rows: unknown) => Promise<{ error: unknown }> };
  },
>(client: TClient, rows: LogRowInput | LogRowInput[]) {
  for (const row of Array.isArray(rows) ? rows : [rows]) {
    assertLogActionType(row?.action_type);
  }
  return client.from("logs").insert(rows);
}
