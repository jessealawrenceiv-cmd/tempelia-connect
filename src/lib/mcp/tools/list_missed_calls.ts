import { createClient } from "@supabase/supabase-js";
import { defineTool, type ToolContext } from "@lovable.dev/mcp-js";
import { z } from "zod";
import { checkAndRecord, rateLimitError } from "../rate-limit";
import { LOG_ACTION_TYPES, logActionTypeFilterSchema, safeParseLogActionType } from "@/lib/log-action-types.schema";

function supabaseForUser(ctx: ToolContext) {
  return createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_PUBLISHABLE_KEY!, {
    global: { headers: { Authorization: `Bearer ${ctx.getToken()}` } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

export default defineTool({
  name: "list_recent_activity",
  title: "List recent dispatch activity",
  description:
    "List recent dispatch log entries for the signed-in Temaro account (missed calls, auto-texts, voicemails, review requests, decline follow-ups). Filter by action_type when needed.",
  inputSchema: {
    action_type: logActionTypeFilterSchema.describe(
      `Optional action_type filter. Allowed values: ${LOG_ACTION_TYPES.join(", ")}.`,
    ),
    limit: z.number().int().min(1).max(200).optional().describe("Max rows (default 50)."),
  },
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  handler: async ({ action_type, limit }, ctx) => {
    if (!ctx.isAuthenticated()) {
      return { content: [{ type: "text", text: "Not authenticated" }], isError: true };
    }
    if (action_type !== undefined) {
      const parsed = safeParseLogActionType(action_type);
      if (!parsed.ok) {
        return { content: [{ type: "text", text: parsed.error }], isError: true };
      }
    }
    const rl = await checkAndRecord(ctx, "list_recent_activity");
    if (!rl.ok) return rateLimitError(rl);
    const supabase = supabaseForUser(ctx);
    let q = supabase
      .from("logs")
      .select("id, action_type, status, message_sent, customer_id, voicemail_url, created_at")
      .order("created_at", { ascending: false })
      .limit(limit ?? 50);
    if (action_type) q = q.eq("action_type", action_type);
    const { data, error } = await q;
    if (error) return { content: [{ type: "text", text: error.message }], isError: true };
    return {
      content: [{ type: "text", text: JSON.stringify(data ?? []) }],
      structuredContent: { activity: data ?? [] },
    };
  },
});
