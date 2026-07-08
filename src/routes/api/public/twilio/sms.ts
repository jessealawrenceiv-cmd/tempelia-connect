// Twilio inbound SMS webhook — routes by the To number to a specific tenant.
// Twilio POSTs application/x-www-form-urlencoded.
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
        const to = String(form.get("To") ?? "").trim();
        const body = String(form.get("Body") ?? "").trim();
        const messageSid = String(form.get("MessageSid") ?? "");
        if (!from || !to) return twiml("");

        const keyword = body.toUpperCase().split(/\s+/)[0] ?? "";
        const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

        // Resolve tenant by the number that received the SMS.
        const { data: tenant } = await supabaseAdmin
          .from("profiles").select("id").eq("twilio_phone_number", to).maybeSingle();
        if (!tenant) return twiml("");

        // Find (or none) the customer row for this caller under this tenant.
        const { data: cust } = await supabaseAdmin
          .from("customers").select("id")
          .eq("user_id", tenant.id).eq("phone_number", from).maybeSingle();

        const logRow = (status: string) => ({
          user_id: tenant.id,
          customer_id: cust?.id ?? null,
          action_type: "sms_inbound",
          status,
          message_sent: body,
          twilio_message_sid: messageSid || null,
        });

        if (STOP_KEYWORDS.has(keyword)) {
          if (cust) {
            await supabaseAdmin.from("customers").update({ opt_in_consent: false }).eq("id", cust.id);
          }
          await supabaseAdmin.from("logs").insert(logRow("opted_out"));
          return twiml("<Message>You've been unsubscribed. Reply START to resume.</Message>");
        }

        if (START_KEYWORDS.has(keyword)) {
          if (cust) {
            await supabaseAdmin.from("customers").update({ opt_in_consent: true }).eq("id", cust.id);
          }
          await supabaseAdmin.from("logs").insert(logRow("opted_in"));
          return twiml("<Message>You're re-subscribed. Reply STOP anytime to unsubscribe.</Message>");
        }

        await supabaseAdmin.from("logs").insert(logRow("received"));
        return twiml("");
      },
    },
  },
});
