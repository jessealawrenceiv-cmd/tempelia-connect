// Twilio recording-status callback: fired when the caller's voicemail
// finishes uploading. We attach the recording URL to the matching missed-call
// log row and text the business owner if they've set an owner_phone.
import { createFileRoute } from "@tanstack/react-router";
import { insertLog, LogAction, logDedupeKey } from "@/lib/log-action-types";
import { asDedupeConflict, dedupeConflictResponse } from "@/lib/log-dedupe-conflict-response";


export const Route = createFileRoute("/api/public/twilio/recording")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const { verifyTwilioRequest } = await import("@/lib/twilio-verify.server");
        const { ok, form } = await verifyTwilioRequest(request);
        const { recordWebhookEvent } = await import("@/lib/webhook-log.server");
        await recordWebhookEvent({ request, form, signatureValid: ok, eventKind: "recording_status" });
        if (!ok) return new Response("Forbidden", { status: 403 });

        // Idempotency: recording-status callbacks retry too; without this the
        // owner gets a second voicemail SMS and a duplicate voicemail_notify row.
        const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
        const { claimWebhookDelivery, completeWebhookDelivery, duplicateResponse, twilioDeliveryKey } =
          await import("@/lib/webhook-idempotency.server");
        const deliveryKey = twilioDeliveryKey("recording_status", form);
        const claim = await claimWebhookDelivery(supabaseAdmin, {
          source: "twilio",
          eventKind: "recording_status",
          deliveryKey,
        });
        if (claim.duplicate) return duplicateResponse(claim, "text");

        let deliveryTenantId: string | null = null;
        // Set when a keyed log write is refused because a redelivery disagreed
        // with the stored row: the 409 must not become this delivery's cached
        // "successful" response.
        let conflicted = false;
        /**
         * Conflict-aware log write. Returns the shared 409 conflict response
         * (plain text here — Twilio status callbacks don't parse XML) naming the
         * differing fields, or null when the write was accepted.
         */
        const writeLog = async (row: Parameters<typeof insertLog>[1]): Promise<Response | null> => {
          const { error } = (await insertLog(supabaseAdmin, row)) as { error: unknown };
          const conflict = asDedupeConflict(error);
          if (!conflict) return null;
          conflicted = true;
          return dedupeConflictResponse(conflict, "text");
        };
        const run = async (): Promise<Response> => {

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

        // Find the matching log row (prefer logId query param, fall back to call_sid).
        type MatchedLog = {
          id: string;
          user_id: string;
          customer_id: string | null;
          voicemail_url: string | null;
          recording_sid: string | null;
          dedupe_key: string | null;
        };
        const MATCH_COLS = "id, user_id, customer_id, voicemail_url, recording_sid, dedupe_key";
        let logRow: MatchedLog | null = null;
        if (logId) {
          const { data } = await supabaseAdmin
            .from("logs").select(MATCH_COLS).eq("id", logId).maybeSingle();
          logRow = (data as MatchedLog | null) ?? null;
        }
        if (!logRow && callSid) {
          const { data } = await supabaseAdmin
            .from("logs").select(MATCH_COLS)
            .eq("call_sid", callSid).order("created_at", { ascending: false }).limit(1).maybeSingle();
          logRow = (data as MatchedLog | null) ?? null;
        }

        // Play-back URL: append .mp3 so the Twilio-hosted recording streams as audio.
        const playbackUrl = recordingUrl.endsWith(".mp3") ? recordingUrl : `${recordingUrl}.mp3`;

        let tenantId: string | null = logRow?.user_id ?? null;
        deliveryTenantId = tenantId;
        if (logRow) {
          // Attaching the recording to an existing missed-call row is an UPDATE,
          // so the dedupe guard on inserts cannot see it. Apply the same integrity
          // rule here: filling in an empty field is enrichment, but replacing a
          // recording we already stored with a different one is a conflict — refuse
          // it with the shared 409 rather than overwriting audit evidence.
          const conflicts = diffDedupeRow(logRow as unknown as Record<string, unknown>, {
            voicemail_url: playbackUrl,
            recording_sid: recordingSid || null,
          });
          if (conflicts.length > 0) {
            const error = dedupeConflictError(
              logRow.dedupe_key ?? `recording:${recordingSid || callSid}`,
              logRow.id,
              conflicts,
            );
            console.error("[logs] recording conflict:", error.message, error.details);
            conflicted = true;
            return dedupeConflictResponse(error, "text");
          }
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
            deliveryTenantId = tenantId;
            const conflict = await writeLog({
              user_id: tenant.id,
              action_type: LogAction.missed_call_autotext,
              status: "sent",
              message_sent: `Voicemail received from ${from}.`,
              voicemail_url: playbackUrl,
              recording_sid: recordingSid || null,
              call_sid: callSid || null,
              // Keyed on RecordingSid so a retried status callback resolves to
              // this synthesized row rather than adding another one.
              dedupe_key: logDedupeKey(deliveryKey, LogAction.missed_call_autotext, "voicemail"),
            });
            if (conflict) return conflict;
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
            let conflict: Response | null = null;
            try {
              const { sendTwilioSms } = await import("@/lib/twilio.server");
              const body = `Voicemail from ${from} (${durationStr}s): ${playbackUrl}`;
              const res = await sendTwilioSms(profile.twilio_phone_number, profile.owner_phone, body);
              conflict = await writeLog({
                user_id: tenantId,
                action_type: LogAction.voicemail_notify,
                status: "sent",
                message_sent: body,
                twilio_message_sid: res.sid,
                call_sid: callSid || null,
                voicemail_url: playbackUrl,
                dedupe_key: logDedupeKey(deliveryKey, LogAction.voicemail_notify),
              });
            } catch (e) {
              conflict = await writeLog({
                user_id: tenantId,
                action_type: LogAction.voicemail_notify,
                status: "failed",
                message_sent: `Owner notify failed: ${(e as Error).message}`,
                call_sid: callSid || null,
                voicemail_url: playbackUrl,
                dedupe_key: logDedupeKey(deliveryKey, LogAction.voicemail_notify),
              });
            }
            if (conflict) return conflict;
          }
        }

        return new Response("ok");
        };

        const response = await run();
        return completeWebhookDelivery(supabaseAdmin, {
          deliveryId: claim.deliveryId,
          userId: deliveryTenantId,
          state: conflicted ? "failed" : "done",
          response,
        });

      },
    },
  },
});
