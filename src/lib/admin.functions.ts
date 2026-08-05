import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

// Base cost estimate for a US local Twilio number, in USD/month.
// Displayed as a rough operational overview — Twilio console is the billing truth.
const BASE_MONTHLY_USD = 1.15;

export interface TenantNumberRow {
  userId: string;
  businessName: string;
  email: string | null;
  phoneNumber: string;
  provisionedAt: string | null;
  messagesThisMonth: number;
  estimatedMonthlyUsd: number;
  subscriptionStatus: string;
  isChurned: boolean;
}

export interface FleetSummary {
  numberCount: number;
  activeCount: number;
  churnedCount: number;
  totalEstimatedMonthlyUsd: number;
  churnedMonthlyWasteUsd: number;
  totalMessagesThisMonth: number;
  baseMonthlyUsd: number;
  rows: TenantNumberRow[];
}

// Subscription states considered "no longer paying" — number is still on the
// account and billing, but the tenant has churned. Reclaim candidates.
const CHURNED_STATUSES = new Set(["canceled", "cancelled", "past_due", "unpaid", "incomplete_expired"]);

export const listProvisionedNumbers = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }): Promise<FleetSummary> => {
    const { supabase } = context;

    // Gate: caller must be an admin.
    const { data: isAdmin, error: roleErr } = await supabase
      .rpc("has_role", { _role: "admin" });
    if (roleErr) throw new Error(roleErr.message);
    if (!isAdmin) throw new Error("Forbidden");

    // Audit + throttle helpers (server-only module, loaded after the role gate).
    const { recordAdminAccess, checkAdminRateLimit } = await import("@/lib/admin-audit.server");

    const rate = await checkAdminRateLimit(context.userId, "listProvisionedNumbers");
    if (!rate.allowed) {
      await recordAdminAccess({
        actorUserId: context.userId,
        functionName: "listProvisionedNumbers",
        outcome: "rate_limited",
        detail: `${rate.recentCalls} calls in the last 60s (limit ${rate.limit})`,
      });
      throw new Error(
        `Rate limit exceeded: ${rate.limit} calls/minute for listProvisionedNumbers. Try again in a minute.`,
      );
    }

    // Elevate to service-role for the cross-tenant read.
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");


    const { data: profiles, error: profErr } = await supabaseAdmin
      .from("profiles")
      .select("id, business_name, email, twilio_phone_number, twilio_provisioned_at, subscription_status")
      .not("twilio_phone_number", "is", null)
      .order("twilio_provisioned_at", { ascending: false });
    if (profErr) throw new Error(profErr.message);

    // Month-to-date outbound message counts per tenant.
    const monthStart = new Date();
    monthStart.setDate(1);
    monthStart.setHours(0, 0, 0, 0);

    const { data: logs, error: logErr } = await supabaseAdmin
      .from("logs")
      .select("user_id, action_type")
      .in("action_type", ["review_request", "reactivation_text", "missed_call_autotext"])
      .eq("status", "sent")
      .gte("created_at", monthStart.toISOString());
    if (logErr) throw new Error(logErr.message);

    const counts = new Map<string, number>();
    for (const l of logs ?? []) {
      counts.set(l.user_id, (counts.get(l.user_id) ?? 0) + 1);
    }

    const rows: TenantNumberRow[] = (profiles ?? []).map((p) => {
      const status = p.subscription_status ?? "unknown";
      return {
        userId: p.id,
        businessName: p.business_name || "(unnamed)",
        email: p.email,
        phoneNumber: p.twilio_phone_number!,
        provisionedAt: p.twilio_provisioned_at,
        messagesThisMonth: counts.get(p.id) ?? 0,
        estimatedMonthlyUsd: BASE_MONTHLY_USD,
        subscriptionStatus: status,
        isChurned: CHURNED_STATUSES.has(status),
      };
    });

    // Sort churned to the top so operators see reclaim candidates first.
    rows.sort((a, b) => Number(b.isChurned) - Number(a.isChurned));

    const totalMessages = rows.reduce((n, r) => n + r.messagesThisMonth, 0);
    const churnedCount = rows.filter((r) => r.isChurned).length;
    const activeCount = rows.length - churnedCount;

    await recordAdminAccess({
      actorUserId: context.userId,
      functionName: "listProvisionedNumbers",
      rowCount: rows.length,
      outcome: "allowed",
    });



    return {
      numberCount: rows.length,
      activeCount,
      churnedCount,
      totalEstimatedMonthlyUsd: rows.length * BASE_MONTHLY_USD,
      churnedMonthlyWasteUsd: churnedCount * BASE_MONTHLY_USD,
      totalMessagesThisMonth: totalMessages,
      baseMonthlyUsd: BASE_MONTHLY_USD,
      rows,
    };
  });

// Lightweight role probe used by the client to decide whether to show the admin nav link.
export const getIsAdmin = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }): Promise<{ isAdmin: boolean }> => {
    const { supabase } = context;
    const { data } = await supabase.rpc("has_role", { _role: "admin" });
    return { isAdmin: Boolean(data) };
  });

export interface AdminAccessLogRow {
  id: string;
  occurredAt: string;
  functionName: string;
  outcome: string;
  rowCount: number | null;
  detail: string | null;
}

// Recent audit trail for cross-tenant admin tools. Admin-gated; reads through the
// caller's own client so the admin-only RLS policy is the enforcing layer too.
export const listAdminAccessLog = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }): Promise<AdminAccessLogRow[]> => {
    const { supabase } = context;
    const { data: isAdmin, error: roleErr } = await supabase.rpc("has_role", { _role: "admin" });
    if (roleErr) throw new Error(roleErr.message);
    if (!isAdmin) throw new Error("Forbidden");

    const { data, error } = await supabase
      .from("admin_access_log")
      .select("id, occurred_at, function_name, outcome, row_count, detail")
      .order("occurred_at", { ascending: false })
      .limit(25);
    if (error) throw new Error(error.message);

    return (data ?? []).map((r) => ({
      id: r.id,
      occurredAt: r.occurred_at,
      functionName: r.function_name,
      outcome: r.outcome,
      rowCount: r.row_count,
      detail: r.detail,
    }));
  });

