import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { PageHeader } from "@/components/AppShell";
import { saveInvoice } from "@/lib/invoice.functions";
import { fmtMoney, invoiceBalanceDue, invoiceTotals, type InvoiceLineItem } from "@/lib/invoice";

export const Route = createFileRoute("/_authenticated/dashboard/invoices/$invoiceId/edit")({
  component: EditInvoicePage,
});

type Item = { label: string; amount: string };

function EditInvoicePage() {
  const { invoiceId } = Route.useParams();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const saveFn = useServerFn(saveInvoice);

  const { data: inv, isLoading } = useQuery({
    queryKey: ["invoice", invoiceId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("invoices")
        .select(
          "id, invoice_number, status, customer_first_name, customer_last_name, customer_business_name, customer_phone, customer_email, job_site_address, line_items, tax_rate, total_amount, deposit_amount, deposit_paid",
        )
        .eq("id", invoiceId)
        .maybeSingle();
      if (error) throw error;
      return data;
    },
  });

  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [bizName, setBizName] = useState("");
  const [phone, setPhone] = useState("");
  const [email, setEmail] = useState("");
  const [jobSite, setJobSite] = useState("");
  const [taxRate, setTaxRate] = useState("0");
  const [items, setItems] = useState<Item[]>([{ label: "", amount: "" }]);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!inv) return;
    setFirstName(inv.customer_first_name ?? "");
    setLastName(inv.customer_last_name ?? "");
    setBizName(inv.customer_business_name ?? "");
    setPhone(inv.customer_phone ?? "");
    setEmail(inv.customer_email ?? "");
    setJobSite(inv.job_site_address ?? "");
    setTaxRate(String(inv.tax_rate ?? 0));
    const li = Array.isArray(inv.line_items) ? (inv.line_items as InvoiceLineItem[]) : [];
    setItems(
      li.length
        ? li.map((it) => ({ label: String(it.label ?? ""), amount: String(it.amount ?? "") }))
        : [{ label: "", amount: "" }],
    );
  }, [inv]);

  const totals = invoiceTotals(
    items.map((it) => ({ label: it.label, amount: it.amount })),
    taxRate,
  );
  const isDraft = inv?.status === "draft";

  async function handleSave() {
    if (!firstName.trim() || !phone.trim() || !jobSite.trim()) {
      toast.error("First name, phone and job site are required.");
      return;
    }
    const cleaned = items.filter((it) => it.label.trim() || it.amount.trim());
    if (cleaned.length === 0) {
      toast.error("Add at least one line item.");
      return;
    }
    setSaving(true);
    try {
      const res = await saveFn({
        data: {
          invoiceId,
          customer_first_name: firstName.trim(),
          customer_last_name: lastName.trim() || null,
          customer_business_name: bizName.trim() || null,
          customer_phone: phone.trim(),
          customer_email: email.trim() || null,
          job_site_address: jobSite.trim(),
          line_items: cleaned.map((it) => ({ label: it.label.trim(), amount: Number(it.amount || 0) })),
          tax_rate: Number(taxRate || 0),
        },
      });
      if (res.mode === "revised") {
        toast.success(
          `${res.archivedNumber} archived — new invoice ${res.invoice.invoice_number} created.`,
        );
      } else {
        toast.success(`${res.invoice.invoice_number} updated.`);
      }
      qc.invalidateQueries({ queryKey: ["invoices"] });
      navigate({ to: "/dashboard/invoices" });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Save failed");
    } finally {
      setSaving(false);
    }
  }

  if (isLoading) {
    return <div className="p-8 text-muted-foreground mono">Loading…</div>;
  }
  if (!inv) {
    return <div className="p-8 text-muted-foreground">Invoice not found.</div>;
  }

  const projectedBalance = invoiceBalanceDue({
    total: totals.total,
    depositAmount: inv.deposit_amount,
    depositPaid: inv.deposit_paid,
  });

  return (
    <div>
      <PageHeader
        eyebrow="Billing"
        title={isDraft ? `Edit ${inv.invoice_number}` : `Revise ${inv.invoice_number}`}
      />
      {!isDraft && (
        <div className="mx-5 mt-4 md:mx-8 rounded-sm border border-orange/40 bg-orange/10 px-3 py-2 mono text-[11px] text-paper">
          // {inv.invoice_number} is {inv.status} — saving creates a NEW invoice with the next
          number and archives this one. Sent invoices are never edited in place.
        </div>
      )}
      <div className="p-5 md:p-8 space-y-5 max-w-4xl">
        <section className="panel p-5 space-y-3">
          <div className="label-eyebrow">Customer</div>
          <div className="grid gap-3 sm:grid-cols-2">
            <input value={firstName} onChange={(e) => setFirstName(e.target.value)} placeholder="First name *" className="mono rounded-sm border border-border bg-background px-3 py-2 text-sm" />
            <input value={lastName} onChange={(e) => setLastName(e.target.value)} placeholder="Last name" className="mono rounded-sm border border-border bg-background px-3 py-2 text-sm" />
            <input value={bizName} onChange={(e) => setBizName(e.target.value)} placeholder="Business name" className="mono rounded-sm border border-border bg-background px-3 py-2 text-sm sm:col-span-2" />
            <input value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="Phone *" className="mono rounded-sm border border-border bg-background px-3 py-2 text-sm" />
            <input value={email} onChange={(e) => setEmail(e.target.value)} placeholder="Email" type="email" className="mono rounded-sm border border-border bg-background px-3 py-2 text-sm" />
            <textarea value={jobSite} onChange={(e) => setJobSite(e.target.value)} placeholder="Job site address *" rows={2} className="mono rounded-sm border border-border bg-background px-3 py-2 text-sm sm:col-span-2" />
          </div>
        </section>

        <section className="panel p-5 space-y-3">
          <div className="label-eyebrow">Line items</div>
          {items.map((it, i) => (
            <div key={i} className="flex gap-2">
              <input
                value={it.label}
                onChange={(e) =>
                  setItems((prev) => prev.map((p, j) => (j === i ? { ...p, label: e.target.value } : p)))
                }
                placeholder="Description"
                className="mono flex-1 rounded-sm border border-border bg-background px-3 py-2 text-sm"
              />
              <input
                value={it.amount}
                onChange={(e) =>
                  setItems((prev) => prev.map((p, j) => (j === i ? { ...p, amount: e.target.value } : p)))
                }
                placeholder="0.00"
                inputMode="decimal"
                className="mono w-32 rounded-sm border border-border bg-background px-3 py-2 text-sm text-right"
              />
              <button
                onClick={() => setItems((prev) => (prev.length === 1 ? prev : prev.filter((_, j) => j !== i)))}
                className="mono rounded-sm border border-border px-2 text-[10px] uppercase text-muted-foreground hover:border-destructive hover:text-destructive"
                aria-label="Remove line item"
              >
                ✕
              </button>
            </div>
          ))}
          <button
            onClick={() => setItems((prev) => [...prev, { label: "", amount: "" }])}
            className="mono rounded-sm border border-border px-3 py-1.5 text-[10px] uppercase tracking-widest text-muted-foreground hover:border-primary hover:text-primary"
          >
            + add line
          </button>
          <div className="flex items-center gap-3 pt-2">
            <span className="mono text-[11px] uppercase tracking-widest text-muted-foreground">
              tax rate %
            </span>
            <input
              value={taxRate}
              onChange={(e) => setTaxRate(e.target.value)}
              inputMode="decimal"
              className="mono w-24 rounded-sm border border-border bg-background px-3 py-2 text-sm text-right"
            />
          </div>
        </section>

        <section className="panel p-5 space-y-1 text-sm">
          <div className="label-eyebrow mb-2">Totals</div>
          <div className="flex justify-between mono">
            <span className="text-muted-foreground">Subtotal</span>
            <span>{fmtMoney(totals.subtotal)}</span>
          </div>
          <div className="flex justify-between mono">
            <span className="text-muted-foreground">Tax</span>
            <span>{fmtMoney(totals.taxAmount)}</span>
          </div>
          <div className="flex justify-between font-display text-lg border-t border-border pt-2 mt-2">
            <span>Total</span>
            <span className="mono">{fmtMoney(totals.total)}</span>
          </div>
          {inv.deposit_paid && Number(inv.deposit_amount) > 0 && (
            <div className="flex justify-between mono text-moss">
              <span>Deposit credited</span>
              <span>− {fmtMoney(inv.deposit_amount)}</span>
            </div>
          )}
          <div className="flex justify-between font-display text-xl border-t border-border pt-2 mt-2">
            <span>Balance due</span>
            <span className="mono">{fmtMoney(projectedBalance)}</span>
          </div>
        </section>

        <div className="flex gap-3">
          <button
            disabled={saving}
            onClick={handleSave}
            className="rounded-sm bg-primary px-5 py-2.5 font-display uppercase tracking-wider text-primary-foreground disabled:opacity-60"
          >
            {saving ? "Saving…" : isDraft ? "Save draft" : "Save as new invoice"}
          </button>
          <button
            onClick={() => navigate({ to: "/dashboard/invoices" })}
            className="mono rounded-sm border border-border px-4 py-2.5 text-[11px] uppercase tracking-widest text-muted-foreground hover:border-primary hover:text-primary"
          >
            cancel
          </button>
        </div>
      </div>
    </div>
  );
}
