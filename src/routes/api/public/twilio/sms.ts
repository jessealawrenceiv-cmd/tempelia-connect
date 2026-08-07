// Twilio inbound SMS webhook — routes by the To number to a specific tenant.
// Twilio POSTs application/x-www-form-urlencoded.
import { createFileRoute } from "@tanstack/react-router";
import { insertLog, LogAction, logDedupeKey } from "@/lib/log-action-types";

function twiml(body: string) {
  const xml = `<?xml version="1.0" encoding="UTF-8"?><Response>${body}</Response>`;
  return new Response(xml, { status: 200, headers: { "Content-Type": "text/xml" } });
}

function escapeXml(s: string) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

const STOP_KEYWORDS = new Set(["STOP", "STOPALL", "UNSUBSCRIBE", "CANCEL", "END", "QUIT"]);
const START_KEYWORDS = new Set(["START", "YES", "UNSTOP"]);

export const Route = createFileRoute("/api/public/twilio/sms")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const { verifyTwilioRequest } = await import("@/lib/twilio-verify.server");
        const { ok, form } = await verifyTwilioRequest(request);
        const { recordWebhookEvent } = await import("@/lib/webhook-log.server");
        await recordWebhookEvent({ request, form, signatureValid: ok, eventKind: "sms_inbound" });
        if (!ok) return new Response("Forbidden", { status: 403 });

        // Idempotency: a redelivered MessageSid must not flip consent twice,
        // re-capture a decline reason, or add a second sms_inbound log row.
        const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
        const { claimWebhookDelivery, completeWebhookDelivery, duplicateResponse, twilioDeliveryKey } =
          await import("@/lib/webhook-idempotency.server");
        const deliveryKey = twilioDeliveryKey("sms_inbound", form);
        const claim = await claimWebhookDelivery(supabaseAdmin, {
          source: "twilio",
          eventKind: "sms_inbound",
          deliveryKey,
        });
        if (claim.duplicate) return duplicateResponse(claim, "twiml");

        let deliveryTenantId: string | null = null;
        const run = async (): Promise<Response> => {
        const from = String(form.get("From") ?? "").trim();
        const to = String(form.get("To") ?? "").trim();
        const body = String(form.get("Body") ?? "").trim();
        const messageSid = String(form.get("MessageSid") ?? "");
        if (!from || !to) return twiml("");

        const keyword = body.toUpperCase().split(/\s+/)[0] ?? "";

        // Resolve tenant by the number that received the SMS.
        const { data: tenant } = await supabaseAdmin
          .from("profiles").select("id, business_name").eq("twilio_phone_number", to).maybeSingle();
        if (!tenant) return twiml("");
        deliveryTenantId = tenant.id;

        // Find (or none) the customer row for this caller under this tenant.
        const { data: cust } = await supabaseAdmin
          .from("customers").select("id")
          .eq("user_id", tenant.id).eq("phone_number", from).maybeSingle();

        const consentRow = (action: "opt_in" | "opt_out") => ({
          user_id: tenant.id,
          customer_id: cust?.id ?? null,
          phone_number: from,
          keyword,
          action,
          message_body: body || null,
          twilio_message_sid: messageSid || null,
        });

        // Dedupe key: keyed on the provider MessageSid, so a redelivery of this
        // SMS can never add a second row even if the delivery claim failed open.
        const logRow = (status: string) => ({
          user_id: tenant.id,
          customer_id: cust?.id ?? null,
          action_type: LogAction.sms_inbound,
          status,
          message_sent: body,
          twilio_message_sid: messageSid || null,
          dedupe_key: logDedupeKey(deliveryKey, LogAction.sms_inbound, status),
        });

        if (STOP_KEYWORDS.has(keyword)) {
          if (cust) {
            await supabaseAdmin.from("customers").update({ opt_in_consent: false }).eq("id", cust.id);
          }
          await supabaseAdmin.from("sms_consent_events").insert(consentRow("opt_out"));
          await insertLog(supabaseAdmin, logRow("opted_out"));
          return twiml("<Message>You've been unsubscribed. Reply START to resume.</Message>");
        }

        if (START_KEYWORDS.has(keyword)) {
          if (cust) {
            await supabaseAdmin.from("customers").update({ opt_in_consent: true }).eq("id", cust.id);
          }
          await supabaseAdmin.from("sms_consent_events").insert(consentRow("opt_in"));
          await insertLog(supabaseAdmin, logRow("opted_in"));
          const name = escapeXml(tenant.business_name || "Temaro");
          return twiml(
            `<Message>${name}: You're opted back in to receive recurring text messages regarding your inquiry, appointment updates, and reviews. Message frequency varies. Message and data rates may apply. Reply STOP to unsubscribe.</Message>`,
          );
        }

        // Check for a pending decline-follow-up on this number.
        // If a phone has multiple pending (rare — same contractor sent multiple
        // declined quotes to the same number without a reply between them),
        // capture on the most recently sent one.
        const { data: pendingQuote } = await supabaseAdmin
          .from("quotes")
          .select("id, customer_id")
          .eq("user_id", tenant.id)
          .eq("customer_phone", from)
          .not("decline_followup_sent_at", "is", null)
          .is("decline_reason", null)
          .order("decline_followup_sent_at", { ascending: false })
          .limit(1)
          .maybeSingle();

        if (pendingQuote) {
          await supabaseAdmin
            .from("quotes")
            .update({ decline_reason: body })
            .eq("id", pendingQuote.id);
          await insertLog(supabaseAdmin, {
            user_id: tenant.id,
            customer_id: pendingQuote.customer_id ?? cust?.id ?? null,
            action_type: LogAction.quote_decline_reason_captured,
            status: "captured",
            message_sent: body,
            twilio_message_sid: messageSid || null,
            dedupe_key: logDedupeKey(deliveryKey, LogAction.quote_decline_reason_captured),
          });
          return twiml("<Message>Thanks — we've passed that along.</Message>");
        }

        await insertLog(supabaseAdmin, logRow("received"));
        return twiml("");
        };

        const response = await run();
        return completeWebhookDelivery(supabaseAdmin, {
          deliveryId: claim.deliveryId,
          userId: deliveryTenantId,
          response,
        });
      },
    },
  },
});
