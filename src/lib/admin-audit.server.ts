// Server-only audit trail + throttle for cross-tenant admin tools.
// Rows are written with the service-role client so the log cannot be
// tampered with by the caller (RLS grants admins read-only visibility).

export const ADMIN_RATE_LIMIT_PER_MINUTE = 20;

export async function recordAdminAccess(params: {
  actorUserId: string;
  functionName: string;
  rowCount?: number | null;
  outcome: "allowed" | "rate_limited" | "forbidden";
  detail?: string | null;
}): Promise<void> {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { error } = await supabaseAdmin.from("admin_access_log").insert({
    actor_user_id: params.actorUserId,
    function_name: params.functionName,
    row_count: params.rowCount ?? null,
    outcome: params.outcome,
    detail: params.detail ?? null,
  });
  if (error) console.error("[admin-audit] failed to record access:", error.message);
}

/**
 * Counts this actor's calls to `functionName` in the trailing 60 seconds.
 * Rate-limited attempts are logged too, so a client hammering the endpoint
 * stays blocked for the remainder of the window instead of slipping through.
 */
export async function checkAdminRateLimit(
  actorUserId: string,
  functionName: string,
): Promise<{ allowed: boolean; recentCalls: number; limit: number }> {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const since = new Date(Date.now() - 60_000).toISOString();
  const { count, error } = await supabaseAdmin
    .from("admin_access_log")
    .select("id", { count: "exact", head: true })
    .eq("actor_user_id", actorUserId)
    .eq("function_name", functionName)
    .gte("occurred_at", since);
  if (error) throw new Error(error.message);
  const recentCalls = count ?? 0;
  return {
    allowed: recentCalls < ADMIN_RATE_LIMIT_PER_MINUTE,
    recentCalls,
    limit: ADMIN_RATE_LIMIT_PER_MINUTE,
  };
}
