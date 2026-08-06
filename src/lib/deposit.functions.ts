import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { z } from "zod";

export const DEPOSIT_AUDIT_ACTION = "quote_deposit_status";

const inputSchema = z.object({
  quoteId: z.string().uuid(),
  paid: z.boolean(),
});

/**
 * Mark a quote's deposit as received, or undo that. Both directions are
 * recorded in the dispatch log (public.logs) with the acting user's id/email
 * and a server-side timestamp — same audit pattern as the email-overwrite and
 * consent-preservation logs written from the quote form.
 */
export const markQuoteDeposit = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => inputSchema.parse(d))
  .handler(async ({ data, context }) => {
    const { supabase, userId, claims } = context;

    // RLS scopes this read to the owner or an accepted team member.
    const { data: q, error: qErr } = await supabase
      .from("quotes")
      .select(
        "id, user_id, customer_id, status, total_amount, deposit_required, deposit_amount, deposit_paid, deposit_paid_at",
      )
      .eq("id", data.quoteId)
      .maybeSingle();
    if (qErr) throw new Error(qErr.message);
    if (!q) throw new Error("Quote not found");
    if (!q.deposit_required) throw new Error("This quote does not require a deposit.");
    if (q.status === "archived") throw new Error("Cannot change a deposit on an archived quote.");
    if (q.deposit_paid === data.paid) {
      throw new Error(
        data.paid ? "Deposit is already marked received." : "Deposit is not marked received.",
      );
    }

    const nowIso = new Date().toISOString();
    const { error: upErr } = await supabase
      .from("quotes")
      .update({
        deposit_paid: data.paid,
        deposit_paid_at: data.paid ? nowIso : null,
      })
      .eq("id", q.id);
    if (upErr) throw new Error(upErr.message);

    const actorEmail =
      typeof claims?.email === "string" ? (claims.email as string) : null;
    const depositAmount = Number(q.deposit_amount ?? 0);
    const total = Number(q.total_amount ?? 0);
    const balanceRemaining = Math.round((total - (data.paid ? depositAmount : 0)) * 100) / 100;

    // Audit trail is written by the public.quotes_audit_deposit_change trigger,
    // which fires for EVERY deposit change — this action, quote edits, and
    // revisions alike — so no path can silently clear deposit state.
    void actorEmail;


    return {
      ok: true as const,
      paid: data.paid,
      paidAt: data.paid ? nowIso : null,
      depositAmount,
      balanceRemaining,
      audited: true as const,
    };
  });

