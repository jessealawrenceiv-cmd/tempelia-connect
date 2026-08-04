/** Log statuses that mean the message never made it out, or was never confirmed. */
export const RESENDABLE_STATUSES = ["failed", "queued", "accepted", "undelivered", "unconfirmed"];

/** Outbound log action types eligible for a resend. */
export const OUTBOUND_LOG_TYPES = [
  "quote_sms",
  "review_request",
  "missed_call_text",
  "missed_call_autotext",
  "reactivation_text",
  "quote_decline_followup",
];
