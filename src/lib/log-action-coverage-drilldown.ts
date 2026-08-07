/**
 * Drilldown for a coverage gap: which source tables were consulted, the exact
 * predicate used, the time window applied, and what was observed.
 *
 * The coverage scan (`getActionTypeCoverage`) reads every source table without a
 * time filter and counts rows per business. This module restates those reads in
 * auditable form so an operator can reproduce them by hand and see why the panel
 * concluded "no entries".
 *
 * Pure and dependency-free — unit-testable without a database.
 */
import { LogAction, type LogActionType } from "@/lib/log-action-types";
import type { BusinessSignals } from "@/lib/log-action-coverage";

export type CheckOutcome =
  /** Query returned no rows — nothing to reconcile from this source. */
  | "no-rows"
  /** Source rows exist, so a log entry was expected. */
  | "rows-exist"
  /** A settings flag, not a row count. */
  | "config";

export interface SourceCheck {
  /** Fully-qualified table (or profile column) the scan read. */
  table: string;
  /** The predicate applied, written the way the scan applies it. */
  predicate: string;
  /** Exact time window used to decide there are no entries. */
  window: string;
  /** What the scan observed for this business. */
  observed: string;
  outcome: CheckOutcome;
}

export interface GapDrilldown {
  /** The two reads that established "this action type has no entries". */
  presence: SourceCheck[];
  /** Source-of-truth reads that decide whether entries were expected. */
  sources: SourceCheck[];
  /** Caveats about the windows above. */
  notes: string[];
}

/** The coverage scan applies no created_at filter to any read. */
const ALL_TIME = "All time — no created_at bound is applied by the scan.";

const rows = (n: number) => (n === 1 ? "1 row" : `${n} rows`);
const rowCheck = (table: string, predicate: string, n: number): SourceCheck => ({
  table,
  predicate,
  window: ALL_TIME,
  observed: rows(n),
  outcome: n > 0 ? "rows-exist" : "no-rows",
});
const flagCheck = (predicate: string, value: string): SourceCheck => ({
  table: "public.profiles",
  predicate,
  window: "Current value at scan time (settings are not versioned).",
  observed: value,
  outcome: "config",
});

const onOff = (v: boolean) => (v ? "true (enabled)" : "false (disabled)");

function presenceChecks(actionType: LogActionType): SourceCheck[] {
  const predicate = `user_id = <business id> AND action_type = '${actionType}'`;
  return [
    {
      table: "public.logs",
      predicate,
      window:
        "All time within live retention — rows older than 90 days, or beyond the newest 5,000 per business, are moved to logs_archive by the nightly job.",
      observed: "0 rows",
      outcome: "no-rows",
    },
    {
      table: "public.logs_archive",
      predicate: `user_id = <business id> AND action_type = '${actionType}'`,
      window:
        "All time within archive retention — archived rows are purged after 2 years (original_created_at).",
      observed: "0 rows",
      outcome: "no-rows",
    },
  ];
}

const phoneCheck = (s: BusinessSignals) =>
  flagCheck("twilio_phone_sid IS NOT NULL", s.hasPhoneNumber ? "provisioned" : "null (no number)");

/** Source reads behind the gap verdict for one action type. */
function sourceChecks(actionType: LogActionType, s: BusinessSignals): SourceCheck[] {
  switch (actionType) {
    case LogAction.number_provisioned:
      return [phoneCheck(s)];

    case LogAction.missed_call_text:
    case LogAction.missed_call_autotext:
      return [
        phoneCheck(s),
        rowCheck(
          "public.webhook_events",
          "user_id = <business id> AND event_kind = 'missed_call'",
          s.missedCallWebhookCount,
        ),
      ];

    case LogAction.missed_call_excluded:
      return [
        phoneCheck(s),
        rowCheck("public.excluded_numbers", "user_id = <business id>", s.excludedNumberCount),
        rowCheck(
          "public.webhook_events",
          "user_id = <business id> AND event_kind = 'missed_call'",
          s.missedCallWebhookCount,
        ),
      ];

    case LogAction.voicemail_notify:
      return [phoneCheck(s), flagCheck("voicemail_enabled", onOff(s.voicemailEnabled))];

    case LogAction.review_request:
      return [
        flagCheck("review_requests_enabled", onOff(s.reviewRequestsEnabled)),
        rowCheck("public.customers", "user_id = <business id>", s.customerCount),
      ];

    case LogAction.reactivation_text:
      return [
        rowCheck("public.customers", "user_id = <business id>", s.customerCount),
        rowCheck(
          "public.customers",
          "user_id = <business id> AND opt_in_consent = true",
          s.optedInCustomerCount,
        ),
      ];

    case LogAction.customer_email_updated:
      return [rowCheck("public.quotes", "user_id = <business id>", s.quoteCount)];

    case LogAction.customer_consent_preserved:
      return [
        rowCheck("public.contact_import_events", "user_id = <business id>", s.contactImportCount),
      ];

    case LogAction.quote_sms:
      return [rowCheck("public.quotes", "user_id = <business id>", s.quoteCount), phoneCheck(s)];

    case LogAction.quote_decline_reason_captured:
      return [
        rowCheck(
          "public.quotes",
          "user_id = <business id> AND status = 'declined'",
          s.declinedQuoteCount,
        ),
        rowCheck(
          "public.webhook_events",
          "user_id = <business id> AND event_kind = 'sms_inbound'",
          s.inboundSmsWebhookCount,
        ),
      ];

    case LogAction.quote_decline_followup:
      return [
        rowCheck(
          "public.quotes",
          "user_id = <business id> AND status = 'declined'",
          s.declinedQuoteCount,
        ),
        flagCheck("decline_followup_mode", s.declineFollowupMode),
      ];

    case LogAction.quote_deposit_status:
      return [
        rowCheck(
          "public.quotes",
          "user_id = <business id> AND deposit_required = true",
          s.depositQuoteCount,
        ),
      ];

    case LogAction.invoice_balance_status:
      return [rowCheck("public.invoices", "user_id = <business id>", s.invoiceCount)];

    case LogAction.invoice_sms:
      return [rowCheck("public.invoices", "user_id = <business id>", s.invoiceCount), phoneCheck(s)];

    case LogAction.sms_inbound:
      return [
        phoneCheck(s),
        rowCheck(
          "public.webhook_events",
          "user_id = <business id> AND event_kind = 'sms_inbound'",
          s.inboundSmsWebhookCount,
        ),
      ];

    case LogAction.opt_in_prompt:
      return [
        rowCheck(
          "public.customers",
          "user_id = <business id> AND opt_in_consent = true",
          s.optedInCustomerCount,
        ),
        {
          table: "src/lib/opt-in-prompt-gate.ts",
          predicate: "Code-level hold: sends to customer numbers are disabled outright.",
          window: "Permanent until the hold is lifted in code.",
          observed: "hold active",
          outcome: "config",
        },
      ];

    case LogAction.opt_in_prompt_test:
      return [phoneCheck(s)];

    case LogAction.status_refresh:
      return [
        rowCheck("public.customers", "user_id = <business id>", s.customerCount),
        phoneCheck(s),
      ];

    case LogAction.automation_status_change:
      return [
        flagCheck("review_requests_enabled", onOff(s.reviewRequestsEnabled)),
        flagCheck("intake_enabled", onOff(s.intakeEnabled)),
        flagCheck("voicemail_enabled", onOff(s.voicemailEnabled)),
      ];

    case LogAction.webhook_delivery_status:
      return [
        rowCheck("public.webhook_deliveries", "user_id = <business id>", s.webhookDeliveryCount),
      ];
  }
}

const BASE_NOTES = [
  "The scan reads each table once with no created_at filter, then groups rows per business — counts above are lifetime totals, not a rolling window.",
  "A zero in logs plus a zero in logs_archive is what marks the type as a gap; retention can only hide rows older than 2 years.",
];

/** Full drilldown for one missing action type. */
export function describeGapDrilldown(
  actionType: LogActionType,
  signals: BusinessSignals,
): GapDrilldown {
  const sources = sourceChecks(actionType, signals);
  const notes = [...BASE_NOTES];
  if (sources.some((c) => c.outcome === "rows-exist")) {
    notes.push(
      "Source rows exist while both log tables are empty — reconcile with the hourly rebuild job, or check the writer for this action type.",
    );
  }
  return { presence: presenceChecks(actionType), sources, notes };
}
