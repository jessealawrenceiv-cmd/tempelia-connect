import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { LOG_ACTION_TYPES, type LogActionType } from "@/lib/log-action-types";
import {
  describeCoverageGap,
  sortGaps,
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

const bump = (m: Map<string, number>, k: string | null | undefined) => {
  if (!k) return;
  m.set(k, (m.get(k) ?? 0) + 1);
};

export const getActionTypeCoverage = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }): Promise<ActionTypeCoverageReport> => {
    const { supabase, userId } = context;

    const { data: isAdmin, error: roleErr } = await supabase.rpc("has_role", { _role: "admin" });
    if (roleErr) throw new Error(roleErr.message);
    if (!isAdmin) throw new Error("Forbidden");

    const { recordAdminAccess, checkAdminRateLimit } = await import("@/lib/admin-audit.server");
    const rate = await checkAdminRateLimit(userId, "getActionTypeCoverage");
    if (!rate.allowed) {
      await recordAdminAccess({
        actorUserId: userId,
        functionName: "getActionTypeCoverage",
        outcome: "rate_limited",
        detail: `${rate.recentCalls} calls in the last 60s (limit ${rate.limit})`,
      });
      throw new Error(
        `Rate limit exceeded: ${rate.limit} calls/minute for getActionTypeCoverage. Try again in a minute.`,
      );
    }

    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    const [profiles, logs, archive, customers, quotes, invoices, intakes, excluded, imports, hooks, deliveries] =
      await Promise.all([
        supabaseAdmin
          .from("profiles")
          .select(
            "id, business_name, email, twilio_phone_sid, review_requests_enabled, intake_enabled, voicemail_enabled, decline_followup_mode",
          ),
        supabaseAdmin.from("logs").select("user_id, action_type"),
        supabaseAdmin.from("logs_archive").select("user_id, action_type"),
        supabaseAdmin.from("customers").select("user_id, opt_in_consent"),
        supabaseAdmin.from("quotes").select("user_id, status, deposit_required"),
        supabaseAdmin.from("invoices").select("user_id"),
        supabaseAdmin.from("intake_submissions").select("user_id"),
        supabaseAdmin.from("excluded_numbers").select("user_id"),
        supabaseAdmin.from("contact_import_events").select("user_id"),
        supabaseAdmin.from("webhook_events").select("user_id, event_kind"),
        supabaseAdmin.from("webhook_deliveries").select("user_id"),
      ]);

    for (const r of [profiles, logs, archive, customers, quotes, invoices, intakes, excluded, imports, hooks, deliveries]) {
      if (r.error) throw new Error(r.error.message);
    }

    // action_type coverage keyed as `${user_id}|${action_type}`
    const seen = new Set<string>();
    const logRowCount = new Map<string, number>();
    for (const row of [...(logs.data ?? []), ...(archive.data ?? [])]) {
      seen.add(`${row.user_id}|${row.action_type}`);
      bump(logRowCount, row.user_id);
    }

    const customerCount = new Map<string, number>();
    const optedIn = new Map<string, number>();
    for (const c of customers.data ?? []) {
      bump(customerCount, c.user_id);
      if (c.opt_in_consent) bump(optedIn, c.user_id);
    }

    const quoteCount = new Map<string, number>();
    const declined = new Map<string, number>();
    const depositQuotes = new Map<string, number>();
    for (const q of quotes.data ?? []) {
      bump(quoteCount, q.user_id);
      if (q.status === "declined") bump(declined, q.user_id);
      if (q.deposit_required) bump(depositQuotes, q.user_id);
    }

    const invoiceCount = new Map<string, number>();
    for (const i of invoices.data ?? []) bump(invoiceCount, i.user_id);
    const intakeCount = new Map<string, number>();
    for (const i of intakes.data ?? []) bump(intakeCount, i.user_id);
    const excludedCount = new Map<string, number>();
    for (const e of excluded.data ?? []) bump(excludedCount, e.user_id);
    const importCount = new Map<string, number>();
    for (const i of imports.data ?? []) bump(importCount, i.user_id);
    const deliveryCount = new Map<string, number>();
    for (const d of deliveries.data ?? []) bump(deliveryCount, d.user_id);

    const missedCallHooks = new Map<string, number>();
    const inboundSmsHooks = new Map<string, number>();
    for (const w of hooks.data ?? []) {
      if (w.event_kind === "missed_call") bump(missedCallHooks, w.user_id);
      if (w.event_kind === "sms_inbound") bump(inboundSmsHooks, w.user_id);
    }

    const allowed = [...LOG_ACTION_TYPES];
    const totals: Record<GapSeverity, number> = { attention: 0, idle: 0, expected: 0 };
    const globallyCovered = new Set<string>();

    const businesses: BusinessCoverage[] = (profiles.data ?? []).map((p) => {
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

    await recordAdminAccess({
      actorUserId: userId,
      functionName: "getActionTypeCoverage",
      rowCount: businesses.length,
      outcome: "allowed",
    });

    return {
      generatedAt: new Date().toISOString(),
      allowedCount: allowed.length,
      globallyUnused: allowed.filter((a) => !globallyCovered.has(a)),
      businesses,
      totals,
    };
  });
