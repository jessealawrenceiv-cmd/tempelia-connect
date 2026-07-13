// Twilio inbound Voice webhook — when a caller reaches a tenant's Tempelia number,
// respond with a short greeting (and optionally a voicemail prompt) and fire off
// an auto-text from the same number. Routing: look up the tenant by the To number.
import { createFileRoute } from "@tanstack/react-router";
import { PROJECT_PUBLIC_BASE } from "@/lib/twilio.server";

function twiml(body: string) {
  const xml = `<?xml version="1.0" encoding="UTF-8"?><Response>${body}</Response>`;
  return new Response(xml, { status: 200, headers: { "Content-Type": "text/xml" } });
}

function xmlEscape(s: string) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export const Route = createFileRoute("/api/public/twilio/voice")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const { verifyTwilioRequest } = await import("@/lib/twilio-verify.server");
        const { ok, form } = await verifyTwilioRequest(request);
        if (!ok) return new Response("Forbidden", { status: 403 });
        const from = String(form.get("From") ?? "").trim();
        const to = String(form.get("To") ?? "").trim();
        const callSid = String(form.get("CallSid") ?? "");
        if (!from || !to) {
          return twiml("<Say>Sorry, this line is not configured.</Say><Hangup/>");
        }

        const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
        const { data: tenant } = await supabaseAdmin
          .from("profiles")
          .select("id, business_name, twilio_phone_number, voicemail_enabled, owner_phone")
          .eq("twilio_phone_number", to)
          .maybeSingle();

        if (!tenant) {
          return twiml("<Say>Sorry, this line is not configured.</Say><Hangup/>");
        }

        // Check exclusion list — skip auto-text if caller is excluded
        const { data: excluded } = await supabaseAdmin
          .from("excluded_numbers")
          .select("id, label")
          .eq("user_id", tenant.id)
          .eq("phone_number", from)
          .maybeSingle();

        if (excluded) {
          await supabaseAdmin.from("logs").insert({
            user_id: tenant.id,
            action_type: "missed_call_excluded",
            status: "skipped",
            call_sid: callSid || null,
            message_sent: `Caller ${from} on exclusion list${excluded.label ? ` (${excluded.label})` : ""} — auto-text skipped.`,
          });
          return twiml(
            `<Say voice="alice">Thanks for calling ${xmlEscape(tenant.business_name || "our team")}. We can't come to the phone right now. Please try again later.</Say><Hangup/>`,
          );
        }

        const biz = tenant.business_name || "our team";
        let logId: string | null = null;

        // Fire the auto-text before returning the TwiML. The caller hears the
        // greeting while their phone buzzes with the follow-up.
        try {
          const { sendTwilioSms, STOP_SUFFIX } = await import("@/lib/twilio.server");
          const text = `Thanks for calling ${biz}! Sorry we missed you — reply here and we'll get right back to you.${STOP_SUFFIX}`;
          const res = await sendTwilioSms(tenant.twilio_phone_number!, from, text);

          // Upsert a lightweight customer row so future messages have context.
          const { data: existing } = await supabaseAdmin
            .from("customers").select("id")
            .eq("user_id", tenant.id).eq("phone_number", from).maybeSingle();
          let customerId = existing?.id ?? null;
          if (!existing) {
            const { data: inserted } = await supabaseAdmin.from("customers").insert({
              user_id: tenant.id,
              phone_number: from,
              first_name: "",
              opt_in_consent: false,
            }).select("id").maybeSingle();
            customerId = inserted?.id ?? null;
          }
          const { data: inserted } = await supabaseAdmin.from("logs").insert({
            user_id: tenant.id,
            customer_id: customerId,
            action_type: "missed_call_autotext",
            status: "sent",
            message_sent: text,
            twilio_message_sid: res.sid,
            call_sid: callSid || null,
          }).select("id").maybeSingle();
          logId = inserted?.id ?? null;
        } catch (e) {
          const { data: inserted } = await supabaseAdmin.from("logs").insert({
            user_id: tenant.id,
            action_type: "missed_call_autotext",
            status: "failed",
            message_sent: `Call ${callSid}: ${(e as Error).message}`,
            call_sid: callSid || null,
          }).select("id").maybeSingle();
          logId = inserted?.id ?? null;
        }

        // Voicemail branch: prompt the caller and record, then hang up.
        if (tenant.voicemail_enabled) {
          const cbUrl = `${PROJECT_PUBLIC_BASE}/api/public/twilio/recording${logId ? `?log_id=${encodeURIComponent(logId)}` : ""}`;
          return twiml(
            `<Say voice="alice">Thanks for calling ${xmlEscape(biz)}. We can't come to the phone right now — we've just texted you. Please leave a message after the tone, or wait for a text from us.</Say>` +
              `<Record maxLength="120" playBeep="true" trim="trim-silence" finishOnKey="#" ` +
              `recordingStatusCallback="${xmlEscape(cbUrl)}" recordingStatusCallbackMethod="POST" ` +
              `recordingStatusCallbackEvent="completed"/>` +
              `<Say voice="alice">Thanks. Goodbye.</Say><Hangup/>`,
          );
        }

        return twiml(
          `<Say voice="alice">Thanks for calling ${xmlEscape(biz)}. We can't come to the phone right now, but we've just texted you — reply there and we'll be right with you.</Say><Hangup/>`,
        );
      },
    },
  },
});
