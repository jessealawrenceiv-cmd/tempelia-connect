/**
 * AUTO-GENERATED — DO NOT EDIT BY HAND.
 *
 * Source: public.logs constraint `logs_action_type_check` (CHECK whitelist).
 * Regenerate with: `node scripts/generate-log-action-types.mjs`
 *
 * Any change must start as a database migration; the generator then mirrors the
 * constraint's allowed values into this file.
 */

export const LOGS_ACTION_TYPE_CONSTRAINT = "logs_action_type_check";

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
  "opt_in_prompt",
  "opt_in_prompt_test",
  "number_provisioned",
  "webhook_delivery_status",
] as const;

export type LogActionType = (typeof LOG_ACTION_TYPES)[number];

/** Enum-style lookup so call sites can use `LogAction.status_refresh` instead of a raw string. */
export const LogAction = Object.freeze(
  Object.fromEntries(LOG_ACTION_TYPES.map((v) => [v, v])) as {
    readonly [K in LogActionType]: K;
  },
);
