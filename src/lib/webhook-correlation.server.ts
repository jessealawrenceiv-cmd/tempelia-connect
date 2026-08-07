/**
 * Correlating inbound missed-call webhooks with the Activity log rows they
 * produce.
 *
 * A verified missed call must always leave a trace in the owner's Activity log:
 * an auto-text (`missed_call_autotext`), an exclusion note
 * (`missed_call_excluded`), or a voicemail notice. Until now nothing linked the
 * two, so a call whose processing silently produced no log row was invisible.
 *
 * The webhook handler now correlates inline — the happy path resolves within
 * the same request — and `flag_missed_call_correlation_failures()` runs every
 * 15 minutes to catch anything the handler could not close out, flagging it as
 * `missing` and writing a `webhook_delivery_status` / `correlation_missing`
 * entry into that business's Activity log.
 *
 * Every helper here is best-effort: correlation bookkeeping must never break
 * webhook processing or change the TwiML the caller hears.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";

type AdminClient = SupabaseClient<Database>;

/** Marks a webhook event as correlated with the Activity log row it produced. */
export async function markWebhookCorrelated(
  client: AdminClient,
  args: { eventId: string | null; logId: string | null; detail?: string },
): Promise<void> {
  if (!args.eventId || !args.logId) return;
  try {
    await client
      .from("webhook_events")
      .update({
        correlated_log_id: args.logId,
        correlation_state: "correlated",
        correlated_at: new Date().toISOString(),
        correlation_detail: args.detail ?? "Linked by the webhook handler that created the entry",
      })
      .eq("id", args.eventId);
  } catch (e) {
    console.error("markWebhookCorrelated failed", e);
  }
}

/**
 * Marks a webhook event as one that can never produce an Activity log row —
 * an unroutable number or a rejected signature — so the scheduled checker does
 * not flag it as a correlation failure.
 */
export async function markWebhookNotApplicable(
  client: AdminClient,
  args: { eventId: string | null; reason: string },
): Promise<void> {
  if (!args.eventId) return;
  try {
    await client
      .from("webhook_events")
      .update({
        correlation_state: "not_applicable",
        correlated_at: new Date().toISOString(),
        correlation_detail: args.reason,
      })
      .eq("id", args.eventId);
  } catch (e) {
    console.error("markWebhookNotApplicable failed", e);
  }
}

/**
 * Runs the correlation sweep now instead of waiting for the 15-minute cron:
 * links pending events, then flags anything past the grace period as missing.
 */
export async function runMissedCallCorrelationCheck(
  client: AdminClient,
  graceMinutes = 5,
): Promise<{ correlated: number; missing: number; notApplicable: number }> {
  const { data, error } = await client.rpc("flag_missed_call_correlation_failures", {
    _grace: `${Math.max(1, Math.round(graceMinutes))} minutes`,
  });
  if (error) throw error;
  const row = Array.isArray(data) ? data[0] : data;
  return {
    correlated: row?.correlated_count ?? 0,
    missing: row?.missing_count ?? 0,
    notApplicable: row?.not_applicable_count ?? 0,
  };
}
