// Twilio inbound Voice webhook — when a caller reaches a tenant's Tempelia number,
// answer with a short greeting and fire off an auto-text from the same number.
// Routing: look up the tenant by the To number.
import { createFileRoute } from "@tanstack/react-router";

function twiml(body: string) {
  const xml = `<?xml version="1.0" encoding="UTF-8"?><Response>${body}</Response>`;
  return new Response(xml, { status: 200, headers: { "Content-Type": "text/xml" } });
}

export const Route = createFileRoute("/api/public/twilio/voice")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const form = await request.formData();
        const from = String(form.get("From") ?? "").trim();
        const to = String(form.get("To") ?? "").trim();
        const callSid = String(form.get("CallSid") ?? "");
        if (!from || !to) {
          return twiml("<Say>Sorry, this line is not configured.</Say><Hangup/>");
        }

        const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
        const { data: tenant } = await supabaseAdmin
          .from("profiles")
          .select("id, business_name, twilio_phone_number")
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
            message_sent: `Caller ${from} on exclusion list${excluded.label ? ` (${excluded.label})` : ""} — auto-text skipped.`,
          });
          return twiml(
            `<Say voice="alice">Thanks for calling ${tenant.business_name || "our team"}. We can't come to the phone right now. Please try again later.</Say><Hangup/>`,
          );
        }


        const biz = tenant.business_name || "our team";

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
          const customerId = existing?.id ?? null;
          if (!existing) {
            const { data: inserted } = await supabaseAdmin.from("customers").insert({
              user_id: tenant.id,
              phone_number: from,
              first_name: "",
              opt_in_consent: false, // caller hasn't consented yet
            }).select("id").maybeSingle();
            await supabaseAdmin.from("logs").insert({
              user_id: tenant.id,
              customer_id: inserted?.id ?? null,
              action_type: "missed_call_autotext",
              status: "sent",
              message_sent: text,
              twilio_message_sid: res.sid,
            });
          } else {
            await supabaseAdmin.from("logs").insert({
              user_id: tenant.id,
              customer_id: customerId,
              action_type: "missed_call_autotext",
              status: "sent",
              message_sent: text,
              twilio_message_sid: res.sid,
            });
          }
        } catch (e) {
          await supabaseAdmin.from("logs").insert({
            user_id: tenant.id,
            action_type: "missed_call_autotext",
            status: "failed",
            message_sent: `Call ${callSid}: ${(e as Error).message}`,
          });
        }

        return twiml(
          `<Say voice="alice">Thanks for calling ${biz}. We can't come to the phone right now, but we've just texted you — reply there and we'll be right with you.</Say><Hangup/>`,
        );
      },
    },
  },
});
