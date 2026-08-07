/**
 * Per-business coverage analysis for `logs.action_type`.
 *
 * `logs_action_type_check` allows a fixed whitelist of action types, but a given
 * business will only ever produce a subset of them: features can be switched
 * off, a phone number may not be provisioned, no quotes may have been declined,
 * and so on. This module turns "allowed but never seen" into a plain-language
 * diagnosis so operators can tell a benign gap (feature off, no source events)
 * from a real one (source events exist, log rows missing).
 *
 * Pure and dependency-free so it can be unit-tested without a database.
 */
import { LogAction, type LogActionType } from "@/lib/log-action-types";

/** How much operator attention a gap deserves. */
export type GapSeverity =
  /** Explained by configuration — the business cannot produce this action. */
  | "expected"
  /** No source events of this kind exist yet; nothing to reconcile. */
  | "idle"
  /** Source events exist but no log rows do — likely a missing write. */
  | "attention";

/** Counts and flags describing what a business could possibly have logged. */
export interface BusinessSignals {
  hasPhoneNumber: boolean;
  reviewRequestsEnabled: boolean;
  intakeEnabled: boolean;
  voicemailEnabled: boolean;
  declineFollowupMode: string;
  customerCount: number;
  optedInCustomerCount: number;
  excludedNumberCount: number;
  quoteCount: number;
  declinedQuoteCount: number;
  depositQuoteCount: number;
  invoiceCount: number;
  intakeCount: number;
  contactImportCount: number;
  missedCallWebhookCount: number;
  inboundSmsWebhookCount: number;
  webhookDeliveryCount: number;
  /** Latest timestamps of related source events, used as gap evidence. */
  evidence?: BusinessEvidence;
}

/**
 * Latest observed timestamp per source of truth (ISO strings, or null when the
 * source has no rows). Used to show *when* the evidence behind a gap happened.
 */
export interface BusinessEvidence {
  numberProvisionedAt: string | null;
  latestLogAt: string | null;
  latestMissedCallWebhookAt: string | null;
  latestInboundSmsWebhookAt: string | null;
  latestWebhookDeliveryAt: string | null;
  latestCustomerAt: string | null;
  latestOptInUpdateAt: string | null;
  latestExcludedNumberAt: string | null;
  latestQuoteAt: string | null;
  latestDeclinedQuoteAt: string | null;
  latestDepositQuoteAt: string | null;
  latestInvoiceAt: string | null;
  latestContactImportAt: string | null;

}

export interface CoverageGap {
  actionType: LogActionType;
  severity: GapSeverity;
  /** Suggested cause, phrased for an operator reading the panel. */
  cause: string;
}

const gap = (severity: GapSeverity, cause: string) => ({ severity, cause });

/**
 * Explains why a business has zero log rows for `actionType`.
 * Only called for action types with no rows in `logs` or `logs_archive`.
 */
export function describeCoverageGap(
  actionType: LogActionType,
  s: BusinessSignals,
): { severity: GapSeverity; cause: string } {
  const noNumber = "No phone number provisioned — telephony automations can never fire.";

  switch (actionType) {
    case LogAction.number_provisioned:
      return s.hasPhoneNumber
        ? gap(
            "attention",
            "A number is provisioned on the profile but no provisioning entry exists. Background reconciliation should rebuild it on the next hourly pass.",
          )
        : gap("expected", "No number has been provisioned for this business yet.");

    case LogAction.missed_call_text:
    case LogAction.missed_call_autotext:
      if (!s.hasPhoneNumber) return gap("expected", noNumber);
      return s.missedCallWebhookCount > 0
        ? gap(
            "attention",
            `${s.missedCallWebhookCount} missed-call webhook(s) recorded but no auto-text entry — check the voice webhook handler and Twilio send errors.`,
          )
        : gap("idle", "No missed calls have reached the voice webhook yet.");

    case LogAction.missed_call_excluded:
      if (!s.hasPhoneNumber) return gap("expected", noNumber);
      return s.excludedNumberCount === 0
        ? gap("expected", "No excluded numbers configured, so no call can be skipped as excluded.")
        : gap("idle", "Excluded numbers exist but none of them has called yet.");

    case LogAction.voicemail_notify:
      if (!s.hasPhoneNumber) return gap("expected", noNumber);
      return s.voicemailEnabled
        ? gap("idle", "Voicemail is on but no caller has left a recording yet.")
        : gap("expected", "Voicemail capture is switched off in Settings.");

    case LogAction.review_request:
      if (!s.reviewRequestsEnabled)
        return gap("expected", "Review requests are switched off in Settings.");
      return s.customerCount === 0
        ? gap("idle", "No contacts yet, so no completed job can trigger a review request.")
        : gap("idle", "Review requests are on but none has been sent yet.");

    case LogAction.reactivation_text:
      return s.customerCount === 0
        ? gap("idle", "No contacts yet — Win Back has nobody to text.")
        : gap("idle", "No Win Back campaign has been run for these contacts yet.");

    case LogAction.customer_email_updated:
      return s.quoteCount === 0
        ? gap("expected", "No quotes yet — contact emails are only overwritten from a quote.")
        : gap("idle", "No quote has overwritten an existing contact email.");

    case LogAction.customer_consent_preserved:
      return s.contactImportCount === 0
        ? gap("expected", "No CSV contact imports have been run, so no consent has needed preserving.")
        : gap("idle", "Imports ran but none of them collided with an existing consented contact.");

    case LogAction.quote_sms:
      if (s.quoteCount === 0) return gap("expected", "No quotes have been created yet.");
      if (!s.hasPhoneNumber) return gap("expected", noNumber);
      return gap("attention", `${s.quoteCount} quote(s) exist but none was ever texted to a customer.`);

    case LogAction.quote_decline_reason_captured:
      return s.declinedQuoteCount === 0
        ? gap("expected", "No quote has been declined yet.")
        : gap(
            "attention",
            `${s.declinedQuoteCount} declined quote(s) but no captured reason — check the inbound SMS decline flow.`,
          );

    case LogAction.quote_decline_followup:
      if (s.declinedQuoteCount === 0) return gap("expected", "No quote has been declined yet.");
      return s.declineFollowupMode === "off"
        ? gap("expected", "Decline follow-ups are switched off in Settings.")
        : gap("attention", "Declined quotes exist and follow-ups are on, but none was sent.");

    case LogAction.quote_deposit_status:
      return s.depositQuoteCount === 0
        ? gap("expected", "No quote has required a deposit yet.")
        : gap(
            "attention",
            "Quotes with deposits exist but no deposit audit entry — the quotes deposit trigger may not have fired.",
          );

    case LogAction.invoice_balance_status:
      return s.invoiceCount === 0
        ? gap("expected", "No invoices have been created yet.")
        : gap(
            "attention",
            `${s.invoiceCount} invoice(s) exist but no balance audit entry — check the invoice audit trigger.`,
          );

    case LogAction.invoice_sms:
      if (s.invoiceCount === 0) return gap("expected", "No invoices have been created yet.");
      if (!s.hasPhoneNumber) return gap("expected", noNumber);
      return gap("idle", "Invoices exist but none has been texted to a customer yet.");

    case LogAction.sms_inbound:
      if (!s.hasPhoneNumber) return gap("expected", noNumber);
      return s.inboundSmsWebhookCount > 0
        ? gap(
            "attention",
            `${s.inboundSmsWebhookCount} inbound-SMS webhook(s) recorded but no inbound entry — reconciliation should rebuild these.`,
          )
        : gap("idle", "Nobody has texted this business number yet.");

    case LogAction.opt_in_prompt:
      return gap(
        "expected",
        "Opt-in prompt sends to customer numbers are held at the code level; only test sends to the owner's own number are allowed.",
      );

    case LogAction.opt_in_prompt_test:
      return gap("idle", "No test opt-in prompt has been sent from Settings yet.");

    case LogAction.status_refresh:
      return gap("idle", "No automation status refresh has run for this business yet.");

    case LogAction.automation_status_change:
      return gap("idle", "No automation has been switched on or off since audit logging was added.");

    case LogAction.webhook_delivery_status:
      return s.webhookDeliveryCount === 0
        ? gap("idle", "No webhook deliveries recorded for this business yet.")
        : gap(
            "idle",
            "Webhook deliveries are tracked in the delivery table; a log entry is only written for unusual retries.",
          );
  }
}

/** Sort order for display: loudest first. */
export const SEVERITY_RANK: Record<GapSeverity, number> = {
  attention: 0,
  idle: 1,
  expected: 2,
};

export function sortGaps(gaps: CoverageGap[]): CoverageGap[] {
  return [...gaps].sort(
    (a, b) =>
      SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] ||
      a.actionType.localeCompare(b.actionType),
  );
}
