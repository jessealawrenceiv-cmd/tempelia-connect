/**
 * Activity-log entries for webhook delivery *reliability* (not business events).
 *
 * Twilio re-delivers a webhook when our response is slow, non-2xx, or the
 * connection drops. `webhook_deliveries` already dedupes those retries, but the
 * owner-visible Activity log had no trace of them: a missed call that only
 * landed on the third delivery, or one that never landed at all, looked
 * identical to a clean run.
 *
 * These helpers write `webhook_delivery_status` rows so retries and final
 * failures (with the reason) show up in the dispatch log.
 */
import { insertLog, LogAction } from "@/lib/log-action-types";

/** After this many deliveries of the same key we treat a failure as final. */
export const WEBHOOK_MAX_ATTEMPTS = 3;

type AnyClient = Parameters<typeof insertLog>[0];

type Base = {
  userId: string;
  customerId?: string | null;
  eventKind: string;
  deliveryKey: string | null;
  attemptCount: number;
  callSid?: string | null;
  fromNumber?: string | null;
};

function detail(args: Base, extra: Record<string, unknown>) {
  return JSON.stringify({
    event_kind: args.eventKind,
    delivery_key: args.deliveryKey,
    attempt: args.attemptCount,
    max_attempts: WEBHOOK_MAX_ATTEMPTS,
    call_sid: args.callSid ?? null,
    from: args.fromNumber ?? null,
    at: new Date().toISOString(),
    ...extra,
  });
}

/** Logged when a delivery we're processing is not the provider's first attempt. */
export async function logWebhookRetryAttempt(client: AnyClient, args: Base) {
  if (args.attemptCount <= 1) return;
  try {
    await insertLog(client, {
      user_id: args.userId,
      customer_id: args.customerId ?? null,
      action_type: LogAction.webhook_delivery_status,
      status: "retry",
      call_sid: args.callSid ?? null,
      message_sent: detail(args, {
        outcome: "retry",
        note: `Provider re-delivered this webhook (attempt ${args.attemptCount}) — reprocessing.`,
      }),
    });
  } catch (e) {
    console.error("logWebhookRetryAttempt failed", e);
  }
}

/** Logged when processing throws. Marked final once retries are exhausted. */
export async function logWebhookFailure(
  client: AnyClient,
  args: Base & { reason: string; final?: boolean },
) {
  const final = args.final ?? args.attemptCount >= WEBHOOK_MAX_ATTEMPTS;
  try {
    await insertLog(client, {
      user_id: args.userId,
      customer_id: args.customerId ?? null,
      action_type: LogAction.webhook_delivery_status,
      status: final ? "final_failure" : "failed",
      call_sid: args.callSid ?? null,
      message_sent: detail(args, {
        outcome: final ? "final_failure" : "failed",
        reason: args.reason,
        note: final
          ? `Webhook failed after ${args.attemptCount} delivery attempt(s) — giving up. Reason: ${args.reason}`
          : `Webhook attempt ${args.attemptCount} failed — provider will retry. Reason: ${args.reason}`,
      }),
    });
  } catch (e) {
    console.error("logWebhookFailure failed", e);
  }
}
