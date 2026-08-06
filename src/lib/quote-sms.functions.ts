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
import { insertLog } from "@/lib/log-action-types";

export const sendQuoteSms = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => inputSchema.parse(d))
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    const { sendTwilioSms, STOP_SUFFIX } = await import("./twilio.server");

    const { data: q, error: qErr } = await supabase
      .from("quotes")
      .select(
        "id, status, customer_first_name, customer_phone, valid_until, last_sms_sent_at, customer_id, total_amount, deposit_required, deposit_amount",
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
    if (!from) throw new Error("Provision your Temaro number in Settings before sending.");

    const { buildQuoteSmsBody } = await import("./quote-sms-body");
    const { message } = buildQuoteSmsBody({
      firstName: q.customer_first_name,
      businessName: biz,
      quoteId: q.id,
      validUntil: q.valid_until,
      total: q.total_amount,
      depositRequired: q.deposit_required,
      depositAmount: q.deposit_amount,
      publicBase: PROJECT_PUBLIC_BASE,
      stopSuffix: STOP_SUFFIX,
    });


    try {
      const res = await sendTwilioSms(from, q.customer_phone, message);
      const nowIso = new Date().toISOString();

      // Flip draft → sent so status flow stays consistent. Non-draft (already
      // "sent") just refreshes last_sms_sent_at.
      const updates: { last_sms_sent_at: string; status?: string } = { last_sms_sent_at: nowIso };
      if (q.status === "draft" || q.status === "expired") updates.status = "sent";
      await supabase.from("quotes").update(updates).eq("id", q.id);

      await insertLog(supabase, {
        user_id: userId,
        customer_id: q.customer_id,
        action_type: "quote_sms",
        message_sent: message,
        status: "sent",
        twilio_message_sid: res.sid,
      });
      return { ok: true as const, sid: res.sid, sentAt: nowIso };
    } catch (e) {
      await insertLog(supabase, {
        user_id: userId,
        customer_id: q.customer_id,
        action_type: "quote_sms",
        message_sent: message,
        status: "failed",
      });
      throw e;
    }
  });

/**
 * Deposit SMS preview — builds the exact outbound body (same builder the real
 * send uses) without contacting Twilio and without touching the quote.
 */
export const previewQuoteSms = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({ quoteId: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    const { STOP_SUFFIX } = await import("./twilio.server");
    const { buildQuoteSmsBody, smsSegmentDetail } = await import("./quote-sms-body");

    const { data: q, error: qErr } = await supabase
      .from("quotes")
      .select(
        "id, status, customer_first_name, customer_phone, valid_until, last_sms_sent_at, total_amount, deposit_required, deposit_amount, deposit_paid",
      )
      .eq("id", data.quoteId)
      .maybeSingle();
    if (qErr) throw new Error(qErr.message);
    if (!q) throw new Error("Quote not found");

    const { data: prof } = await supabase
      .from("profiles")
      .select("business_name, twilio_phone_number")
      .eq("id", userId)
      .maybeSingle();
    const biz = prof?.business_name || "our team";

    const { message, link, depositLine } = buildQuoteSmsBody({
      firstName: q.customer_first_name,
      businessName: biz,
      quoteId: q.id,
      validUntil: q.valid_until,
      total: q.total_amount,
      depositRequired: q.deposit_required,
      depositAmount: q.deposit_amount,
      publicBase: PROJECT_PUBLIC_BASE,
      stopSuffix: STOP_SUFFIX,
    });
    const counts = smsSegmentDetail(message);

    let cooldownMinutesLeft = 0;
    if (q.last_sms_sent_at) {
      const ageMin = (Date.now() - new Date(q.last_sms_sent_at).getTime()) / 60_000;
      cooldownMinutesLeft = Math.max(0, Math.ceil(DOUBLE_SEND_COOLDOWN_MIN - ageMin));
    }

    const sendable =
      !!prof?.twilio_phone_number &&
      !!q.customer_phone &&
      !["archived", "accepted", "declined"].includes(q.status);

    const blockedReasons: string[] = [];
    if (!prof?.twilio_phone_number) blockedReasons.push("no Temaro number provisioned");
    if (!q.customer_phone) blockedReasons.push("quote has no customer phone");
    if (["archived", "accepted", "declined"].includes(q.status))
      blockedReasons.push(`quote is ${q.status}`);
    if (cooldownMinutesLeft > 0)
      blockedReasons.push(`double-send cooldown: ${cooldownMinutesLeft}m left`);

    return {
      message,
      link,
      depositLine,
      businessName: biz,
      fromNumber: prof?.twilio_phone_number ?? null,
      toNumber: q.customer_phone ?? null,
      status: q.status,
      chars: counts.chars,
      segments: counts.segments,
      unicode: counts.unicode,
      encoding: counts.encoding,
      segmentCapacity: counts.segmentCapacity,
      charsUntilNextSegment: counts.charsUntilNextSegment,
      nonAsciiChars: counts.nonAsciiChars,
      validUntil: q.valid_until ?? null,
      depositRequired: !!q.deposit_required,
      depositPaid: !!q.deposit_paid,
      totalAmount: Number(q.total_amount ?? 0),
      depositAmount: Number(q.deposit_amount ?? 0),
      generatedAt: new Date().toISOString(),
      blockedReasons,
      lastSentAt: q.last_sms_sent_at,
      cooldownMinutesLeft,
      sendable,
    };
  });
