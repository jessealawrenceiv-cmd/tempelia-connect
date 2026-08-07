import { LogAction } from "./log-action-types.generated";
import { assertLogActionFilters } from "./log-action-filter.server";
// Server-only: proof-of-inbound-engagement check for the opt-in prompt.
//
// PERMANENT RULE: the manual opt-in prompt may only be sent to a contact who
// genuinely reached out to this business first. Eligibility is a real query
// against `logs` (inbound-originated activity for this customer) and
// `webhook_events` (raw inbound Twilio payloads from this phone number).
// A CSV-imported contact with no inbound history can never satisfy it.

type Client = { from: (t: string) => any };

/** logs.action_type values that only ever exist because the contact reached out. */
export const INBOUND_ENGAGEMENT_ACTIONS = [
  LogAction.sms_inbound,
  LogAction.missed_call_autotext,
  LogAction.missed_call_text,
  LogAction.missed_call_excluded,
  LogAction.voicemail_notify,
  LogAction.quote_decline_reason_captured,
] as const;

/** webhook_events.event_kind values that represent a real inbound contact. */
export const INBOUND_WEBHOOK_KINDS = ["sms_inbound", "missed_call"] as const;

export const NO_ENGAGEMENT_MESSAGE =
  "No inbound call or text from this contact is on record, so an opt-in prompt can never be sent to them. Only people who contacted you first are eligible.";

function digitsOf(p: string | null | undefined): string {
  return (p || "").replace(/\D+/g, "");
}

export type EngagementCheck =
  | { ok: true; evidence: "logs" | "webhook_events" }
  | { ok: false; reason: string };

/**
 * Returns ok only when there is a persisted inbound engagement row tying this
 * contact (by customer_id, or by phone number on the raw webhook payloads) to
 * this business.
 */
export async function checkInboundEngagement(
  supabase: Client,
  userId: string,
  customer: { id: string; phone_number: string | null },
): Promise<EngagementCheck> {
  const { data: logRow, error: logErr } = await supabase
    .from("logs")
    .select("id")
    .eq("user_id", userId)
    .eq("customer_id", customer.id)
    .in("action_type", assertLogActionFilters("inbound_engagement.logs", INBOUND_ENGAGEMENT_ACTIONS))
    .limit(1)
    .maybeSingle();
  if (logErr) return { ok: false, reason: logErr.message };
  if (logRow) return { ok: true, evidence: "logs" };

  const digits = digitsOf(customer.phone_number);
  if (digits.length >= 10) {
    const last10 = digits.slice(-10);
    const { data: hooks, error: hookErr } = await supabase
      .from("webhook_events")
      .select("id, from_number")
      .eq("user_id", userId)
      .in("event_kind", INBOUND_WEBHOOK_KINDS as unknown as string[])
      .eq("signature_valid", true)
      .limit(500);
    if (hookErr) return { ok: false, reason: hookErr.message };
    const match = (hooks ?? []).some(
      (h: { from_number: string | null }) => digitsOf(h.from_number).slice(-10) === last10,
    );
    if (match) return { ok: true, evidence: "webhook_events" };
  }

  return { ok: false, reason: NO_ENGAGEMENT_MESSAGE };
}
