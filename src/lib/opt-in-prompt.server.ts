// Server-only helper shared by the single and bulk opt-in prompt server fns.
import {
  OPT_IN_PROMPT_ACTION,
  OPT_IN_PROMPT_COOLDOWN_MINUTES,
  buildOptInPrompt,
  clampCooldownMinutes,
  promptVersionHash,
} from "./opt-in-prompt";

type Client = { from: (t: string) => any };

function normalizePhone(p: string | null | undefined): string {
  return (p || "").replace(/\D+/g, "");
}

export type PromptResult =
  | { customerId: string; ok: true; sid: string | null; phone: string | null }
  | { customerId: string; ok: false; error: string; phone: string | null };

/**
 * Sends the compliant opt-in prompt to one customer, enforcing opt-in state,
 * the exclusion list, and the per-customer cooldown. Never throws — returns a
 * per-customer result so batches can report successes vs failures.
 */
export async function sendPromptToCustomer(
  supabase: Client,
  userId: string,
  customerId: string,
  profile: {
    business_name: string | null;
    twilio_phone_number: string | null;
    opt_in_prompt_template?: string | null;
    opt_in_prompt_cooldown_minutes?: number | null;
  },
  excludedDigits: Set<string>,
): Promise<PromptResult> {
  const fail = (error: string, phone: string | null = null): PromptResult => ({
    customerId,
    ok: false,
    error,
    phone,
  });

  const { data: cust, error: custErr } = await supabase
    .from("customers")
    .select("id, phone_number, opt_in_consent")
    .eq("id", customerId)
    .maybeSingle();
  if (custErr) return fail(custErr.message);
  if (!cust) return fail("Customer not found");
  if (cust.opt_in_consent) return fail("Already opted in", cust.phone_number);

  if (excludedDigits.has(normalizePhone(cust.phone_number))) {
    return fail("On your exclusion list", cust.phone_number);
  }

  const cooldown = clampCooldownMinutes(
    profile.opt_in_prompt_cooldown_minutes ?? OPT_IN_PROMPT_COOLDOWN_MINUTES,
  );
  const since = new Date(Date.now() - cooldown * 60_000).toISOString();
  const { data: recent } = await supabase
    .from("logs")
    .select("id")
    .eq("customer_id", cust.id)
    .eq("action_type", OPT_IN_PROMPT_ACTION)
    .gte("created_at", since)
    .limit(1)
    .maybeSingle();
  if (recent) {
    return fail(`Cooldown — prompted in the last ${cooldown} min`, cust.phone_number);
  }

  const from = profile.twilio_phone_number;
  if (!from) return fail("No Temaro number provisioned", cust.phone_number);

  const body = buildOptInPrompt(profile.business_name ?? "", profile.opt_in_prompt_template ?? null);
  const { sendTwilioSms } = await import("./twilio.server");
  try {
    const res = await sendTwilioSms(from, cust.phone_number, body);
    await supabase.from("logs").insert({
      user_id: userId,
      customer_id: cust.id,
      action_type: OPT_IN_PROMPT_ACTION,
      message_sent: body,
      status: "sent",
      twilio_message_sid: res.sid,
      prompt_template: profile.opt_in_prompt_template ?? null,
      prompt_template_hash: promptVersionHash(body),
      prompt_cooldown_minutes: cooldown,
    });
    return { customerId, ok: true, sid: res.sid ?? null, phone: cust.phone_number };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await supabase.from("logs").insert({
      user_id: userId,
      customer_id: cust.id,
      action_type: OPT_IN_PROMPT_ACTION,
      message_sent: body,
      status: "failed",
      prompt_template: profile.opt_in_prompt_template ?? null,
      prompt_template_hash: promptVersionHash(body),
      prompt_cooldown_minutes: cooldown,
    });
    return fail(`Send failed — ${msg}`, cust.phone_number);
  }
}

/** Load the profile + exclusion digits once per batch. */
export async function loadPromptContext(supabase: Client, userId: string) {
  const { data: prof } = await supabase
    .from("profiles")
    .select("business_name, twilio_phone_number, opt_in_prompt_template, opt_in_prompt_cooldown_minutes")
    .eq("id", userId)
    .maybeSingle();
  const { data: excluded } = await supabase
    .from("excluded_numbers")
    .select("phone_number")
    .eq("user_id", userId);
  const digits = new Set<string>(
    (excluded ?? []).map((r: { phone_number: string }) => normalizePhone(r.phone_number)),
  );
  return {
    profile: {
      business_name: prof?.business_name ?? null,
      twilio_phone_number: prof?.twilio_phone_number ?? null,
      opt_in_prompt_template: prof?.opt_in_prompt_template ?? null,
      opt_in_prompt_cooldown_minutes: prof?.opt_in_prompt_cooldown_minutes ?? null,
    },
    excludedDigits: digits,
  };
}
