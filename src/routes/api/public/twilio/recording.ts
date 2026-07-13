// Twilio recording-status callback: fired when the caller's voicemail
// finishes uploading. We attach the recording URL to the matching missed-call
// log row and text the business owner if they've set an owner_phone.
import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/api/public/twilio/recording")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const { verifyTwilioRequest } = await import("@/lib/twilio-verify.server");
        const { ok, form } = await verifyTwilioRequest(request);
        if (!ok) return new Response("Forbidden", { status: 403 });

        const url = new URL(request.url);
        const logId = url.searchParams.get("log_id");
        const recordingUrl = String(form.get("RecordingUrl") ?? "").trim();
        const recordingSid = String(form.get("RecordingSid") ?? "").trim();
        const callSid = String(form.get("CallSid") ?? "").trim();
        const status = String(form.get("RecordingStatus") ?? "").trim();
        const from = String(form.get("From") ?? "").trim();
        const called = String(form.get("Called") ?? form.get("To") ?? "").trim();
        const durationStr = String(form.get("RecordingDuration") ?? "0");

        if (status !== "completed" || !recordingUrl) {
          return new Response("ok");
        }

        const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

        // Find the matching log row (prefer logId query param, fall back to call_sid).
        let logRow: { id: string; user_id: string; customer_id: string | null } | null = null;
        if (logId) {
          const { data } = await supabaseAdmin
            .from("logs").select("id, user_id, customer_id").eq("id", logId).maybeSingle();
          logRow = data ?? null;
        }
        if (!logRow && callSid) {
          const { data } = await supabaseAdmin
            .from("logs").select("id, user_id, customer_id")
            .eq("call_sid", callSid).order("created_at", { ascending: false }).limit(1).maybeSingle();
          logRow = data ?? null;
        }

        // Play-back URL: append .mp3 so the Twilio-hosted recording streams as audio.
        const playbackUrl = recordingUrl.endsWith(".mp3") ? recordingUrl : `${recordingUrl}.mp3`;

        let tenantId: string | null = logRow?.user_id ?? null;
        if (logRow) {
          await supabaseAdmin.from("logs").update({
            voicemail_url: playbackUrl,
            recording_sid: recordingSid || null,
          }).eq("id", logRow.id);
        } else {
          // No prior log — synthesize a bare voicemail row so it still shows up.
          const { data: tenant } = await supabaseAdmin
            .from("profiles").select("id").eq("twilio_phone_number", called).maybeSingle();
          if (tenant) {
            tenantId = tenant.id;
            await supabaseAdmin.from("logs").insert({
              user_id: tenant.id,
              action_type: "missed_call_autotext",
              status: "sent",
              message_sent: `Voicemail received from ${from}.`,
              voicemail_url: playbackUrl,
              recording_sid: recordingSid || null,
              call_sid: callSid || null,
            });
          }
        }

        // Notify the business owner via SMS if owner_phone is set.
        if (tenantId) {
          const { data: profile } = await supabaseAdmin
            .from("profiles")
            .select("owner_phone, twilio_phone_number, business_name")
            .eq("id", tenantId)
            .maybeSingle();

          if (profile?.owner_phone && profile.twilio_phone_number) {
            try {
              const { sendTwilioSms } = await import("@/lib/twilio.server");
              const body = `Voicemail from ${from} (${durationStr}s): ${playbackUrl}`;
              const res = await sendTwilioSms(profile.twilio_phone_number, profile.owner_phone, body);
              await supabaseAdmin.from("logs").insert({
                user_id: tenantId,
                action_type: "voicemail_notify",
                status: "sent",
                message_sent: body,
                twilio_message_sid: res.sid,
                call_sid: callSid || null,
                voicemail_url: playbackUrl,
              });
            } catch (e) {
              await supabaseAdmin.from("logs").insert({
                user_id: tenantId,
                action_type: "voicemail_notify",
                status: "failed",
                message_sent: `Owner notify failed: ${(e as Error).message}`,
                call_sid: callSid || null,
                voicemail_url: playbackUrl,
              });
            }
          }
        }

        return new Response("ok");
      },
    },
  },
});
