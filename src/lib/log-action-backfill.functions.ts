import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { LOG_ACTION_TYPES } from "@/lib/log-action-types";
import { isBackfillable, type BackfillResult } from "@/lib/log-action-backfill";

/**
 * One-click, admin-only reconciliation/backfill for a single business and a
 * single action type. Delegates the actual writes to the scoped SECURITY
 * DEFINER routine so the insert rules stay identical to the hourly cron job.
 */
export const runActionTypeBackfill = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { businessId: string; actionType: string }) => {
    const businessId = String(input?.businessId ?? "").trim();
    const actionType = String(input?.actionType ?? "").trim();
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(businessId)) {
      throw new Error("businessId must be a UUID");
    }
    if (!(LOG_ACTION_TYPES as readonly string[]).includes(actionType)) {
      throw new Error(`Unknown action_type: ${actionType}`);
    }
    return { businessId, actionType };
  })
  .handler(async ({ data, context }): Promise<BackfillResult> => {
    const { supabase, userId } = context;

    const { data: isAdmin, error: roleErr } = await supabase.rpc("has_role", { _role: "admin" });
    if (roleErr) throw new Error(roleErr.message);
    if (!isAdmin) throw new Error("Forbidden");

    const { recordAdminAccess, checkAdminRateLimit } = await import("@/lib/admin-audit.server");
    const rate = await checkAdminRateLimit(userId, "runActionTypeBackfill");
    if (!rate.allowed) {
      await recordAdminAccess({
        actorUserId: userId,
        functionName: "runActionTypeBackfill",
        outcome: "rate_limited",
        detail: `${rate.recentCalls} calls in the last 60s (limit ${rate.limit})`,
      });
      throw new Error(
        `Rate limit exceeded: ${rate.limit} calls/minute for runActionTypeBackfill. Try again in a minute.`,
      );
    }

    if (!isBackfillable(data.actionType)) {
      await recordAdminAccess({
        actorUserId: userId,
        functionName: "runActionTypeBackfill",
        rowCount: 0,
        outcome: "allowed",
        detail: `${data.actionType} for ${data.businessId}: no backfill source`,
      });
      return {
        runId: null,
        actionType: data.actionType,
        businessId: data.businessId,
        insertedCount: 0,
        durationMs: 0,
        supported: false,
        detail:
          "No backfill source exists for this action type — entries are only written live by the app.",
        finishedAt: new Date().toISOString(),
      };
    }

    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data: rows, error } = await supabaseAdmin.rpc("reconcile_activity_logs_scoped", {
      _user_id: data.businessId,
      _action_type: data.actionType,
      _triggered_by: userId,
    });
    if (error) {
      await recordAdminAccess({
        actorUserId: userId,
        functionName: "runActionTypeBackfill",
        outcome: "allowed",
        detail: `${data.actionType} for ${data.businessId}: failed — ${error.message}`,
      });
      throw new Error(error.message);
    }

    const row = (Array.isArray(rows) ? rows[0] : rows) as
      | {
          run_id: string | null;
          inserted_count: number | null;
          duration_ms: number | null;
          supported: boolean | null;
          detail: string | null;
        }
      | undefined;

    const insertedCount = row?.inserted_count ?? 0;

    await recordAdminAccess({
      actorUserId: userId,
      functionName: "runActionTypeBackfill",
      rowCount: insertedCount,
      outcome: "allowed",
      detail: `${data.actionType} for ${data.businessId}: inserted ${insertedCount}`,
    });

    return {
      runId: row?.run_id ?? null,
      actionType: data.actionType,
      businessId: data.businessId,
      insertedCount,
      durationMs: row?.duration_ms ?? 0,
      supported: row?.supported ?? true,
      detail: row?.detail ?? "",
      finishedAt: new Date().toISOString(),
    };
  });

export interface ScopedBackfillRun {
  id: string;
  ranAt: string;
  actionType: string | null;
  insertedCount: number;
  durationMs: number;
  detail: string | null;
}

/** Recent scoped backfill runs for one business, newest first. */
export const listScopedBackfillRuns = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { businessId: string }) => ({
    businessId: String(input?.businessId ?? "").trim(),
  }))
  .handler(async ({ data, context }): Promise<ScopedBackfillRun[]> => {
    const { supabase } = context;
    const { data: isAdmin, error: roleErr } = await supabase.rpc("has_role", { _role: "admin" });
    if (roleErr) throw new Error(roleErr.message);
    if (!isAdmin) throw new Error("Forbidden");

    const { data: rows, error } = await supabase
      .from("log_reconciliation_runs")
      .select(
        "id, ran_at, target_action_type, provisioned_inserted, sms_inbound_inserted, missed_call_inserted, duration_ms, detail",
      )
      .eq("scope", "scoped")
      .eq("target_user_id", data.businessId)
      .order("ran_at", { ascending: false })
      .limit(10);
    if (error) throw new Error(error.message);

    return (rows ?? []).map((r) => ({
      id: r.id,
      ranAt: r.ran_at,
      actionType: r.target_action_type ?? null,
      insertedCount:
        (r.provisioned_inserted ?? 0) + (r.sms_inbound_inserted ?? 0) + (r.missed_call_inserted ?? 0),
      durationMs: r.duration_ms ?? 0,
      detail: r.detail ?? null,
    }));
  });
