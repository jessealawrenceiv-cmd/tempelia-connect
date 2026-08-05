import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

export type RecoveryAction = "return_to_top" | "show_latest" | "clear_filters" | "dismiss";

export const RECOVERY_ACTIONS: RecoveryAction[] = [
  "return_to_top",
  "show_latest",
  "clear_filters",
  "dismiss",
];

export interface RecoveryBucket {
  label: string;
  /** Inclusive lower bound in ms. */
  from: number;
  /** Exclusive upper bound in ms, null = open ended. */
  to: number | null;
  count: number;
}

export interface RecoveryActionStat {
  action: RecoveryAction;
  count: number;
  timedCount: number;
  medianMs: number | null;
  p90Ms: number | null;
  avgMs: number | null;
}

export interface DepositRecoveryStats {
  days: number;
  total: number;
  byAction: RecoveryActionStat[];
  histogram: RecoveryBucket[];
  overall: { medianMs: number | null; p90Ms: number | null; avgMs: number | null };
  recent: {
    id: string;
    action: RecoveryAction;
    eventId: string | null;
    reason: string | null;
    msSinceMiss: number | null;
    occurredAt: string;
  }[];
}

const BUCKETS: { label: string; from: number; to: number | null }[] = [
  { label: "< 1s", from: 0, to: 1000 },
  { label: "1–3s", from: 1000, to: 3000 },
  { label: "3–5s", from: 3000, to: 5000 },
  { label: "5–10s", from: 5000, to: 10000 },
  { label: "10–30s", from: 10000, to: 30000 },
  { label: "30s+", from: 30000, to: null },
];

function percentile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx] ?? null;
}

function summarize(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  return {
    medianMs: percentile(sorted, 50),
    p90Ms: percentile(sorted, 90),
    avgMs: sorted.length ? Math.round(sorted.reduce((a, b) => a + b, 0) / sorted.length) : null,
  };
}

/** Persist a recovery action so the operator analytics page has queryable data. */
export const recordDepositJumpRecovery = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(
    (input: {
      action: RecoveryAction;
      quoteId: string | null;
      eventId: string | null;
      reason: string | null;
      msSinceMiss: number | null;
    }) => {
      if (!RECOVERY_ACTIONS.includes(input.action)) throw new Error("Invalid action");
      const ms =
        typeof input.msSinceMiss === "number" && Number.isFinite(input.msSinceMiss)
          ? Math.max(0, Math.min(3_600_000, Math.round(input.msSinceMiss)))
          : null;
      const trim = (v: string | null, max: number) =>
        typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null;
      return {
        action: input.action,
        quoteId: trim(input.quoteId, 64),
        eventId: trim(input.eventId, 128),
        reason: trim(input.reason, 128),
        msSinceMiss: ms,
      };
    },
  )
  .handler(async ({ data, context }) => {
    const { error } = await context.supabase.from("deposit_jump_recovery_events").insert({
      user_id: context.userId,
      quote_id: data.quoteId,
      event_id: data.eventId,
      reason: data.reason,
      action: data.action,
      ms_since_miss: data.msSinceMiss,
    });
    if (error) throw new Error(error.message);
    return { ok: true };
  });

/** Operator-only aggregate view of recovery actions and hesitation timings. */
export const getDepositRecoveryStats = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { days?: number } | undefined) => ({
    days: Math.max(1, Math.min(365, Math.round(input?.days ?? 30))),
  }))
  .handler(async ({ data, context }): Promise<DepositRecoveryStats> => {
    const { supabase } = context;

    const { data: isAdmin, error: roleErr } = await supabase.rpc("has_role", { _role: "admin" });
    if (roleErr) throw new Error(roleErr.message);
    if (!isAdmin) throw new Error("Forbidden");

    const { recordAdminAccess, checkAdminRateLimit } = await import("@/lib/admin-audit.server");
    const rate = await checkAdminRateLimit(context.userId, "getDepositRecoveryStats");
    if (!rate.allowed) {
      await recordAdminAccess({
        actorUserId: context.userId,
        functionName: "getDepositRecoveryStats",
        outcome: "rate_limited",
        detail: `${rate.recentCalls} calls in the last 60s (limit ${rate.limit})`,
      });
      throw new Error(
        `Rate limit exceeded: ${rate.limit} calls/minute for getDepositRecoveryStats. Try again in a minute.`,
      );
    }

    const since = new Date(Date.now() - data.days * 24 * 60 * 60 * 1000).toISOString();
    const { data: rows, error } = await supabase
      .from("deposit_jump_recovery_events")
      .select("id, action, event_id, reason, ms_since_miss, occurred_at")
      .gte("occurred_at", since)
      .order("occurred_at", { ascending: false })
      .limit(5000);
    if (error) throw new Error(error.message);

    const all = rows ?? [];

    const byAction: RecoveryActionStat[] = RECOVERY_ACTIONS.map((action) => {
      const subset = all.filter((r) => r.action === action);
      const timed = subset
        .map((r) => r.ms_since_miss)
        .filter((v): v is number => typeof v === "number");
      return { action, count: subset.length, timedCount: timed.length, ...summarize(timed) };
    });

    const timedAll = all
      .map((r) => r.ms_since_miss)
      .filter((v): v is number => typeof v === "number");

    const histogram: RecoveryBucket[] = BUCKETS.map((b) => ({
      ...b,
      count: timedAll.filter((v) => v >= b.from && (b.to === null || v < b.to)).length,
    }));

    await recordAdminAccess({
      actorUserId: context.userId,
      functionName: "getDepositRecoveryStats",
      outcome: "allowed",
      rowCount: all.length,
      detail: `${data.days}d window`,
    });

    return {
      days: data.days,
      total: all.length,
      byAction,
      histogram,
      overall: summarize(timedAll),
      recent: all.slice(0, 25).map((r) => ({
        id: r.id,
        action: r.action as RecoveryAction,
        eventId: r.event_id,
        reason: r.reason,
        msSinceMiss: r.ms_since_miss,
        occurredAt: r.occurred_at,
      })),
    };
  });
