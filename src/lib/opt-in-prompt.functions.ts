import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import {
  OPT_IN_PROMPT_ACTION,
  OPT_IN_PROMPT_COOLDOWN_MINUTES,
  buildOptInPrompt,
  clampCooldownMinutes,
  promptVersionHash,
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

    const { data: prof } = await supabase
      .from("profiles")
      .select("business_name, twilio_phone_number, opt_in_prompt_template, opt_in_prompt_cooldown_minutes")
      .eq("id", userId)
      .maybeSingle();
    const cooldown = clampCooldownMinutes(
      prof?.opt_in_prompt_cooldown_minutes ?? OPT_IN_PROMPT_COOLDOWN_MINUTES,
    );

    const since = new Date(Date.now() - cooldown * 60_000).toISOString();
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
        `An opt-in prompt was already sent in the last ${cooldown} minutes.`,
      );
    }

    const from = prof?.twilio_phone_number;
    if (!from) throw new Error("Provision your Temaro number in Settings before sending.");

    const body = buildOptInPrompt(prof?.business_name ?? "", prof?.opt_in_prompt_template ?? null);
    try {
      const res = await sendTwilioSms(from, cust.phone_number, body);
      await supabase.from("logs").insert({
        user_id: userId,
        customer_id: cust.id,
        action_type: OPT_IN_PROMPT_ACTION,
        message_sent: body,
        status: "sent",
        twilio_message_sid: res.sid,
        prompt_template: prof?.opt_in_prompt_template ?? null,
        prompt_template_hash: promptVersionHash(body),
        prompt_cooldown_minutes: cooldown,
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
        prompt_template: prof?.opt_in_prompt_template ?? null,
        prompt_template_hash: promptVersionHash(body),
        prompt_cooldown_minutes: cooldown,
      });
      throw new Error(`Send failed — ${msg}`);
    }
  });

function validateBatch(data: unknown): { customerIds: string[] } {
  const { customerIds } = (data ?? {}) as { customerIds?: unknown };
  if (!Array.isArray(customerIds) || customerIds.length === 0) {
    throw new Error("Select at least one contact");
  }
  if (customerIds.length > 50) throw new Error("Select at most 50 contacts at a time");
  const ids = customerIds.filter((v): v is string => typeof v === "string" && v.length >= 8);
  if (ids.length !== customerIds.length) throw new Error("Invalid customerId in selection");
  return { customerIds: Array.from(new Set(ids)) };
}

/** Bulk send: one prompt per selected contact, each independently enforced. */
export const sendOptInPromptBatch = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(validateBatch)
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    const { loadPromptContext, sendPromptToCustomer } = await import("./opt-in-prompt.server");
    const { profile, excludedDigits } = await loadPromptContext(supabase as never, userId);

    const results = [] as Awaited<ReturnType<typeof sendPromptToCustomer>>[];
    for (const id of data.customerIds) {
      results.push(
        await sendPromptToCustomer(supabase as never, userId, id, profile, excludedDigits),
      );
    }
    return {
      sent: results.filter((r) => r.ok).length,
      failed: results.filter((r) => !r.ok).length,
      results,
    };
  });

/**
 * Send the currently-saved opt-in prompt to the owner's own mobile number so
 * they can verify the template and cooldown for real. Restricted to the
 * profile's `owner_phone` (no arbitrary destinations) and rate-limited by the
 * same configured cooldown as real sends.
 */
export const sendTestOptInPrompt = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { phone?: string } | undefined) => ({
    phone: typeof input?.phone === "string" ? input.phone.trim() : "",
  }))
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    const { sendTwilioSms } = await import("./twilio.server");
    const { OPT_IN_PROMPT_TEST_ACTION } = await import("./opt-in-prompt");

    const { data: prof } = await supabase
      .from("profiles")
      .select(
        "business_name, twilio_phone_number, owner_phone, opt_in_prompt_template, opt_in_prompt_cooldown_minutes",
      )
      .eq("id", userId)
      .maybeSingle();

    // Custom test recipient wins; fall back to the owner mobile on file.
    let to = (data.phone || prof?.owner_phone || "").trim();
    if (!to) {
      throw new Error("Enter a test phone number, or add your owner mobile in Settings first.");
    }
    const digits = normalizePhone(to);
    if (digits.length < 10 || digits.length > 15) {
      throw new Error(`"${to}" is not a valid phone number. Use a 10-digit US number or E.164.`);
    }
    to = digits.length === 10 ? `+1${digits}` : `+${digits}`;

    const { data: excluded } = await supabase
      .from("excluded_numbers")
      .select("phone_number")
      .eq("user_id", userId);
    if ((excluded ?? []).some((r) => normalizePhone(r.phone_number) === digits)) {
      throw new Error("That number is on your excluded list — remove it first to test against it.");
    }

    const from = prof?.twilio_phone_number;
    if (!from) throw new Error("Provision your Temaro number before sending a test.");

    const cooldown = clampCooldownMinutes(
      prof?.opt_in_prompt_cooldown_minutes ?? OPT_IN_PROMPT_COOLDOWN_MINUTES,
    );
    const since = new Date(Date.now() - cooldown * 60_000).toISOString();
    const { data: recent } = await supabase
      .from("logs")
      .select("created_at")
      .eq("user_id", userId)
      .eq("action_type", OPT_IN_PROMPT_TEST_ACTION)
      .gte("created_at", since)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (recent) {
      const waitMin = Math.max(
        1,
        cooldown - Math.floor((Date.now() - new Date(recent.created_at).getTime()) / 60_000),
      );
      throw new Error(
        `Cooldown active — a test was sent in the last ${cooldown} min. Try again in ${waitMin} min.`,
      );
    }

    const body = buildOptInPrompt(prof?.business_name ?? "", prof?.opt_in_prompt_template ?? null);
    try {
      const res = await sendTwilioSms(from, to, body);
      await supabase.from("logs").insert({
        user_id: userId,
        action_type: OPT_IN_PROMPT_TEST_ACTION,
        message_sent: body,
        status: "sent",
        twilio_message_sid: res.sid,
        prompt_template: prof?.opt_in_prompt_template ?? null,
        prompt_template_hash: promptVersionHash(body),
        prompt_cooldown_minutes: cooldown,
      });
      return { ok: true as const, to, sid: res.sid, status: res.status, body, cooldown };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      await supabase.from("logs").insert({
        user_id: userId,
        action_type: OPT_IN_PROMPT_TEST_ACTION,
        message_sent: body,
        status: "failed",
        prompt_template: prof?.opt_in_prompt_template ?? null,
        prompt_template_hash: promptVersionHash(body),
        prompt_cooldown_minutes: cooldown,
      });
      throw new Error(`Send failed — ${msg}`);
    }
  });

/**
 * Poll Twilio for the delivery state of a test SMS this owner sent.
 * The SID must appear in this owner's own logs, so nobody can inspect
 * another account's messages.
 */
export const getTestSmsStatus = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { sid: string }) => {
    const sid = String(input?.sid ?? "").trim();
    if (!/^SM[0-9a-zA-Z]{10,}$/.test(sid)) throw new Error("Invalid message SID.");
    return { sid };
  })
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    const { data: owned } = await supabase
      .from("logs")
      .select("id")
      .eq("user_id", userId)
      .eq("twilio_message_sid", data.sid)
      .limit(1)
      .maybeSingle();
    if (!owned) throw new Error("That message was not sent from this account.");

    const { fetchTwilioMessage } = await import("./twilio.server");
    const m = await fetchTwilioMessage(data.sid);
    return {
      sid: m.sid,
      status: m.status,
      errorCode: m.errorCode,
      errorMessage: m.errorMessage,
      to: m.to,
      dateSent: m.dateSent,
    };
  });
