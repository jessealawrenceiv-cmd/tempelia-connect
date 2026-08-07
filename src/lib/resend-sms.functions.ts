import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { RESENDABLE_STATUSES, OUTBOUND_LOG_TYPES } from "./resend-sms";
import { insertLog, assertLogActionType } from "@/lib/log-action-types";

function validate(data: unknown): { customerId: string } {
  const { customerId } = (data ?? {}) as { customerId?: unknown };
  if (typeof customerId !== "string" || customerId.length < 8) throw new Error("Invalid customerId");
  return { customerId };
}

function normalizePhone(p: string | null | undefined): string {
  return (p || "").replace(/\D+/g, "");
}

/**
 * Re-send the most recent outbound SMS for a customer when the original
 * Twilio attempt failed or was never confirmed as delivered.
 */
export const resendLastMessage = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(validate)
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    const { sendTwilioSms } = await import("./twilio.server");

    const { data: cust, error: custErr } = await supabase
      .from("customers")
      .select("id, phone_number, opt_in_consent")
      .eq("id", data.customerId)
      .maybeSingle();
    if (custErr) throw new Error(custErr.message);
    if (!cust) throw new Error("Customer not found");
    if (!cust.opt_in_consent) throw new Error("This contact is not opted in to SMS.");

    const { data: last, error: logErr } = await supabase
      .from("logs")
      .select("id, action_type, status, message_sent, twilio_message_sid, created_at")
      .eq("customer_id", cust.id)
      .in("action_type", OUTBOUND_LOG_TYPES)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (logErr) throw new Error(logErr.message);
    if (!last) throw new Error("No outbound message on file to resend.");
    if (!last.message_sent) throw new Error("The last message has no recorded body to resend.");

    const unconfirmed = RESENDABLE_STATUSES.includes(last.status) || !last.twilio_message_sid;
    if (!unconfirmed) {
      throw new Error(`Last message is ${last.status} — nothing to resend.`);
    }

    const { data: excluded } = await supabase
      .from("excluded_numbers")
      .select("phone_number")
      .eq("user_id", userId);
    const digits = normalizePhone(cust.phone_number);
    if ((excluded ?? []).some((r) => normalizePhone(r.phone_number) === digits)) {
      throw new Error("This number is on your exclusion list.");
    }

    const { data: prof } = await supabase
      .from("profiles")
      .select("twilio_phone_number")
      .eq("id", userId)
      .maybeSingle();
    const from = prof?.twilio_phone_number;
    if (!from) throw new Error("Provision your Temaro number in Settings before sending.");

    try {
      const res = await sendTwilioSms(from, cust.phone_number, last.message_sent);
      await insertLog(supabase, {
        user_id: userId,
        customer_id: cust.id,
        action_type: assertLogActionType(last.action_type),
        message_sent: last.message_sent,
        status: "sent",
        twilio_message_sid: res.sid,
      });
      return { ok: true as const, sid: res.sid, actionType: last.action_type };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      await insertLog(supabase, {
        user_id: userId,
        customer_id: cust.id,
        action_type: assertLogActionType(last.action_type),
        message_sent: last.message_sent,
        status: "failed",
      });
      throw new Error(`Resend failed — ${msg}`);
    }
  });
