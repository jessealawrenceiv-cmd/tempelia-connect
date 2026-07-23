import { createClient } from "@supabase/supabase-js";
import type { ToolContext } from "@lovable.dev/mcp-js";

// Per-user rate limits for MCP tool calls. Enforced with service-role writes
// against public.mcp_rate_limits (RLS-locked, backend-only).
const PER_MINUTE = 30;
const PER_HOUR = 300;

function admin() {
  return createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

export type RateLimitResult =
  | { ok: true }
  | { ok: false; retryAfterSec: number; scope: "minute" | "hour"; limit: number };

/**
 * Check + record a call for (userId, toolName). Returns { ok: false } when the
 * caller has exceeded the per-minute or per-hour ceiling. Call this at the top
 * of every tool handler after auth.
 */
export async function checkAndRecord(ctx: ToolContext, toolName: string): Promise<RateLimitResult> {
  const userId = ctx.getUserId();
  if (!userId) return { ok: true };
  const sb = admin();
  const now = Date.now();
  const minuteStart = new Date(now - 60_000).toISOString();
  const hourStart = new Date(now - 3_600_000).toISOString();

  const [{ count: minCount }, { count: hrCount }] = await Promise.all([
    sb
      .from("mcp_rate_limits")
      .select("id", { count: "exact", head: true })
      .eq("user_id", userId)
      .gte("called_at", minuteStart),
    sb
      .from("mcp_rate_limits")
      .select("id", { count: "exact", head: true })
      .eq("user_id", userId)
      .gte("called_at", hourStart),
  ]);

  if ((minCount ?? 0) >= PER_MINUTE) {
    return { ok: false, retryAfterSec: 60, scope: "minute", limit: PER_MINUTE };
  }
  if ((hrCount ?? 0) >= PER_HOUR) {
    return { ok: false, retryAfterSec: 3600, scope: "hour", limit: PER_HOUR };
  }

  // Fire-and-forget insert; ignore errors so a logging blip never blocks a tool.
  await sb.from("mcp_rate_limits").insert({ user_id: userId, tool_name: toolName });
  return { ok: true };
}

export function rateLimitError(res: Extract<RateLimitResult, { ok: false }>) {
  return {
    content: [
      {
        type: "text" as const,
        text: `Rate limit exceeded: ${res.limit} calls per ${res.scope}. Retry in ~${res.retryAfterSec}s.`,
      },
    ],
    isError: true,
  };
}
