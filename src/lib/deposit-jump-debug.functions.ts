import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

export type DebugEventName =
  | "deposit_jump_success"
  | "deposit_jump_miss"
  | "deposit_jump_recovery";

export type Json = string | number | boolean | null | Json[] | { [key: string]: Json };

const EVENT_NAMES: DebugEventName[] = [
  "deposit_jump_success",
  "deposit_jump_miss",
  "deposit_jump_recovery",
];

export interface PersistedDebugEntry {
  id: string;
  event: DebugEventName;
  payload: Record<string, Json>;
  correlationId: string | null;
  occurredAt: string;
}

/** Persist one on-screen debug entry so a test run survives a refresh. */
export const saveDepositJumpDebugEvent = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(
    (input: {
      quoteId: string | null;
      event: DebugEventName;
      payload: Record<string, unknown>;
      correlationId?: string | null;
    }) => {
      if (!EVENT_NAMES.includes(input.event)) throw new Error("Invalid debug event name");
      // Cap payload size so a stray object can't bloat the table.
      const json = JSON.stringify(input.payload ?? {});
      const payload =
        json.length > 8000 ? ({ truncated: true, size: json.length } as Record<string, Json>) : (JSON.parse(json) as Record<string, Json>);
      return {
        quoteId: typeof input.quoteId === "string" && input.quoteId.trim() ? input.quoteId.trim() : null,
        event: input.event,
        payload,
        correlationId:
          typeof input.correlationId === "string" && input.correlationId.trim()
            ? input.correlationId.trim().slice(0, 64)
            : null,
      };
    },
  )
  .handler(async ({ data, context }) => {
    const { error } = await context.supabase.from("deposit_jump_debug_events").insert({
      user_id: context.userId,
      quote_id: data.quoteId,
      event_name: data.event,
      payload: data.payload,
      correlation_id: data.correlationId,
    });
    if (error) throw new Error(error.message);
    return { ok: true };
  });

/** Load the saved debug log for a quote (most recent first). */
export const listDepositJumpDebugEvents = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { quoteId?: string | null; limit?: number } | undefined) => ({
    quoteId:
      typeof input?.quoteId === "string" && input.quoteId.trim() ? input.quoteId.trim() : null,
    limit: Math.max(1, Math.min(200, Math.round(input?.limit ?? 50))),
  }))
  .handler(async ({ data, context }): Promise<PersistedDebugEntry[]> => {
    let query = context.supabase
      .from("deposit_jump_debug_events")
      .select("id, event_name, payload, correlation_id, occurred_at")
      .eq("user_id", context.userId)
      .order("occurred_at", { ascending: false })
      .limit(data.limit);
    if (data.quoteId) query = query.eq("quote_id", data.quoteId);

    const { data: rows, error } = await query;
    if (error) throw new Error(error.message);

    return (rows ?? []).map((r) => ({
      id: r.id,
      event: r.event_name as DebugEventName,
      payload: (r.payload ?? {}) as Record<string, Json>,
      correlationId: r.correlation_id ?? null,
      occurredAt: r.occurred_at,
    }));
  });

/** Clear saved debug entries — all of the caller's, or just one quote's. */
export const clearDepositJumpDebugEvents = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { quoteId?: string | null } | undefined) => ({
    quoteId:
      typeof input?.quoteId === "string" && input.quoteId.trim() ? input.quoteId.trim() : null,
  }))
  .handler(async ({ data, context }) => {
    let query = context.supabase
      .from("deposit_jump_debug_events")
      .delete()
      .eq("user_id", context.userId);
    if (data.quoteId) query = query.eq("quote_id", data.quoteId);
    const { error } = await query;
    if (error) throw new Error(error.message);
    return { ok: true };
  });
