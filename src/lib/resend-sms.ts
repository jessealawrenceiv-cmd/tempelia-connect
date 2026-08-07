import { LogAction, type LogActionType } from "./log-action-types.generated";

/** Log statuses that mean the message never made it out, or was never confirmed. */
export const RESENDABLE_STATUSES = ["failed", "queued", "accepted", "undelivered", "unconfirmed"];

/** Outbound log action types eligible for a resend. */
export const OUTBOUND_LOG_TYPES: LogActionType[] = [
  LogAction.quote_sms,
  LogAction.review_request,
  LogAction.missed_call_text,
  LogAction.missed_call_autotext,
  LogAction.reactivation_text,
  LogAction.quote_decline_followup,
];
