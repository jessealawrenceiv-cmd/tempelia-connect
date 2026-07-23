import { createClient } from "@supabase/supabase-js";
import { defineTool, type ToolContext } from "@lovable.dev/mcp-js";
import { z } from "zod";

function supabaseForUser(ctx: ToolContext) {
  return createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_PUBLISHABLE_KEY!, {
    global: { headers: { Authorization: `Bearer ${ctx.getToken()}` } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

export default defineTool({
  name: "list_quotes",
  title: "List quotes",
  description:
    "List recent quotes for the signed-in Temora account, optionally filtered by status (draft, sent, accepted, declined, superseded).",
  inputSchema: {
    status: z
      .enum(["draft", "sent", "accepted", "declined", "superseded"])
      .optional()
      .describe("Optional status filter."),
    limit: z.number().int().min(1).max(100).optional().describe("Max rows (default 25)."),
    include_archived: z.boolean().optional().describe("Include archived/superseded revisions (default false)."),
  },
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  handler: async ({ status, limit, include_archived }, ctx) => {
    if (!ctx.isAuthenticated()) {
      return { content: [{ type: "text", text: "Not authenticated" }], isError: true };
    }
    const supabase = supabaseForUser(ctx);
    let q = supabase
      .from("quotes")
      .select(
        "id, status, customer_first_name, customer_last_name, customer_phone, job_type, job_site_address, subtotal, tax_amount, total_amount, created_at, responded_at, decline_reason",
      )
      .order("created_at", { ascending: false })
      .limit(limit ?? 25);
    if (status) q = q.eq("status", status);
    if (!include_archived) q = q.is("archived_at", null);
    const { data, error } = await q;
    if (error) return { content: [{ type: "text", text: error.message }], isError: true };
    return {
      content: [{ type: "text", text: JSON.stringify(data ?? []) }],
      structuredContent: { quotes: data ?? [] },
    };
  },
});
