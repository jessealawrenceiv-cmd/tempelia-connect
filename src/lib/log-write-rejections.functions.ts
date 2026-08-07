/**
 * Rejected activity-log write attempts.
 *
 * Every write blocked by the `logs_action_type_check` whitelist — client-side
 * pre-validation, the server-side guard, or a real Postgres 23514 — is recorded
 * in `log_write_rejections` with the rejected action_type and requester
 * context, and surfaced on the operator diagnostics page.
 */
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

export type LogWriteRejection = {
  id: string;
  occurredAt: string;
  rejectedActionType: string | null;
  rejectedActionTypes: string[];
  blockedAt: "client" | "server" | "database";
  constraintName: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  requestPath: string | null;
  userAgent: string | null;
  correlationId: string | null;
  actorUserId: string | null;
  /** Attempted row, pretty-printed JSON (serializable across the RPC boundary). */
  attemptedRowJson: string;
};

const reportSchema = z.object({
  rejectedActionType: z.string().max(200).nullable().optional(),
  rejectedActionTypes: z.array(z.string().max(200)).max(50).optional(),
  blockedAt: z.enum(["client", "server", "database"]).default("client"),
  constraintName: z.string().max(200).nullable().optional(),
  errorCode: z.string().max(50).nullable().optional(),
  errorMessage: z.string().max(2000).nullable().optional(),
  attemptedRow: z.record(z.string(), z.unknown()).optional(),
  requestPath: z.string().max(500).nullable().optional(),
  correlationId: z.string().max(120).nullable().optional(),
});

/**
 * Records one rejected log write. Best-effort: never throws back at the caller,
 * because diagnostics must not break the user's action.
 */
export const reportLogWriteRejection = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => reportSchema.parse(input))
  .handler(async ({ data, context }): Promise<{ ok: boolean }> => {
    const { getRequestHeader } = await import("@tanstack/react-start/server");
    const userAgent = (() => {
      try {
        return getRequestHeader("user-agent") ?? null;
      } catch {
        return null;
      }
    })();

    const types = data.rejectedActionTypes?.length
      ? data.rejectedActionTypes
      : data.rejectedActionType
        ? [data.rejectedActionType]
        : [];

    console.warn(
      `log_write_rejected ${JSON.stringify({
        blocked_at: data.blockedAt,
        rejected: types,
        code: data.errorCode ?? null,
        correlation_id: data.correlationId ?? null,
      })}`,
    );

    try {
      const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
      const { error } = await supabaseAdmin.from("log_write_rejections").insert({
        user_id: context.userId,
        actor_user_id: context.userId,
        rejected_action_type: data.rejectedActionType ?? types[0] ?? null,
        rejected_action_types: types,
        blocked_at: data.blockedAt,
        constraint_name: data.constraintName ?? null,
        error_code: data.errorCode ?? null,
        error_message: data.errorMessage ?? null,
        attempted_row: (data.attemptedRow ?? {}) as never,
        request_path: data.requestPath ?? null,
        user_agent: userAgent,
        correlation_id: data.correlationId ?? null,
      });
      if (error) {
        console.warn(`log_write_rejected_persist_failed ${JSON.stringify({ message: error.message })}`);
        return { ok: false };
      }
    } catch (err) {
      console.warn(
        `log_write_rejected_persist_threw ${JSON.stringify({
          message: err instanceof Error ? err.message : String(err),
        })}`,
      );
      return { ok: false };
    }

    return { ok: true };
  });

const listSchema = z.object({
  limit: z.number().int().min(1).max(200).default(50),
  actionType: z.string().max(200).nullable().optional(),
});

/** Admin-only: most recent rejections, newest first. */
export const listLogWriteRejections = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => listSchema.parse(input ?? {}))
  .handler(async ({ data, context }): Promise<LogWriteRejection[]> => {
    const { supabase } = context;

    const { data: isAdmin, error: roleErr } = await supabase.rpc("has_role", { _role: "admin" });
    if (roleErr) throw new Error(roleErr.message);
    if (!isAdmin) throw new Error("Forbidden");

    let query = supabase
      .from("log_write_rejections")
      .select(
        "id, occurred_at, rejected_action_type, rejected_action_types, blocked_at, constraint_name, error_code, error_message, request_path, user_agent, correlation_id, actor_user_id, attempted_row",
      )
      .order("occurred_at", { ascending: false })
      .limit(data.limit);

    if (data.actionType) query = query.eq("rejected_action_type", data.actionType);

    const { data: rows, error } = await query;
    if (error) throw new Error(error.message);

    return (rows ?? []).map((r) => ({
      id: r.id,
      occurredAt: r.occurred_at,
      rejectedActionType: r.rejected_action_type,
      rejectedActionTypes: r.rejected_action_types ?? [],
      blockedAt: (r.blocked_at ?? "server") as LogWriteRejection["blockedAt"],
      constraintName: r.constraint_name,
      errorCode: r.error_code,
      errorMessage: r.error_message,
      requestPath: r.request_path,
      userAgent: r.user_agent,
      correlationId: r.correlation_id,
      actorUserId: r.actor_user_id,
      attemptedRowJson: JSON.stringify(r.attempted_row ?? {}, null, 2),
    }));
  });
