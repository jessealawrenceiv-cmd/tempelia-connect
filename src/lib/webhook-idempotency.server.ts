/**
 * Idempotency for inbound webhooks (Twilio).
 *
 * Twilio re-delivers a webhook when our response is slow, non-2xx, or the
 * connection drops. Without dedupe, each retry re-runs the handler: duplicate
 * logs rows, duplicate auto-texts, duplicate owner notifications.
 *
 * Every delivery is keyed by a provider-stable identifier (CallSid, MessageSid,
 * RecordingSid). `claimWebhookDelivery` atomically inserts that key via
 * public.webhook_delivery_claim; the first caller gets a claim and processes
 * normally, retries get `duplicate: true` plus the stored response to replay.
 */

// Loose shape: the generated Supabase client types `rpc` against the generated
// function union, which lags behind newly added DB functions.
/* eslint-disable @typescript-eslint/no-explicit-any */
type AdminClient = {
  rpc: (fn: any, args?: any) => PromiseLike<{ data: any; error: any }>;
};

export type DeliveryClaim = {
  /** null when the claim bookkeeping itself failed — handler should process normally. */
  deliveryId: string | null;
  duplicate: boolean;
  /** How many times Twilio has delivered this key (1 = first). */
  attemptCount: number;
  /** Replayable response captured from the first successful run, when available. */
  storedResponse: { body: string; contentType: string; status: number } | null;
};

/** Build the dedupe key for a Twilio webhook. Returns null when no stable id exists. */
export function twilioDeliveryKey(
  eventKind: "missed_call" | "sms_inbound" | "recording_status",
  form: { get: (k: string) => unknown },
): string | null {
  const val = (k: string) => String(form.get(k) ?? "").trim();
  if (eventKind === "missed_call") {
    const sid = val("CallSid");
    // CallStatus varies across the call lifecycle; key per (call, status) so a
    // genuine later event on the same call is not swallowed as a duplicate.
    return sid ? `voice:${sid}:${val("CallStatus") || "ringing"}` : null;
  }
  if (eventKind === "sms_inbound") {
    const sid = val("MessageSid") || val("SmsSid");
    return sid ? `sms:${sid}` : null;
  }
  const rsid = val("RecordingSid") || val("CallSid");
  return rsid ? `recording:${rsid}:${val("RecordingStatus") || "completed"}` : null;
}

type ClaimRow = {
  delivery_id: string;
  is_duplicate: boolean;
  state: string;
  response_body: string | null;
  response_content_type: string | null;
  response_status: number | null;
  attempt_count: number;
};

export async function claimWebhookDelivery(
  client: AdminClient,
  args: { source: string; eventKind: string; deliveryKey: string | null },
): Promise<DeliveryClaim> {
  if (!args.deliveryKey) {
    // No stable id from the provider — can't dedupe; process normally.
    return { deliveryId: null, duplicate: false, attemptCount: 1, storedResponse: null };
  }
  const { data, error } = await client.rpc("webhook_delivery_claim" as any, {
    _source: args.source,
    _event_kind: args.eventKind,
    _delivery_key: args.deliveryKey,
  });
  if (error) {
    console.error("webhook_delivery_claim failed", error);
    return { deliveryId: null, duplicate: false, attemptCount: 1, storedResponse: null };
  }
  const row = (Array.isArray(data) ? data[0] : data) as ClaimRow | undefined;
  if (!row) return { deliveryId: null, duplicate: false, attemptCount: 1, storedResponse: null };

  const stored =
    row.response_body != null
      ? {
          body: row.response_body,
          contentType: row.response_content_type ?? "text/plain",
          status: row.response_status ?? 200,
        }
      : null;

  return {
    deliveryId: row.delivery_id,
    duplicate: Boolean(row.is_duplicate),
    attemptCount: row.attempt_count ?? 1,
    storedResponse: stored,
  };
}

/** Store the response so future retries of the same key replay it verbatim. */
export async function completeWebhookDelivery(
  client: AdminClient,
  args: {
    deliveryId: string | null;
    userId?: string | null;
    state?: "done" | "failed";
    response: Response;
  },
): Promise<Response> {
  const { deliveryId, response } = args;
  if (!deliveryId) return response;
  // Clone before reading — the original body must stay unconsumed for the caller.
  const body = await response.clone().text();
  const { error } = await client.rpc("webhook_delivery_complete" as any, {
    _delivery_id: deliveryId,
    _user_id: args.userId ?? null,
    _state: args.state ?? "done",
    _response_body: body,
    _response_content_type: response.headers.get("Content-Type") ?? "text/plain",
    _response_status: response.status,
  });
  if (error) console.error("webhook_delivery_complete failed", error);
  return response;
}

/**
 * Response returned for a retry we refuse to re-process. Replays the stored
 * response when we have one; otherwise an inert 200 so Twilio stops retrying
 * (a 5xx here would trigger yet another delivery of work already in flight).
 */
export function duplicateResponse(claim: DeliveryClaim, fallbackKind: "twiml" | "text"): Response {
  if (claim.storedResponse) {
    return new Response(claim.storedResponse.body, {
      status: claim.storedResponse.status,
      headers: { "Content-Type": claim.storedResponse.contentType, "X-Temaro-Duplicate": "replayed" },
    });
  }
  if (fallbackKind === "twiml") {
    return new Response('<?xml version="1.0" encoding="UTF-8"?><Response/>', {
      status: 200,
      headers: { "Content-Type": "text/xml", "X-Temaro-Duplicate": "in-flight" },
    });
  }
  return new Response("ok", { status: 200, headers: { "X-Temaro-Duplicate": "in-flight" } });
}
