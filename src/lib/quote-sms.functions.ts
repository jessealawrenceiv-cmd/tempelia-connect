import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { z } from "zod";

// Guard window against accidental double-sends.
const DOUBLE_SEND_COOLDOWN_MIN = 5;

const inputSchema = z.object({
  quoteId: z.string().uuid(),
  force: z.boolean().optional().default(false),
});

// Stable public URL for the quote link in the SMS body. Uses the same
// immutable project host as the Twilio webhook base.
import { PROJECT_PUBLIC_BASE } from "./twilio.server";

export const sendQuoteSms = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => inputSchema.parse(d))
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    const { sendTwilioSms, STOP_SUFFIX } = await import("./twilio.server");

    const { data: q, error: qErr } = await supabase
      .from("quotes")
      .select(
        "id, status, customer_first_name, customer_phone, valid_until, last_sms_sent_at, customer_id",
      )
      .eq("id", data.quoteId)
      .maybeSingle();
    if (qErr) throw new Error(qErr.message);
    if (!q) throw new Error("Quote not found");

    if (q.status === "archived" || q.status === "accepted" || q.status === "declined") {
      throw new Error(`Cannot send — quote is ${q.status}.`);
    }
    if (!q.customer_phone) throw new Error("Quote has no customer phone number.");

    // Cooldown safeguard against accidental double-sends.
    if (!data.force && q.last_sms_sent_at) {
      const ageMs = Date.now() - new Date(q.last_sms_sent_at).getTime();
      if (ageMs < DOUBLE_SEND_COOLDOWN_MIN * 60_000) {
        return {
          ok: false as const,
          reason: "cooldown" as const,
          lastSentAt: q.last_sms_sent_at,
          minutesAgo: Math.max(1, Math.round(ageMs / 60_000)),
        };
      }
    }

    const { data: prof } = await supabase
      .from("profiles")
      .select("business_name, twilio_phone_number")
      .eq("id", userId)
      .maybeSingle();
    const biz = prof?.business_name || "our team";
    const from = prof?.twilio_phone_number;
    if (!from) throw new Error("Provision your Temora number in Settings before sending.");

    const link = `${PROJECT_PUBLIC_BASE}/quote/${q.id}`;
    const validLine = q.valid_until
      ? ` Valid until ${new Date(q.valid_until).toLocaleDateString("en-US")}.`
      : "";
    const message = `Hi ${q.customer_first_name || "there"}, here's your quote from ${biz}: ${link}.${validLine}${STOP_SUFFIX}`;

    try {
      const res = await sendTwilioSms(from, q.customer_phone, message);
      const nowIso = new Date().toISOString();

      // Flip draft → sent so status flow stays consistent. Non-draft (already
      // "sent") just refreshes last_sms_sent_at.
      const updates: { last_sms_sent_at: string; status?: string } = { last_sms_sent_at: nowIso };
      if (q.status === "draft" || q.status === "expired") updates.status = "sent";
      await supabase.from("quotes").update(updates).eq("id", q.id);

      await supabase.from("logs").insert({
        user_id: userId,
        customer_id: q.customer_id,
        action_type: "quote_sms",
        message_sent: message,
        status: "sent",
        twilio_message_sid: res.sid,
      });
      return { ok: true as const, sid: res.sid, sentAt: nowIso };
    } catch (e) {
      await supabase.from("logs").insert({
        user_id: userId,
        customer_id: q.customer_id,
        action_type: "quote_sms",
        message_sent: message,
        status: "failed",
      });
      throw e;
    }
  });
