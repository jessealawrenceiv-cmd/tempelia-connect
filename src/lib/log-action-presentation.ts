/**
 * Presentation metadata for every allowed `logs.action_type`.
 *
 * Keyed by the generated `LogAction` enum, and typed as an exhaustive
 * `Record<LogActionType, ...>` so adding a value to the database CHECK
 * constraint (and regenerating the enum) forces a label + color here at
 * compile time. UI code must read from this map rather than hard-coding
 * action_type string literals.
 */
import { LogAction, LOG_ACTION_TYPES, type LogActionType } from "@/lib/log-action-types";

export type LogActionPresentation = {
  /** Radio-log style label rendered in the Activity list and filter chips. */
  label: string;
  /** Plain-language description used for tooltips. */
  description: string;
  /** Tailwind background class for the status dot (semantic tokens only). */
  dot: string;
  /** Recently added types get a NEW marker in the filter row. */
  isNew?: true;
};

export const LOG_ACTION_PRESENTATION: Record<LogActionType, LogActionPresentation> = {
  [LogAction.missed_call_text]: {
    label: "MISSED_CALL_TEXT",
    description: "Auto-text sent after a missed call",
    dot: "bg-orange",
  },
  [LogAction.missed_call_autotext]: {
    label: "MISSED_CALL_AUTOTEXT",
    description: "Missed-call auto-text delivery attempt",
    dot: "bg-orange",
  },
  [LogAction.missed_call_excluded]: {
    label: "MISSED_CALL_EXCLUDED",
    description: "Missed call from an excluded number — no text sent",
    dot: "bg-muted-foreground",
  },
  [LogAction.voicemail_notify]: {
    label: "VOICEMAIL",
    description: "Voicemail recorded and owner notified",
    dot: "bg-steel",
  },
  [LogAction.review_request]: {
    label: "REVIEW_REQUEST",
    description: "Review request text sent",
    dot: "bg-steel",
  },
  [LogAction.reactivation_text]: {
    label: "WIN_BACK_TEXT",
    description: "Win Back message sent to a past customer",
    dot: "bg-moss",
  },
  [LogAction.customer_email_updated]: {
    label: "CONTACT_UPDATED",
    description: "Contact email address updated",
    dot: "bg-muted-foreground",
  },
  [LogAction.quote_sms]: {
    label: "QUOTE_SMS",
    description: "Quote link texted to a customer",
    dot: "bg-primary",
  },
  [LogAction.quote_decline_followup]: {
    label: "DECLINE_FOLLOWUP",
    description: "Follow-up sent after a declined quote",
    dot: "bg-orange",
  },
  [LogAction.quote_decline_reason_captured]: {
    label: "DECLINE_REASON",
    description: "Customer gave a reason for declining",
    dot: "bg-orange",
  },
  [LogAction.sms_inbound]: {
    label: "SMS_INBOUND",
    description: "Inbound text received from a customer",
    dot: "bg-moss",
  },
  [LogAction.customer_consent_preserved]: {
    label: "CONSENT_PRESERVED",
    description: "Existing texting consent kept during an update or import",
    dot: "bg-moss",
  },
  [LogAction.quote_deposit_status]: {
    label: "DEPOSIT_STATUS",
    description: "Deposit requirement or payment status changed",
    dot: "bg-primary",
  },
  [LogAction.status_refresh]: {
    label: "STATUS_REFRESH",
    description: "Automation status re-evaluation attempt",
    dot: "bg-orange",
    isNew: true,
  },
  [LogAction.automation_status_change]: {
    label: "STATUS_CHANGE",
    description: "ACTIVE automation status changed",
    dot: "bg-primary",
    isNew: true,
  },
  [LogAction.invoice_balance_status]: {
    label: "INVOICE_BALANCE",
    description: "Invoice balance marked received or adjusted",
    dot: "bg-primary",
  },
  [LogAction.invoice_sms]: {
    label: "INVOICE_SMS",
    description: "Invoice link texted to a customer",
    dot: "bg-primary",
  },
  [LogAction.opt_in_prompt]: {
    label: "OPT_IN_PROMPT",
    description: "Texting opt-in prompt sent to a contact",
    dot: "bg-steel",
  },
  [LogAction.opt_in_prompt_test]: {
    label: "OPT_IN_PROMPT_TEST",
    description: "Test opt-in prompt sent to your own number",
    dot: "bg-muted-foreground",
  },
  [LogAction.number_provisioned]: {
    label: "NUMBER_PROVISIONED",
    description: "Business texting number provisioned",
    dot: "bg-moss",
  },
};

/** Label for any action_type string, falling back safely for unknown values. */
export function logActionLabel(actionType: string): string {
  return LOG_ACTION_PRESENTATION[actionType as LogActionType]?.label ?? actionType.toUpperCase();
}

/** Dot color class for any action_type string. */
export function logActionDot(actionType: string): string {
  return LOG_ACTION_PRESENTATION[actionType as LogActionType]?.dot ?? "bg-muted";
}

/** Tooltip text for any action_type string. */
export function logActionDescription(actionType: string): string {
  return LOG_ACTION_PRESENTATION[actionType as LogActionType]?.description ?? "Activity record";
}

export function isNewLogAction(actionType: string): boolean {
  return LOG_ACTION_PRESENTATION[actionType as LogActionType]?.isNew === true;
}

/** Filter-row ordering: generated whitelist order, newest types first. */
export const LOG_ACTION_FILTER_ORDER: readonly LogActionType[] = [
  ...LOG_ACTION_TYPES.filter((t) => isNewLogAction(t)),
  ...LOG_ACTION_TYPES.filter((t) => !isNewLogAction(t)),
];
