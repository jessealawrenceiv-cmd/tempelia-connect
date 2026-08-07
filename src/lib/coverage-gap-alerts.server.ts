/**
 * Coverage-gap alert scanner.
 *
 * The coverage report is a point-in-time snapshot: it says "this business has
 * source events but no log rows" without any notion of how long that has been
 * true. This module persists each high-severity ("attention") gap so a gap that
 * survives repeated scans can be escalated. Once a gap has been observed
 * continuously for more than 24 hours it is flagged and lands in the operator
 * inbox; when the gap disappears the alert resolves itself.
 *
 * Server-only: writes with the service-role client so alerts cannot be
 * tampered with by a tenant.
 */
import { computeCoverageReport } from "@/lib/log-action-coverage.server";

export const GAP_ESCALATION_MS = 24 * 60 * 60 * 1000;

export interface GapScanSummary {
  runId: string | null;
  ranAt: string;
  scope: "scheduled" | "manual";
  businessesScanned: number;
  gapsObserved: number;
  alertsOpened: number;
  alertsFlagged: number;
  alertsResolved: number;
  durationMs: number;
}

/**
 * Recomputes coverage, records every attention-level gap, escalates the ones
 * that have persisted past 24h, and resolves alerts whose gap is gone.
 */
export async function syncCoverageGapAlerts(opts: {
  scope: "scheduled" | "manual";
  triggeredBy?: string | null;
}): Promise<GapScanSummary> {
  const startedAt = Date.now();
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

  const report = await computeCoverageReport();

  // Current attention gaps keyed as `${user_id}|${action_type}`.
  const current = new Map<string, { userId: string; actionType: string; cause: string }>();
  for (const business of report.businesses) {
    for (const gap of business.gaps) {
      if (gap.severity !== "attention") continue;
      current.set(`${business.userId}|${gap.actionType}`, {
        userId: business.userId,
        actionType: gap.actionType,
        cause: gap.cause,
      });
    }
  }

  const { data: openRows, error: openErr } = await supabaseAdmin
    .from("coverage_gap_alerts")
    .select("id, user_id, action_type, first_seen_at, flagged_at, status, observation_count")
    .is("resolved_at", null);
  if (openErr) throw new Error(openErr.message);

  const now = new Date();
  const nowIso = now.toISOString();
  const existing = new Map((openRows ?? []).map((r) => [`${r.user_id}|${r.action_type}`, r]));

  let alertsOpened = 0;
  let alertsFlagged = 0;
  let alertsResolved = 0;

  // Insert brand-new gaps, refresh the ones still present, escalate past 24h.
  for (const [key, gap] of current) {
    const row = existing.get(key);
    if (!row) {
      const { error } = await supabaseAdmin.from("coverage_gap_alerts").insert({
        user_id: gap.userId,
        action_type: gap.actionType,
        severity: "attention",
        cause: gap.cause,
        first_seen_at: nowIso,
        last_seen_at: nowIso,
        observation_count: 1,
      });
      if (error) throw new Error(error.message);
      alertsOpened += 1;
      continue;
    }

    const persistedMs = now.getTime() - new Date(row.first_seen_at).getTime();
    const shouldFlag = persistedMs > GAP_ESCALATION_MS && !row.flagged_at;
    const { error } = await supabaseAdmin
      .from("coverage_gap_alerts")
      .update({
        last_seen_at: nowIso,
        cause: gap.cause,
        observation_count: (row.observation_count ?? 0) + 1,
        ...(shouldFlag ? { flagged_at: nowIso } : {}),
      })
      .eq("id", row.id);
    if (error) throw new Error(error.message);
    if (shouldFlag) alertsFlagged += 1;
  }

  // Auto-resolve alerts whose gap no longer appears in the report.
  for (const [key, row] of existing) {
    if (current.has(key)) continue;
    const { error } = await supabaseAdmin
      .from("coverage_gap_alerts")
      .update({ status: "resolved", resolved_at: nowIso })
      .eq("id", row.id);
    if (error) throw new Error(error.message);
    alertsResolved += 1;
  }

  const durationMs = Date.now() - startedAt;
  const { data: run, error: runErr } = await supabaseAdmin
    .from("coverage_gap_scan_runs")
    .insert({
      ran_at: nowIso,
      scope: opts.scope,
      triggered_by: opts.triggeredBy ?? null,
      businesses_scanned: report.businesses.length,
      gaps_observed: current.size,
      alerts_opened: alertsOpened,
      alerts_flagged: alertsFlagged,
      alerts_resolved: alertsResolved,
      duration_ms: durationMs,
    })
    .select("id")
    .maybeSingle();
  if (runErr) throw new Error(runErr.message);

  return {
    runId: run?.id ?? null,
    ranAt: nowIso,
    scope: opts.scope,
    businessesScanned: report.businesses.length,
    gapsObserved: current.size,
    alertsOpened,
    alertsFlagged,
    alertsResolved,
    durationMs,
  };
}
