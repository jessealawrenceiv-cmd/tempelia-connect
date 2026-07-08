// Twilio inbound SMS webhook — handles STOP/START opt-out compliance on the shared number.
// Twilio POSTs application/x-www-form-urlencoded. We match by From phone across all tenants'
// customers (a person who texts STOP is opted out for every business they're a customer of).
import { createFileRoute } from "@tanstack/react-router";

function twiml(body: string) {
  const xml = `<?xml version="1.0" encoding="UTF-8"?><Response>${body}</Response>`;
  return new Response(xml, { status: 200, headers: { "Content-Type": "text/xml" } });
}

const STOP_KEYWORDS = new Set(["STOP", "STOPALL", "UNSUBSCRIBE", "CANCEL", "END", "QUIT"]);
const START_KEYWORDS = new Set(["START", "YES", "UNSTOP"]);

export const Route = createFileRoute("/api/public/twilio/sms")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const form = await request.formData();
        const from = String(form.get("From") ?? "").trim();
        const body = String(form.get("Body") ?? "").trim();
        const messageSid = String(form.get("MessageSid") ?? "");
        if (!from) return twiml("");

        const keyword = body.toUpperCase().split(/\s+/)[0] ?? "";
        const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

        // Find every customer row matching this phone across all tenants.
        const { data: matches } = await supabaseAdmin
          .from("customers").select("id, user_id").eq("phone_number", from);
        const rows = matches ?? [];

        if (STOP_KEYWORDS.has(keyword)) {
          if (rows.length) {
            await supabaseAdmin.from("customers").update({ opt_in_consent: false })
              .in("id", rows.map((r) => r.id));
            for (const r of rows) {
              await supabaseAdmin.from("logs").insert({
                user_id: r.user_id, customer_id: r.id, action_type: "sms_inbound",
                status: "opted_out", message_sent: body, twilio_message_sid: messageSid || null,
              });
            }
          }
          return twiml("<Message>You've been unsubscribed. Reply START to resume.</Message>");
        }

        if (START_KEYWORDS.has(keyword)) {
          if (rows.length) {
            await supabaseAdmin.from("customers").update({ opt_in_consent: true })
              .in("id", rows.map((r) => r.id));
            for (const r of rows) {
              await supabaseAdmin.from("logs").insert({
                user_id: r.user_id, customer_id: r.id, action_type: "sms_inbound",
                status: "opted_in", message_sent: body, twilio_message_sid: messageSid || null,
              });
            }
          }
          return twiml("<Message>You're re-subscribed. Reply STOP anytime to unsubscribe.</Message>");
        }

        // Non-keyword inbound: just log against known tenants; no auto-reply.
        for (const r of rows) {
          await supabaseAdmin.from("logs").insert({
            user_id: r.user_id, customer_id: r.id, action_type: "sms_inbound",
            status: "received", message_sent: body, twilio_message_sid: messageSid || null,
          });
        }
        return twiml("");
      },
    },
  },
});
