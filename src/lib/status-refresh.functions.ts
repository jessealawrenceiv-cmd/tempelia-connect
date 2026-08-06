import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

/**
 * Server-side single-run lock for the automation status re-evaluation.
 *
 * Every refresh request (manual click, retry, auto-interval tick, another
 * device, or a duplicated request in flight) has to claim the per-business
 * lock row first. The claim is a single atomic INSERT ... ON CONFLICT DO
 * UPDATE ... WHERE (released OR stale), so only one caller can ever win —
 * concurrent callers get `skipped: "in_progress"` and do no work at all.
 */

export interface StatusRefreshResult {
  /** True when this caller owned the lock and the re-evaluation ran. */
  ran: boolean;
  /** Set when another run already held the lock. */
  skipped?: "in_progress";
  runId?: string;
  /** Fingerprint of the automation-status inputs, evaluated on the server. */
  snapshot?: string;
  evaluatedAt: string;
}

const LOCK_TTL_SECONDS = 60;

function fingerprint(row: Record<string, unknown> | null): string {
  return JSON.stringify({
    decline_followup_mode: row?.["decline_followup_mode"] ?? "off",
    voicemail_enabled: row?.["voicemail_enabled"] ?? null,
    review_auto_enabled: row?.["review_auto_enabled"] ?? null,
    opt_in_prompt_template: row?.["opt_in_prompt_template"] ?? null,
    opt_in_prompt_cooldown_minutes: row?.["opt_in_prompt_cooldown_minutes"] ?? null,
  });
}

export const runStatusRefresh = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { trigger?: "manual" | "auto" } | undefined) => ({
    trigger: input?.trigger === "auto" ? ("auto" as const) : ("manual" as const),
  }))
  .handler(async ({ context }): Promise<StatusRefreshResult> => {
    const { supabase, userId } = context;

    const { data: runId, error: lockError } = await supabase.rpc("status_refresh_try_lock", {
      _ttl_seconds: LOCK_TTL_SECONDS,
    });
    if (lockError) throw new Error(lockError.message);
    if (!runId) {
      return { ran: false, skipped: "in_progress", evaluatedAt: new Date().toISOString() };
    }

    try {
      const { data: profile, error } = await supabase
        .from("profiles")
        .select("*")
        .eq("id", userId)
        .maybeSingle();
      if (error) throw new Error(error.message);

      const result: StatusRefreshResult = {
        ran: true,
        runId,
        snapshot: fingerprint(profile as Record<string, unknown> | null),
        evaluatedAt: new Date().toISOString(),
      };
      await supabase.rpc("status_refresh_release", { _run_id: runId, _result: "ok" });
      return result;
    } catch (e) {
      await supabase.rpc("status_refresh_release", {
        _run_id: runId,
        _result: `error: ${(e as Error)?.message ?? "unknown"}`.slice(0, 200),
      });
      throw e;
    }
  });
