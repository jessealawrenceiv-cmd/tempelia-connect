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
  name: "list_contacts",
  title: "List contacts",
  description:
    "List contacts for the signed-in Temora account. Optionally filter by a search string matching name or phone number.",
  inputSchema: {
    search: z.string().trim().optional().describe("Optional case-insensitive substring match on name or phone."),
    limit: z.number().int().min(1).max(100).optional().describe("Max rows to return (default 25)."),
  },
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  handler: async ({ search, limit }, ctx) => {
    if (!ctx.isAuthenticated()) {
      return { content: [{ type: "text", text: "Not authenticated" }], isError: true };
    }
    const supabase = supabaseForUser(ctx);
    let q = supabase
      .from("customers")
      .select("id, first_name, last_name, phone_number, email, opt_in_consent, last_service_date, source, created_at")
      .order("created_at", { ascending: false })
      .limit(limit ?? 25);
    if (search && search.length > 0) {
      const s = search.replace(/[%,]/g, "");
      q = q.or(`first_name.ilike.%${s}%,last_name.ilike.%${s}%,phone_number.ilike.%${s}%,email.ilike.%${s}%`);
    }
    const { data, error } = await q;
    if (error) return { content: [{ type: "text", text: error.message }], isError: true };
    return {
      content: [{ type: "text", text: JSON.stringify(data ?? []) }],
      structuredContent: { contacts: data ?? [] },
    };
  },
});
