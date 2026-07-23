import { createClient } from "@supabase/supabase-js";
import { defineTool, type ToolContext } from "@lovable.dev/mcp-js";
import { z } from "zod";
import { checkAndRecord, rateLimitError } from "../rate-limit";

function supabaseForUser(ctx: ToolContext) {
  return createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_PUBLISHABLE_KEY!, {
    global: { headers: { Authorization: `Bearer ${ctx.getToken()}` } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

export default defineTool({
  name: "list_appointments",
  title: "List appointments",
  description:
    "List scheduled appointments for the signed-in Temora account within an optional date range (inclusive, YYYY-MM-DD).",
  inputSchema: {
    from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("Start date (inclusive)."),
    to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("End date (inclusive)."),
    limit: z.number().int().min(1).max(200).optional().describe("Max rows (default 50)."),
  },
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  handler: async ({ from, to, limit }, ctx) => {
    if (!ctx.isAuthenticated()) {
      return { content: [{ type: "text", text: "Not authenticated" }], isError: true };
    }
    const rl = await checkAndRecord(ctx, "list_appointments");
    if (!rl.ok) return rateLimitError(rl);
    const supabase = supabaseForUser(ctx);
    let q = supabase
      .from("appointments")
      .select("id, title, date, time, duration_minutes, notes, customer_id, quote_id, created_at")
      .order("date", { ascending: true })
      .limit(limit ?? 50);
    if (from) q = q.gte("date", from);
    if (to) q = q.lte("date", to);
    const { data, error } = await q;
    if (error) return { content: [{ type: "text", text: error.message }], isError: true };
    return {
      content: [{ type: "text", text: JSON.stringify(data ?? []) }],
      structuredContent: { appointments: data ?? [] },
    };
  },
});
