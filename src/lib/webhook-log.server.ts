// Records every inbound Twilio webhook hit (missed call, inbound SMS, recording
// callback) with its raw payload and the signature-validation outcome, so the
// dashboard can stream a live webhook event log.
//
// Never throws: webhook handlers must keep working even if logging fails.

const REDACTED_KEYS = new Set(["AccountSid", "ApiVersion"]);

/** Turn Twilio's form body into a plain JSON object for the payload column. */
export function formToPayload(form: FormData): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of form.entries()) {
    if (REDACTED_KEYS.has(k)) {
      out[k] = "[redacted]";
      continue;
    }
    out[k] = String(v);
  }
  return out;
}

/**
 * Records the hit and returns the `webhook_events` row id so the caller can
 * correlate it with the Activity log entry the hit produces. Returns null when
 * logging failed — correlation is best-effort and never blocks the webhook.
 */
export async function recordWebhookEvent(args: {
  request: Request;
  form: FormData;
  signatureValid: boolean;
  eventKind: "missed_call" | "sms_inbound" | "recording_status";
  source?: string;
}): Promise<string | null> {
  try {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const form = args.form;
    const to = String(form.get("To") ?? form.get("Called") ?? "").trim() || null;
    const from = String(form.get("From") ?? "").trim() || null;

    // Attribute the hit to a tenant by the receiving number when possible;
    // unroutable hits stay unattributed and are visible to platform admins.
    let userId: string | null = null;
    if (to) {
      const { data } = await supabaseAdmin
        .from("profiles")
        .select("id")
        .eq("twilio_phone_number", to)
        .maybeSingle();
      userId = data?.id ?? null;
    }

    const hasSignature = Boolean(args.request.headers.get("x-twilio-signature"));
    const detail = args.signatureValid
      ? "HMAC-SHA1 signature verified"
      : hasSignature
        ? "Signature present but did not match — request rejected"
        : "No X-Twilio-Signature header — request rejected";

    await supabaseAdmin.from("webhook_events").insert({
      user_id: userId,
      source: args.source ?? "twilio",
      event_kind: args.eventKind,
      from_number: from,
      to_number: to,
      signature_valid: args.signatureValid,
      signature_detail: detail,
      payload: formToPayload(form),
      request_path: new URL(args.request.url).pathname,
    });

    // Opportunistic retention trim (30 days).
    if (Math.random() < 0.05) await supabaseAdmin.rpc("webhook_events_prune");
  } catch (e) {
    console.error("recordWebhookEvent failed:", e);
  }
}
