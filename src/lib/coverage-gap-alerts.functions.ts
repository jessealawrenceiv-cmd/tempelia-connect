import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import type { GapScanSummary } from "@/lib/coverage-gap-alerts.server";

export type { GapScanSummary };

export interface CoverageGapAlert {
  id: string;
  userId: string;
  businessName: string;
  actionType: string;
  cause: string;
  firstSeenAt: string;
  lastSeenAt: string;
  observationCount: number;
  flaggedAt: string | null;
  status: "open" | "acknowledged" | "resolved";
  acknowledgedAt: string | null;
  acknowledgedNote: string | null;
  resolvedAt: string | null;
  /** Hours the gap has been continuously observed. */
  ageHours: number;
}

export interface CoverageGapInbox {
  generatedAt: string;
  escalationHours: number;
  alerts: CoverageGapAlert[];
  flaggedCount: number;
  openCount: number;
  lastScan: {
    ranAt: string;
    scope: string;
    businessesScanned: number;
    gapsObserved: number;
    alertsOpened: number;
    alertsFlagged: number;
    alertsResolved: number;
    durationMs: number;
  } | null;
}

async function assertAdmin(
  supabase: { rpc: (fn: string, args: Record<string, unknown>) => Promise<{ data: unknown; error: { message: string } | null }> },
  userId: string,
  functionName: string,
) {
  const { data: isAdmin, error } = await supabase.rpc("has_role", { _role: "admin" });
  if (error) throw new Error(error.message);
  const { recordAdminAccess, checkAdminRateLimit } = await import("@/lib/admin-audit.server");
  if (!isAdmin) {
    await recordAdminAccess({ actorUserId: userId, functionName, outcome: "forbidden" });
    throw new Error("Forbidden");
  }
  const rate = await checkAdminRateLimit(userId, functionName);
  if (!rate.allowed) {
    await recordAdminAccess({
      actorUserId: userId,
      functionName,
      outcome: "rate_limited",
      detail: `${rate.recentCalls} calls in the last 60s (limit ${rate.limit})`,
    });
    throw new Error(`Rate limit exceeded: ${rate.limit} calls/minute for ${functionName}.`);
  }
  return recordAdminAccess;
}

/** Operator inbox: persisted coverage gaps, loudest and oldest first. */
export const getCoverageGapInbox = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { includeResolved?: boolean } | undefined) => ({
    includeResolved: Boolean(input?.includeResolved),
  }))
  .handler(async ({ data, context }): Promise<CoverageGapInbox> => {
    const { supabase, userId } = context;
    const recordAdminAccess = await assertAdmin(supabase, userId, "getCoverageGapInbox");
    const { GAP_ESCALATION_MS } = await import("@/lib/coverage-gap-alerts.server");
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    let query = supabaseAdmin
      .from("coverage_gap_alerts")
      .select(
        "id, user_id, action_type, cause, first_seen_at, last_seen_at, observation_count, flagged_at, status, acknowledged_at, acknowledged_note, resolved_at",
      )
      .order("flagged_at", { ascending: true, nullsFirst: false })
      .order("first_seen_at", { ascending: true })
      .limit(200);
    if (!data.includeResolved) query = query.is("resolved_at", null);

    const [alertRows, profiles, runs] = await Promise.all([
      query,
      supabaseAdmin.from("profiles").select("id, business_name"),
      supabaseAdmin
        .from("coverage_gap_scan_runs")
        .select(
          "ran_at, scope, businesses_scanned, gaps_observed, alerts_opened, alerts_flagged, alerts_resolved, duration_ms",
        )
        .order("ran_at", { ascending: false })
        .limit(1),
    ]);
    for (const r of [alertRows, profiles, runs]) if (r.error) throw new Error(r.error.message);

    const names = new Map((profiles.data ?? []).map((p) => [p.id, p.business_name || "(unnamed)"]));
    const now = Date.now();

    const alerts: CoverageGapAlert[] = (alertRows.data ?? []).map((r) => ({
      id: r.id,
      userId: r.user_id,
      businessName: names.get(r.user_id) ?? "(unknown business)",
      actionType: r.action_type,
      cause: r.cause,
      firstSeenAt: r.first_seen_at,
      lastSeenAt: r.last_seen_at,
      observationCount: r.observation_count ?? 0,
      flaggedAt: r.flagged_at,
      status: (r.status as CoverageGapAlert["status"]) ?? "open",
      acknowledgedAt: r.acknowledged_at,
      acknowledgedNote: r.acknowledged_note,
      resolvedAt: r.resolved_at,
      ageHours:
        Math.round(
          ((r.resolved_at ? new Date(r.resolved_at).getTime() : now) -
            new Date(r.first_seen_at).getTime()) /
            36000,
        ) / 100,
    }));

    // Flagged first, then longest-standing.
    alerts.sort(
      (a, b) =>
        Number(Boolean(b.flaggedAt)) - Number(Boolean(a.flaggedAt)) || b.ageHours - a.ageHours,
    );

    await recordAdminAccess({
      actorUserId: userId,
      functionName: "getCoverageGapInbox",
      rowCount: alerts.length,
      outcome: "allowed",
    });

    const last = runs.data?.[0];
    return {
      generatedAt: new Date().toISOString(),
      escalationHours: GAP_ESCALATION_MS / 3600000,
      alerts,
      flaggedCount: alerts.filter((a) => a.flaggedAt && a.status === "open").length,
      openCount: alerts.filter((a) => a.status === "open").length,
      lastScan: last
        ? {
            ranAt: last.ran_at,
            scope: last.scope,
            businessesScanned: last.businesses_scanned,
            gapsObserved: last.gaps_observed,
            alertsOpened: last.alerts_opened,
            alertsFlagged: last.alerts_flagged,
            alertsResolved: last.alerts_resolved,
            durationMs: last.duration_ms,
          }
        : null,
    };
  });

/** Runs the persistence + escalation scan right now. */
export const runCoverageGapScan = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }): Promise<GapScanSummary> => {
    const { supabase, userId } = context;
    const recordAdminAccess = await assertAdmin(supabase, userId, "runCoverageGapScan");
    const { syncCoverageGapAlerts } = await import("@/lib/coverage-gap-alerts.server");
    const summary = await syncCoverageGapAlerts({ scope: "manual", triggeredBy: userId });
    await recordAdminAccess({
      actorUserId: userId,
      functionName: "runCoverageGapScan",
      rowCount: summary.gapsObserved,
      outcome: "allowed",
      detail: `opened ${summary.alertsOpened}, flagged ${summary.alertsFlagged}, resolved ${summary.alertsResolved}`,
    });
    return summary;
  });

/** Marks an alert as being worked on (or clears the acknowledgement). */
export const acknowledgeCoverageGapAlert = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { alertId: string; note?: string; undo?: boolean }) => {
    if (!input?.alertId || typeof input.alertId !== "string") throw new Error("alertId is required");
    return {
      alertId: input.alertId,
      note: typeof input.note === "string" ? input.note.slice(0, 500) : "",
      undo: Boolean(input.undo),
    };
  })
  .handler(async ({ data, context }): Promise<{ ok: true }> => {
    const { supabase, userId } = context;
    const recordAdminAccess = await assertAdmin(supabase, userId, "acknowledgeCoverageGapAlert");
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    const { error } = await supabaseAdmin
      .from("coverage_gap_alerts")
      .update(
        data.undo
          ? { status: "open", acknowledged_at: null, acknowledged_by: null, acknowledged_note: null }
          : {
              status: "acknowledged",
              acknowledged_at: new Date().toISOString(),
              acknowledged_by: userId,
              acknowledged_note: data.note || null,
            },
      )
      .eq("id", data.alertId)
      .is("resolved_at", null);
    if (error) throw new Error(error.message);

    await recordAdminAccess({
      actorUserId: userId,
      functionName: "acknowledgeCoverageGapAlert",
      rowCount: 1,
      outcome: "allowed",
      detail: `${data.undo ? "reopened" : "acknowledged"} ${data.alertId}`,
    });
    return { ok: true };
  });
