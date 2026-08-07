/**
 * Operator diagnostics for webhook redelivery behaviour.
 *
 * Every inbound Twilio webhook is claimed through `webhook_delivery_claim`,
 * which keys on (source, event_kind, delivery_key). The first claim inserts a
 * row and processes the event; every later claim of the same key is a
 * *redelivery* and is served the stored response instead of re-processing.
 *
 * This function reads `webhook_deliveries` and classifies each key as
 * `inserted` (single delivery) or `deduped` (provider re-delivered), with the
 * first/last timestamps and the matching activity-log row (`logs.dedupe_key`)
 * so an operator can audit that dedupe actually held.
 */
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import type { SupabaseClient } from "@supabase/supabase-js";

import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import type { Database } from "@/integrations/supabase/types";

export type DeliveryClassification = "inserted" | "deduped";

export interface WebhookDeliveryAuditRow {
  id: string;
  source: string;
  eventKind: string;
  deliveryKey: string;
  state: string;
  classification: DeliveryClassification;
  attemptCount: number;
  /** Redeliveries beyond the first (attemptCount - 1). */
  dedupedCount: number;
  firstSeenAt: string;
  lastSeenAt: string;
  completedAt: string | null;
  responseStatus: number | null;
  /** ms between the first and the last delivery of this key. */
  redeliveryWindowMs: number;
  userId: string | null;
  /** Activity-log row written for this key, if any (logs.dedupe_key match). */
  logId: string | null;
  logActionType: string | null;
  logCreatedAt: string | null;
}

export interface WebhookDeliveryAudit {
  generatedAt: string;
  windowHours: number;
  totalKeys: number;
  insertedCount: number;
  dedupedCount: number;
  /** Total redelivered hits suppressed by the dedupe guard. */
  suppressedDeliveries: number;
  /** Deduped keys with no matching activity-log row — worth investigating. */
  unlinkedDedupedCount: number;
  rows: WebhookDeliveryAuditRow[];
}

const schema = z.object({
  windowHours: z.number().int().min(1).max(720).default(72),
  limit: z.number().int().min(1).max(200).default(100),
  classification: z.enum(["all", "inserted", "deduped"]).default("all"),
  source: z.string().max(60).nullable().optional(),
});

type AuthedClient = SupabaseClient<Database>;

async function assertAdmin(supabase: AuthedClient, userId: string, functionName: string) {
  const { data: isAdmin, error } = await supabase.rpc("has_role", { _role: "admin" });
  if (error) throw new Error(error.message);
  const { recordAdminAccess, checkAdminRateLimit } = await import("@/lib/admin-audit.server");
  if (!isAdmin) {
    await recordAdminAccess({ actorUserId: userId, functionName, outcome: "forbidden" });
    throw new Error("Forbidden");
  }
  const rate = await checkAdminRateLimit(userId, functionName);
  if (!rate.allowed) {
    await recordAdminAccess({
      actorUserId: userId,
      functionName,
      outcome: "rate_limited",
      detail: `${rate.recentCalls} calls in the last 60s (limit ${rate.limit})`,
    });
    throw new Error(`Rate limit exceeded: ${rate.limit} calls/minute for ${functionName}.`);
  }
  return recordAdminAccess;
}

export const getWebhookDeliveryAudit = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => schema.parse(input ?? {}))
  .handler(async ({ data, context }): Promise<WebhookDeliveryAudit> => {
    const { supabase, userId } = context;
    const recordAdminAccess = await assertAdmin(supabase, userId, "getWebhookDeliveryAudit");
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    const since = new Date(Date.now() - data.windowHours * 3_600_000).toISOString();

    let query = supabaseAdmin
      .from("webhook_deliveries")
      .select(
        "id, source, event_kind, delivery_key, state, attempt_count, first_seen_at, last_seen_at, completed_at, response_status, user_id",
      )
      .gte("last_seen_at", since)
      .order("last_seen_at", { ascending: false })
      .limit(data.limit);

    if (data.source) query = query.eq("source", data.source);
    if (data.classification === "deduped") query = query.gt("attempt_count", 1);
    if (data.classification === "inserted") query = query.lte("attempt_count", 1);

    const { data: deliveries, error } = await query;
    if (error) throw new Error(error.message);

    const keys = Array.from(new Set((deliveries ?? []).map((d) => d.delivery_key).filter(Boolean)));
    const logByKey = new Map<string, { id: string; action_type: string; created_at: string }>();
    if (keys.length > 0) {
      const { data: logRows } = await supabaseAdmin
        .from("logs")
        .select("id, action_type, created_at, dedupe_key")
        .in("dedupe_key", keys);
      for (const row of logRows ?? []) {
        if (row.dedupe_key && !logByKey.has(row.dedupe_key)) {
          logByKey.set(row.dedupe_key, {
            id: row.id,
            action_type: row.action_type,
            created_at: row.created_at,
          });
        }
      }
    }

    const rows: WebhookDeliveryAuditRow[] = (deliveries ?? []).map((d) => {
      const attempts = d.attempt_count ?? 1;
      const log = d.delivery_key ? logByKey.get(d.delivery_key) : undefined;
      return {
        id: d.id,
        source: d.source,
        eventKind: d.event_kind,
        deliveryKey: d.delivery_key,
        state: d.state,
        classification: attempts > 1 ? "deduped" : "inserted",
        attemptCount: attempts,
        dedupedCount: Math.max(0, attempts - 1),
        firstSeenAt: d.first_seen_at,
        lastSeenAt: d.last_seen_at,
        completedAt: d.completed_at,
        responseStatus: d.response_status,
        redeliveryWindowMs: Math.max(
          0,
          new Date(d.last_seen_at).getTime() - new Date(d.first_seen_at).getTime(),
        ),
        userId: d.user_id,
        logId: log?.id ?? null,
        logActionType: log?.action_type ?? null,
        logCreatedAt: log?.created_at ?? null,
      };
    });

    const deduped = rows.filter((r) => r.classification === "deduped");

    await recordAdminAccess({
      actorUserId: userId,
      functionName: "getWebhookDeliveryAudit",
      outcome: "allowed",
      rowCount: rows.length,
      detail: `window=${data.windowHours}h classification=${data.classification}`,
    });

    return {
      generatedAt: new Date().toISOString(),
      windowHours: data.windowHours,
      totalKeys: rows.length,
      insertedCount: rows.length - deduped.length,
      dedupedCount: deduped.length,
      suppressedDeliveries: deduped.reduce((sum, r) => sum + r.dedupedCount, 0),
      unlinkedDedupedCount: deduped.filter((r) => !r.logId).length,
      rows,
    };
  });
