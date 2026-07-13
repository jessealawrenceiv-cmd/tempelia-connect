import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

// Public, unauthenticated read of a quote by id. Uses service role to bypass RLS,
// same pattern as the public intake form. Only a narrow set of columns is
// returned (nothing sensitive like user_id or internal notes).
export const getPublicQuote = createServerFn({ method: "GET" })
  .inputValidator((d: { quoteId: string }) => z.object({ quoteId: z.string().uuid() }).parse(d))
  .handler(async ({ data }) => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data: q, error } = await supabaseAdmin
      .from("quotes")
      .select(
        "id, user_id, customer_first_name, customer_last_name, customer_business_name, job_site_address, line_items, subtotal, tax_rate, tax_amount, total_amount, valid_until, status, responded_at, created_at",
      )
      .eq("id", data.quoteId)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!q) return null;

    const { data: prof } = await supabaseAdmin
      .from("profiles")
      .select("business_name")
      .eq("id", q.user_id)
      .maybeSingle();

    // Strip user_id before returning.
    const { user_id: _u, ...safe } = q;
    return { ...safe, business_name: prof?.business_name || "" };
  });

export const respondToQuote = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) =>
    z
      .object({
        quoteId: z.string().uuid(),
        response: z.enum(["accepted", "declined"]),
      })
      .parse(d),
  )
  .handler(async ({ data }) => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    // Only allow transitioning from "sent" — no re-deciding.
    const { data: current, error: readErr } = await supabaseAdmin
      .from("quotes")
      .select("id, status")
      .eq("id", data.quoteId)
      .maybeSingle();
    if (readErr) throw new Error(readErr.message);
    if (!current) throw new Error("Quote not found");
    if (current.status !== "sent") {
      throw new Error(`This quote is ${current.status} — cannot change.`);
    }

    const nowIso = new Date().toISOString();
    const { error } = await supabaseAdmin
      .from("quotes")
      .update({ status: data.response, responded_at: nowIso })
      .eq("id", data.quoteId)
      .eq("status", "sent"); // guard against races
    if (error) throw new Error(error.message);

    if (data.response === "declined") {
      try {
        const { maybeAutoSendDeclineFollowup } = await import("./decline-followup.functions");
        await maybeAutoSendDeclineFollowup(data.quoteId);
      } catch {
        // best-effort — customer response is already recorded
      }
    }

    return { ok: true, status: data.response, respondedAt: nowIso };
  });
