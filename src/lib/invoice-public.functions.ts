import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

/**
 * Public, unauthenticated read of one invoice — same narrow-column pattern as
 * getPublicQuote. No payment collection surface exists here: the customer-facing
 * page is a document, not a checkout.
 */
export const getPublicInvoice = createServerFn({ method: "GET" })
  .inputValidator((d: { invoiceId: string }) =>
    z.object({ invoiceId: z.string().uuid() }).parse(d),
  )
  .handler(async ({ data }) => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data: inv, error } = await supabaseAdmin
      .from("invoices")
      .select(
        "id, user_id, invoice_number, customer_first_name, customer_last_name, customer_business_name, job_site_address, line_items, subtotal, tax_rate, tax_amount, total_amount, deposit_amount, deposit_paid, balance_due, status, superseded_by_id, balance_paid_at, sent_at, created_at",
      )
      .eq("id", data.invoiceId)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!inv) return null;

    const { data: prof } = await supabaseAdmin
      .from("profiles")
      .select("business_name, owner_phone, twilio_phone_number")
      .eq("id", inv.user_id)
      .maybeSingle();

    const { user_id: _u, ...safe } = inv;
    return {
      ...safe,
      business_name: prof?.business_name || "",
      business_phone: prof?.twilio_phone_number || prof?.owner_phone || null,
    };
  });
