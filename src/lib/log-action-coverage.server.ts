// Server-only cross-tenant coverage computation for `logs.action_type`.
// Shared by the admin diagnostics panel and the scheduled gap-alert scanner so
// both judge severity with exactly the same rules.
import { LOG_ACTION_TYPES, type LogActionType } from "@/lib/log-action-types";
import {
  describeCoverageGap,
  sortGaps,
  type BusinessEvidence,
  type BusinessSignals,
  type CoverageGap,
  type GapSeverity,
} from "@/lib/log-action-coverage";

export interface BusinessCoverage {
  userId: string;
  businessName: string;
  email: string | null;
  hasPhoneNumber: boolean;
  totalLogRows: number;
  /** Action types with at least one row in logs or logs_archive. */
  covered: LogActionType[];
  /** Allowed-but-never-seen action types, with a suggested cause. */
  gaps: CoverageGap[];
  attentionCount: number;
  signals: BusinessSignals;
}

export interface ActionTypeCoverageReport {
  generatedAt: string;
  allowedCount: number;
  /** Action types allowed by the constraint but unused across every business. */
  globallyUnused: LogActionType[];
  businesses: BusinessCoverage[];
  totals: Record<GapSeverity, number>;
}

/** Keeps the newest timestamp seen per business. */
const latest = (m: Map<string, string>, k: string | null | undefined, at: string | null | undefined) => {
  if (!k || !at) return;
  const current = m.get(k);
  if (!current || at > current) m.set(k, at);
};

const bump = (m: Map<string, number>, k: string | null | undefined) => {
  if (!k) return;
  m.set(k, (m.get(k) ?? 0) + 1);
};

/** Builds the full per-business coverage report using the service-role client. */
export async function computeCoverageReport(): Promise<ActionTypeCoverageReport> {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

  const [profiles, logs, archive, customers, quotes, invoices, intakes, excluded, imports, hooks, deliveries] =
    await Promise.all([
      supabaseAdmin
        .from("profiles")
        .select(
          "id, business_name, email, twilio_phone_sid, twilio_provisioned_at, review_requests_enabled, intake_enabled, voicemail_enabled, decline_followup_mode",
        ),
      supabaseAdmin.from("logs").select("user_id, action_type, created_at"),
      supabaseAdmin.from("logs_archive").select("user_id, action_type, original_created_at"),
      supabaseAdmin
        .from("customers")
        .select("user_id, opt_in_consent, created_at, sms_opt_in_at"),
      supabaseAdmin
        .from("quotes")
        .select("user_id, status, deposit_required, created_at, responded_at"),
      supabaseAdmin.from("invoices").select("user_id, created_at"),
      supabaseAdmin.from("intake_submissions").select("user_id"),
      supabaseAdmin.from("excluded_numbers").select("user_id, created_at"),
      supabaseAdmin.from("contact_import_events").select("user_id, occurred_at"),
      supabaseAdmin.from("webhook_events").select("user_id, event_kind, received_at"),
      supabaseAdmin.from("webhook_deliveries").select("user_id, last_seen_at"),
    ]);

  for (const r of [
    profiles,
    logs,
    archive,
    customers,
    quotes,
    invoices,
    intakes,
    excluded,
    imports,
    hooks,
    deliveries,
  ]) {
    if (r.error) throw new Error(r.error.message);
  }

  // action_type coverage keyed as `${user_id}|${action_type}`
  const seen = new Set<string>();
  const logRowCount = new Map<string, number>();
  const latestLog = new Map<string, string>();
  for (const row of logs.data ?? []) {
    seen.add(`${row.user_id}|${row.action_type}`);
    bump(logRowCount, row.user_id);
    latest(latestLog, row.user_id, row.created_at);
  }
  for (const row of archive.data ?? []) {
    seen.add(`${row.user_id}|${row.action_type}`);
    bump(logRowCount, row.user_id);
    latest(latestLog, row.user_id, row.original_created_at);
  }

  const customerCount = new Map<string, number>();
  const optedIn = new Map<string, number>();
  const latestCustomer = new Map<string, string>();
  const latestOptIn = new Map<string, string>();
  for (const c of customers.data ?? []) {
    bump(customerCount, c.user_id);
    if (c.opt_in_consent) bump(optedIn, c.user_id);
    latest(latestCustomer, c.user_id, c.created_at);
    latest(latestOptIn, c.user_id, c.sms_opt_in_at);
  }

  const quoteCount = new Map<string, number>();
  const declined = new Map<string, number>();
  const depositQuotes = new Map<string, number>();
  const latestQuote = new Map<string, string>();
  const latestDeclined = new Map<string, string>();
  const latestDepositQuote = new Map<string, string>();
  for (const q of quotes.data ?? []) {
    bump(quoteCount, q.user_id);
    latest(latestQuote, q.user_id, q.created_at);
    if (q.status === "declined") {
      bump(declined, q.user_id);
      latest(latestDeclined, q.user_id, q.responded_at ?? q.created_at);
    }
    if (q.deposit_required) {
      bump(depositQuotes, q.user_id);
      latest(latestDepositQuote, q.user_id, q.created_at);
    }
  }

  const invoiceCount = new Map<string, number>();
  const latestInvoice = new Map<string, string>();
  for (const i of invoices.data ?? []) {
    bump(invoiceCount, i.user_id);
    latest(latestInvoice, i.user_id, i.created_at);
  }
  const intakeCount = new Map<string, number>();
  for (const i of intakes.data ?? []) bump(intakeCount, i.user_id);
  const excludedCount = new Map<string, number>();
  const latestExcluded = new Map<string, string>();
  for (const e of excluded.data ?? []) {
    bump(excludedCount, e.user_id);
    latest(latestExcluded, e.user_id, e.created_at);
  }
  const importCount = new Map<string, number>();
  const latestImport = new Map<string, string>();
  for (const i of imports.data ?? []) {
    bump(importCount, i.user_id);
    latest(latestImport, i.user_id, i.occurred_at);
  }
  const deliveryCount = new Map<string, number>();
  const latestDelivery = new Map<string, string>();
  for (const d of deliveries.data ?? []) {
    bump(deliveryCount, d.user_id);
    latest(latestDelivery, d.user_id, d.last_seen_at);
  }

  const missedCallHooks = new Map<string, number>();
  const inboundSmsHooks = new Map<string, number>();
  const latestMissedCallHook = new Map<string, string>();
  const latestInboundSmsHook = new Map<string, string>();
  for (const w of hooks.data ?? []) {
    if (w.event_kind === "missed_call") {
      bump(missedCallHooks, w.user_id);
      latest(latestMissedCallHook, w.user_id, w.received_at);
    }
    if (w.event_kind === "sms_inbound") {
      bump(inboundSmsHooks, w.user_id);
      latest(latestInboundSmsHook, w.user_id, w.received_at);
    }
  }

  const allowed = [...LOG_ACTION_TYPES];
  const totals: Record<GapSeverity, number> = { attention: 0, idle: 0, expected: 0 };
  const globallyCovered = new Set<string>();

  const businesses: BusinessCoverage[] = (profiles.data ?? []).map((p) => {
    const evidence: BusinessEvidence = {
      numberProvisionedAt: p.twilio_provisioned_at ?? null,
      latestLogAt: latestLog.get(p.id) ?? null,
      latestMissedCallWebhookAt: latestMissedCallHook.get(p.id) ?? null,
      latestInboundSmsWebhookAt: latestInboundSmsHook.get(p.id) ?? null,
      latestWebhookDeliveryAt: latestDelivery.get(p.id) ?? null,
      latestCustomerAt: latestCustomer.get(p.id) ?? null,
      latestOptInUpdateAt: latestOptIn.get(p.id) ?? null,
      latestExcludedNumberAt: latestExcluded.get(p.id) ?? null,
      latestQuoteAt: latestQuote.get(p.id) ?? null,
      latestDeclinedQuoteAt: latestDeclined.get(p.id) ?? null,
      latestDepositQuoteAt: latestDepositQuote.get(p.id) ?? null,
      latestInvoiceAt: latestInvoice.get(p.id) ?? null,
      latestContactImportAt: latestImport.get(p.id) ?? null,
    };

    const signals: BusinessSignals = {
      hasPhoneNumber: Boolean(p.twilio_phone_sid),
      reviewRequestsEnabled: Boolean(p.review_requests_enabled),
      intakeEnabled: Boolean(p.intake_enabled),
      voicemailEnabled: Boolean(p.voicemail_enabled),
      declineFollowupMode: p.decline_followup_mode ?? "off",
      customerCount: customerCount.get(p.id) ?? 0,
      optedInCustomerCount: optedIn.get(p.id) ?? 0,
      excludedNumberCount: excludedCount.get(p.id) ?? 0,
      quoteCount: quoteCount.get(p.id) ?? 0,
      declinedQuoteCount: declined.get(p.id) ?? 0,
      depositQuoteCount: depositQuotes.get(p.id) ?? 0,
      invoiceCount: invoiceCount.get(p.id) ?? 0,
      intakeCount: intakeCount.get(p.id) ?? 0,
      contactImportCount: importCount.get(p.id) ?? 0,
      missedCallWebhookCount: missedCallHooks.get(p.id) ?? 0,
      inboundSmsWebhookCount: inboundSmsHooks.get(p.id) ?? 0,
      webhookDeliveryCount: deliveryCount.get(p.id) ?? 0,
      evidence,
    };

    const covered: LogActionType[] = [];
    const gaps: CoverageGap[] = [];
    for (const actionType of allowed) {
      if (seen.has(`${p.id}|${actionType}`)) {
        covered.push(actionType);
        globallyCovered.add(actionType);
        continue;
      }
      const { severity, cause } = describeCoverageGap(actionType, signals);
      totals[severity] += 1;
      gaps.push({ actionType, severity, cause });
    }

    const sorted = sortGaps(gaps);
    return {
      userId: p.id,
      businessName: p.business_name || "(unnamed)",
      email: p.email,
      hasPhoneNumber: signals.hasPhoneNumber,
      totalLogRows: logRowCount.get(p.id) ?? 0,
      covered,
      gaps: sorted,
      attentionCount: sorted.filter((g) => g.severity === "attention").length,
      signals,
    };
  });

  businesses.sort(
    (a, b) => b.attentionCount - a.attentionCount || a.businessName.localeCompare(b.businessName),
  );

  return {
    generatedAt: new Date().toISOString(),
    allowedCount: allowed.length,
    globallyUnused: allowed.filter((a) => !globallyCovered.has(a)),
    businesses,
    totals,
  };
}
