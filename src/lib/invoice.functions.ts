import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { z } from "zod";
import { PROJECT_PUBLIC_BASE } from "./twilio.server";
import { invoiceSaveSchema } from "./invoice-schemas";
import { INVOICE_AUDIT_ACTION } from "./invoice";


/**
 * Create an invoice from an ACCEPTED quote. Every customer/money field is
 * snapshotted from the quote's current state — including the quote's real
 * deposit state — so the invoice reflects reality at the moment it was issued.
 * The invoice_number is assigned by the database (gapless, per business).
 */
export const createInvoiceFromQuote = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({ quoteId: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;

    const { data: q, error: qErr } = await supabase
      .from("quotes")
      .select(
        "id, user_id, customer_id, status, customer_first_name, customer_last_name, customer_business_name, customer_phone, job_site_address, line_items, subtotal, tax_rate, tax_amount, total_amount, deposit_required, deposit_amount, deposit_paid",
      )
      .eq("id", data.quoteId)
      .maybeSingle();
    if (qErr) throw new Error(qErr.message);
    if (!q) throw new Error("Quote not found");
    if (q.status !== "accepted") {
      throw new Error(`Only accepted quotes can be invoiced — this quote is ${q.status}.`);
    }

    // Existing live invoice? Don't silently issue a duplicate number.
    const { data: existing } = await supabase
      .from("invoices")
      .select("id, invoice_number, status")
      .eq("quote_id", q.id)
      .neq("status", "archived")
      .maybeSingle();
    if (existing) {
      return {
        ok: false as const,
        reason: "exists" as const,
        invoiceId: existing.id,
        invoiceNumber: existing.invoice_number,
        status: existing.status,
      };
    }

    let customerEmail: string | null = null;
    if (q.customer_id) {
      const { data: cust } = await supabase
        .from("customers")
        .select("email")
        .eq("id", q.customer_id)
        .maybeSingle();
      customerEmail = cust?.email ?? null;
    }

    const depositAmount = q.deposit_required ? Number(q.deposit_amount ?? 0) : 0;
    const depositPaid = Boolean(q.deposit_required && q.deposit_paid);

    const { data: inv, error: insErr } = await supabase
      .from("invoices")
      .insert({
        user_id: q.user_id ?? userId,
        quote_id: q.id,
        customer_id: q.customer_id,
        customer_first_name: q.customer_first_name,
        customer_last_name: q.customer_last_name,
        customer_business_name: q.customer_business_name,
        customer_phone: q.customer_phone,
        customer_email: customerEmail,
        job_site_address: q.job_site_address,
        line_items: q.line_items,
        subtotal: q.subtotal,
        tax_rate: q.tax_rate,
        tax_amount: q.tax_amount,
        total_amount: q.total_amount,
        deposit_amount: depositAmount,
        deposit_paid: depositPaid,
        status: "draft",
        // invoice_seq / invoice_number / balance_due are database-assigned.
      } as never)
      .select("id, invoice_number, total_amount, deposit_amount, deposit_paid, balance_due, status")
      .single();
    if (insErr) throw new Error(insErr.message);

    return { ok: true as const, invoice: inv };
  });


/**
 * Save an invoice edit.
 *  - draft  → edited in place, same invoice_number retained.
 *  - sent / paid → a NEW invoice row is created with the NEXT sequential
 *    number and the original is archived via superseded_by_id. The database
 *    also refuses in-place money edits on non-draft invoices, so this is
 *    enforced on both sides.
 */
export const saveInvoice = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => invoiceSaveSchema.parse(d))
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;

    const { data: current, error: readErr } = await supabase
      .from("invoices")
      .select(
        "id, user_id, quote_id, customer_id, invoice_number, status, deposit_amount, deposit_paid",
      )
      .eq("id", data.invoiceId)
      .maybeSingle();
    if (readErr) throw new Error(readErr.message);
    if (!current) throw new Error("Invoice not found");
    if (current.status === "archived") throw new Error("This invoice is archived — it cannot be edited.");

    const items = data.line_items.map((it) => ({
      label: it.label ?? "",
      amount: Math.round(it.amount * 100) / 100,
    }));
    const subtotal = Math.round(items.reduce((s, it) => s + it.amount, 0) * 100) / 100;
    const taxAmount = Math.round(subtotal * (data.tax_rate / 100) * 100) / 100;
    const total = Math.round((subtotal + taxAmount) * 100) / 100;

    const payload = {
      customer_first_name: data.customer_first_name,
      customer_last_name: data.customer_last_name || null,
      customer_business_name: data.customer_business_name || null,
      customer_phone: data.customer_phone,
      customer_email: data.customer_email || null,
      job_site_address: data.job_site_address,
      line_items: items,
      subtotal,
      tax_rate: data.tax_rate,
      tax_amount: taxAmount,
      total_amount: total,
    };

    if (current.status === "draft") {
      const { data: updated, error } = await supabase
        .from("invoices")
        .update(payload as never)
        .eq("id", current.id)
        .select("id, invoice_number, status, total_amount, balance_due")
        .single();
      if (error) throw new Error(error.message);
      return { ok: true as const, mode: "edited" as const, invoice: updated, archivedId: null };
    }

    // Revision: new numbered row, original archived and pointed at it.
    const depositAmount = Number(current.deposit_amount ?? 0);
    const cappedDeposit = Math.min(depositAmount, total);
    const { data: created, error: insErr } = await supabase
      .from("invoices")
      .insert({
        user_id: current.user_id ?? userId,
        quote_id: current.quote_id,
        customer_id: current.customer_id,
        deposit_amount: cappedDeposit,
        deposit_paid: current.deposit_paid,
        status: "draft",
        ...payload,
      } as never)
      .select("id, invoice_number, status, total_amount, balance_due")
      .single();
    if (insErr) throw new Error(insErr.message);

    const { error: archErr } = await supabase
      .from("invoices")
      .update({ status: "archived", archived_at: new Date().toISOString(), superseded_by_id: created.id } as never)
      .eq("id", current.id);
    if (archErr) throw new Error(archErr.message);

    return {
      ok: true as const,
      mode: "revised" as const,
      invoice: created,
      archivedId: current.id,
      archivedNumber: current.invoice_number,
    };
  });

/**
 * Mark the remaining balance as received — tracking only, no money moves.
 * The before/after state, actor and timestamp are recorded by the
 * public.invoices_audit_balance_change trigger in the same transaction.
 */
export const markInvoiceBalance = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) =>
    z.object({ invoiceId: z.string().uuid(), paid: z.boolean() }).parse(d),
  )
  .handler(async ({ data, context }) => {
    const { supabase } = context;

    const { data: inv, error } = await supabase
      .from("invoices")
      .select("id, status, sent_at, balance_due, total_amount, deposit_amount, deposit_paid")
      .eq("id", data.invoiceId)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!inv) throw new Error("Invoice not found");
    if (inv.status === "archived") throw new Error("Cannot change an archived invoice.");
    if (data.paid && inv.status === "paid") throw new Error("This invoice is already marked paid.");
    if (!data.paid && inv.status !== "paid") throw new Error("This invoice is not marked paid.");

    const nextStatus = data.paid ? "paid" : inv.sent_at ? "sent" : "draft";
    const { data: updated, error: upErr } = await supabase
      .from("invoices")
      .update({ status: nextStatus } as never)
      .eq("id", inv.id)
      .select("id, invoice_number, status, balance_due, balance_paid_at")
      .single();
    if (upErr) throw new Error(upErr.message);

    return { ok: true as const, invoice: updated, audited: true as const };
  });

/** Send / resend the invoice SMS using the shared body builder. */
export const sendInvoiceSms = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) =>
    z
      .object({ invoiceId: z.string().uuid(), force: z.boolean().optional().default(false) })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    const { sendTwilioSms, STOP_SUFFIX } = await import("./twilio.server");

    const { data: inv, error } = await supabase
      .from("invoices")
      .select(
        "id, invoice_number, status, customer_id, customer_first_name, customer_phone, total_amount, deposit_amount, deposit_paid, last_sms_sent_at",
      )
      .eq("id", data.invoiceId)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!inv) throw new Error("Invoice not found");
    if (inv.status === "archived") throw new Error("Cannot send an archived invoice.");
    if (!inv.customer_phone) throw new Error("This invoice has no customer phone number.");

    if (!data.force && inv.last_sms_sent_at) {
      const ageMs = Date.now() - new Date(inv.last_sms_sent_at).getTime();
      if (ageMs < 5 * 60_000) {
        return {
          ok: false as const,
          reason: "cooldown" as const,
          lastSentAt: inv.last_sms_sent_at,
          minutesAgo: Math.max(1, Math.round(ageMs / 60_000)),
        };
      }
    }

    const { data: prof } = await supabase
      .from("profiles")
      .select("business_name, twilio_phone_number")
      .eq("id", userId)
      .maybeSingle();
    const from = prof?.twilio_phone_number;
    if (!from) throw new Error("Provision your Temaro number in Settings before sending.");

    const { buildInvoiceSmsBody } = await import("./invoice-sms-body");
    const { message } = buildInvoiceSmsBody({
      firstName: inv.customer_first_name,
      businessName: prof?.business_name || "our team",
      invoiceId: inv.id,
      invoiceNumber: inv.invoice_number,
      total: inv.total_amount,
      depositAmount: inv.deposit_amount,
      depositPaid: inv.deposit_paid,
      publicBase: PROJECT_PUBLIC_BASE,
      stopSuffix: STOP_SUFFIX,
    });

    try {
      const res = await sendTwilioSms(from, inv.customer_phone, message);
      const nowIso = new Date().toISOString();
      const updates: Record<string, unknown> = { last_sms_sent_at: nowIso };
      if (inv.status === "draft") updates["status"] = "sent";
      await supabase.from("invoices").update(updates as never).eq("id", inv.id);

      await supabase.from("logs").insert({
        user_id: userId,
        customer_id: inv.customer_id,
        action_type: "invoice_sms",
        message_sent: message,
        status: "sent",
        twilio_message_sid: res.sid,
      });
      return { ok: true as const, sid: res.sid, sentAt: nowIso, message };
    } catch (e) {
      await supabase.from("logs").insert({
        user_id: userId,
        customer_id: inv.customer_id,
        action_type: "invoice_sms",
        message_sent: message,
        status: "failed",
      });
      throw e;
    }
  });

/** Audit trail for one invoice, read from the dispatch log. */
export const getInvoiceAudit = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({ invoiceId: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    const { supabase } = context;
    const { data: rows, error } = await supabase
      .from("logs")
      .select("id, status, message_sent, created_at")
      .eq("action_type", INVOICE_AUDIT_ACTION)
      .order("created_at", { ascending: false })
      .limit(100);
    if (error) throw new Error(error.message);
    return (rows ?? []).filter((r) => (r.message_sent ?? "").includes(data.invoiceId));
  });
