import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

export type CheckState = "pass" | "warn" | "fail";

export interface CheckItem {
  id: string;
  label: string;
  state: CheckState;
  detail: string;
}

export interface WebhookCheckResult {
  ranAt: string;
  overall: CheckState;
  phoneNumber: string | null;
  expectedSmsUrl: string;
  expectedVoiceUrl: string;
  checks: CheckItem[];
}

const INBOUND_ACTIONS = ["sms_inbound"];
const MISSED_CALL_ACTIONS = [
  "missed_call_autotext",
  "missed_call_excluded",
  "missed_call_text",
  "voicemail_recorded",
];

function ago(iso: string) {
  const mins = Math.floor((Date.now() - new Date(iso).getTime()) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 48) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

/**
 * Lightweight, read-only verification that inbound Twilio traffic can reach us:
 * number wiring in Twilio, live reachability of the public endpoints, and whether
 * any real inbound events have actually landed in the dispatch log.
 */
export const runWebhookCheck = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }): Promise<WebhookCheckResult> => {
    const { supabase, userId } = context;
    const { INBOUND_SMS_URL, INBOUND_VOICE_URL, fetchNumberWebhookConfig } = await import("./twilio.server");

    const checks: CheckItem[] = [];

    const { data: prof } = await supabase
      .from("profiles").select("twilio_phone_number").eq("id", userId).maybeSingle();
    const phoneNumber = prof?.twilio_phone_number ?? null;

    // 1. Number provisioned
    checks.push(
      phoneNumber
        ? { id: "number", label: "Temaro number provisioned", state: "pass", detail: phoneNumber }
        : { id: "number", label: "Temaro number provisioned", state: "fail", detail: "No number on this account yet — run onboarding to provision one." },
    );

    // 2. Twilio-side webhook wiring
    if (phoneNumber) {
      try {
        const cfg = await fetchNumberWebhookConfig(phoneNumber);
        if (!cfg.found) {
          checks.push({ id: "wiring", label: "Twilio webhook wiring", state: "fail", detail: "Twilio has no record of this number under the connected account." });
        } else {
          const smsOk = cfg.smsUrl === INBOUND_SMS_URL;
          const voiceOk = cfg.voiceUrl === INBOUND_VOICE_URL;
          checks.push({
            id: "sms_wiring",
            label: "Inbound SMS webhook URL",
            state: smsOk ? "pass" : "fail",
            detail: smsOk
              ? `${cfg.smsMethod ?? "POST"} → ${cfg.smsUrl}`
              : `Twilio points at ${cfg.smsUrl ?? "(unset)"} — expected ${INBOUND_SMS_URL}`,
          });
          checks.push({
            id: "voice_wiring",
            label: "Missed-call (voice) webhook URL",
            state: voiceOk ? "pass" : "fail",
            detail: voiceOk
              ? `${cfg.voiceMethod ?? "POST"} → ${cfg.voiceUrl}`
              : `Twilio points at ${cfg.voiceUrl ?? "(unset)"} — expected ${INBOUND_VOICE_URL}`,
          });
        }
      } catch (e) {
        checks.push({
          id: "wiring",
          label: "Twilio webhook wiring",
          state: "warn",
          detail: `Could not read config from Twilio: ${e instanceof Error ? e.message : String(e)}`,
        });
      }
    }

    // 3. Endpoint reachability. An unsigned POST must be rejected with 403 by the
    //    signature check — that proves the route is live AND validating signatures.
    for (const [id, label, url] of [
      ["reach_sms", "SMS endpoint reachable", INBOUND_SMS_URL],
      ["reach_voice", "Voice endpoint reachable", INBOUND_VOICE_URL],
    ] as const) {
      try {
        const res = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: "TemaroWebhookCheck=1",
        });
        if (res.status === 403) {
          checks.push({ id, label, state: "pass", detail: "Live — unsigned probe correctly rejected (403), signature validation active." });
        } else if (res.status >= 500) {
          checks.push({ id, label, state: "fail", detail: `Endpoint returned ${res.status}.` });
        } else {
          checks.push({ id, label, state: "warn", detail: `Endpoint answered ${res.status} to an unsigned probe — expected 403.` });
        }
      } catch (e) {
        checks.push({ id, label, state: "fail", detail: `Unreachable: ${e instanceof Error ? e.message : String(e)}` });
      }
    }

    // 4. Real traffic actually landing
    const [{ data: lastSms }, { data: lastCall }] = await Promise.all([
      supabase.from("logs").select("created_at, action_type")
        .eq("user_id", userId).in("action_type", INBOUND_ACTIONS)
        .order("created_at", { ascending: false }).limit(1).maybeSingle(),
      supabase.from("logs").select("created_at, action_type")
        .eq("user_id", userId).in("action_type", MISSED_CALL_ACTIONS)
        .order("created_at", { ascending: false }).limit(1).maybeSingle(),
    ]);

    checks.push({
      id: "traffic_sms",
      label: "Inbound SMS events received",
      state: lastSms ? "pass" : "warn",
      detail: lastSms
        ? `Last inbound text ${ago(lastSms.created_at)} (${new Date(lastSms.created_at).toLocaleString()}).`
        : "No inbound texts logged yet. Text your Temaro number to confirm end-to-end.",
    });
    checks.push({
      id: "traffic_calls",
      label: "Missed-call events received",
      state: lastCall ? "pass" : "warn",
      detail: lastCall
        ? `Last call event ${ago(lastCall.created_at)} — ${lastCall.action_type} (${new Date(lastCall.created_at).toLocaleString()}).`
        : "No call events logged yet. Call your Temaro number and hang up to confirm end-to-end.",
    });

    const overall: CheckState = checks.some((c) => c.state === "fail")
      ? "fail"
      : checks.some((c) => c.state === "warn")
        ? "warn"
        : "pass";

    return {
      ranAt: new Date().toISOString(),
      overall,
      phoneNumber,
      expectedSmsUrl: INBOUND_SMS_URL,
      expectedVoiceUrl: INBOUND_VOICE_URL,
      checks,
    };
  });
