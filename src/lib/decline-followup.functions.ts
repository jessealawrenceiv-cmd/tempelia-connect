import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { z } from "zod";

const DECLINE_FOLLOWUP_BODY =
  "Sorry we didn't win this one — mind letting us know why? Just reply and let us know.";

export const sendDeclineFollowup = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({ quoteId: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    const { sendTwilioSms, STOP_SUFFIX } = await import("./twilio.server");

    const { data: q, error } = await supabase
      .from("quotes")
      .select("id, status, customer_phone, customer_id, decline_followup_sent_at")
      .eq("id", data.quoteId)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!q) throw new Error("Quote not found");
    if (q.status !== "declined") throw new Error(`Quote is ${q.status}, not declined.`);
    if (q.decline_followup_sent_at) throw new Error("Follow-up already sent.");
    if (!q.customer_phone) throw new Error("No customer phone on quote.");

    const { data: prof } = await supabase
      .from("profiles").select("twilio_phone_number").eq("id", userId).maybeSingle();
    const from = prof?.twilio_phone_number;
    if (!from) throw new Error("Provision your Temora number in Settings first.");

    const message = DECLINE_FOLLOWUP_BODY + STOP_SUFFIX;
    try {
      const res = await sendTwilioSms(from, q.customer_phone, message);
      const nowIso = new Date().toISOString();
      await supabase.from("quotes").update({ decline_followup_sent_at: nowIso }).eq("id", q.id);
      await supabase.from("logs").insert({
        user_id: userId,
        customer_id: q.customer_id,
        action_type: "quote_decline_followup",
        message_sent: message,
        status: "sent",
        twilio_message_sid: res.sid,
      });
      return { ok: true as const, sid: res.sid, sentAt: nowIso };
    } catch (e) {
      await supabase.from("logs").insert({
        user_id: userId,
        customer_id: q.customer_id,
        action_type: "quote_decline_followup",
        message_sent: message,
        status: "failed",
      });
      throw e;
    }
  });

// Called server-side (no auth) when the public quote page marks declined and mode=auto.
export async function maybeAutoSendDeclineFollowup(quoteId: string): Promise<void> {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { sendTwilioSms, STOP_SUFFIX } = await import("./twilio.server");

  const { data: q } = await supabaseAdmin
    .from("quotes")
    .select("id, user_id, status, customer_phone, customer_id, decline_followup_sent_at")
    .eq("id", quoteId)
    .maybeSingle();
  if (!q || q.status !== "declined" || q.decline_followup_sent_at || !q.customer_phone) return;

  const { data: prof } = await supabaseAdmin
    .from("profiles")
    .select("decline_followup_mode, twilio_phone_number")
    .eq("id", q.user_id)
    .maybeSingle();
  if (!prof || prof.decline_followup_mode !== "auto" || !prof.twilio_phone_number) return;

  const message = DECLINE_FOLLOWUP_BODY + STOP_SUFFIX;
  try {
    const res = await sendTwilioSms(prof.twilio_phone_number, q.customer_phone, message);
    const nowIso = new Date().toISOString();
    await supabaseAdmin.from("quotes").update({ decline_followup_sent_at: nowIso }).eq("id", q.id);
    await supabaseAdmin.from("logs").insert({
      user_id: q.user_id,
      customer_id: q.customer_id,
      action_type: "quote_decline_followup",
      message_sent: message,
      status: "sent",
      twilio_message_sid: res.sid,
    });
  } catch {
    await supabaseAdmin.from("logs").insert({
      user_id: q.user_id,
      customer_id: q.customer_id,
      action_type: "quote_decline_followup",
      message_sent: message,
      status: "failed",
    });
  }
}
