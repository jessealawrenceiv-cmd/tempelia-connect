import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import {
  OPT_IN_PROMPT_ACTION,
  OPT_IN_PROMPT_COOLDOWN_MINUTES,
  buildOptInPrompt,
} from "./opt-in-prompt";

function validate(data: unknown): { customerId: string } {
  const { customerId } = (data ?? {}) as { customerId?: unknown };
  if (typeof customerId !== "string" || customerId.length < 8) throw new Error("Invalid customerId");
  return { customerId };
}

function normalizePhone(p: string | null | undefined): string {
  return (p || "").replace(/\D+/g, "");
}

/** Send (or re-send) the compliant opt-in prompt to a missed-call caller. */
export const sendOptInPrompt = createServerFn({ method: "POST" })
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
    if (cust.opt_in_consent) throw new Error("This contact is already opted in.");

    const { data: excluded } = await supabase
      .from("excluded_numbers")
      .select("phone_number")
      .eq("user_id", userId);
    const digits = normalizePhone(cust.phone_number);
    if ((excluded ?? []).some((r) => normalizePhone(r.phone_number) === digits)) {
      throw new Error("This number is on your exclusion list.");
    }

    const since = new Date(Date.now() - OPT_IN_PROMPT_COOLDOWN_MINUTES * 60_000).toISOString();
    const { data: recent } = await supabase
      .from("logs")
      .select("id, created_at")
      .eq("customer_id", cust.id)
      .eq("action_type", OPT_IN_PROMPT_ACTION)
      .gte("created_at", since)
      .limit(1)
      .maybeSingle();
    if (recent) {
      throw new Error(
        `An opt-in prompt was already sent in the last ${OPT_IN_PROMPT_COOLDOWN_MINUTES} minutes.`,
      );
    }

    const { data: prof } = await supabase
      .from("profiles")
      .select("business_name, twilio_phone_number")
      .eq("id", userId)
      .maybeSingle();
    const from = prof?.twilio_phone_number;
    if (!from) throw new Error("Provision your Temaro number in Settings before sending.");

    const body = buildOptInPrompt(prof?.business_name ?? "");
    try {
      const res = await sendTwilioSms(from, cust.phone_number, body);
      await supabase.from("logs").insert({
        user_id: userId,
        customer_id: cust.id,
        action_type: OPT_IN_PROMPT_ACTION,
        message_sent: body,
        status: "sent",
        twilio_message_sid: res.sid,
      });
      return { ok: true as const, sid: res.sid };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      await supabase.from("logs").insert({
        user_id: userId,
        customer_id: cust.id,
        action_type: OPT_IN_PROMPT_ACTION,
        message_sent: body,
        status: "failed",
      });
      throw new Error(`Send failed — ${msg}`);
    }
  });
