import { createFileRoute } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useQuery } from "@tanstack/react-query";
import { getPublicInvoice } from "@/lib/invoice-public.functions";
import {
  INVOICE_STATUS_LABEL,
  contactToPayLine,
  depositCreditedLine,
  fmtMoney,
  invoiceBalanceDue,
  type InvoiceLineItem,
  type InvoiceStatus,
} from "@/lib/invoice";

export const Route = createFileRoute("/invoice/$invoiceId")({
  head: () => ({
    meta: [
      { title: "Your invoice — Temaro" },
      { name: "description", content: "Review your invoice, deposit credited and balance due." },
      { property: "og:title", content: "Your invoice — Temaro" },
      { property: "og:description", content: "Review your invoice, deposit credited and balance due." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
      { name: "robots", content: "noindex" },
    ],
  }),
  component: PublicInvoicePage,
});

function fmtDate(s: string | null | undefined) {
  return s ? new Date(s).toLocaleDateString("en-US") : "—";
}

function PublicInvoicePage() {
  const { invoiceId } = Route.useParams();
  const getFn = useServerFn(getPublicInvoice);
  const { data, isLoading } = useQuery({
    queryKey: ["public-invoice", invoiceId],
    queryFn: () => getFn({ data: { invoiceId } }),
  });

  if (isLoading) {
    return <div className="min-h-screen bg-background p-8 text-muted-foreground mono">Loading…</div>;
  }
  if (!data) {
    return (
      <div className="min-h-screen bg-background p-8">
        <div className="max-w-2xl mx-auto panel p-8">
          <h1 className="font-display text-2xl mb-2">Invoice not found</h1>
          <p className="text-muted-foreground">This link may be invalid or expired.</p>
        </div>
      </div>
    );
  }

  const items: InvoiceLineItem[] = Array.isArray(data.line_items)
    ? (data.line_items as InvoiceLineItem[])
    : [];
  const customerName = [data.customer_first_name, data.customer_last_name].filter(Boolean).join(" ");
  const balance = invoiceBalanceDue({
    total: data.total_amount,
    depositAmount: data.deposit_amount,
    depositPaid: data.deposit_paid,
  });
  const creditLine = depositCreditedLine({
    depositAmount: data.deposit_amount,
    depositPaid: data.deposit_paid,
  });
  const isPaid = data.status === "paid";

  return (
    <div className="min-h-screen bg-background p-4 md:p-8">
      <div className="max-w-2xl mx-auto space-y-5">
        <header className="panel p-6">
          <div className="mono text-[10px] uppercase tracking-widest text-muted-foreground">
            Invoice from
          </div>
          <h1 className="font-display text-2xl md:text-3xl">{data.business_name || "—"}</h1>
          <div className="mt-3 mono text-sm text-primary">{data.invoice_number}</div>
          <div className="mt-3 text-sm text-muted-foreground">
            Prepared for <span className="text-paper">{customerName || "—"}</span>
            {data.customer_business_name ? ` · ${data.customer_business_name}` : ""}
          </div>
          <div className="mt-1 mono text-[11px] text-muted-foreground">
            Issued {fmtDate(data.sent_at ?? data.created_at)}
          </div>
        </header>

        <section className="panel p-6">
          <div className="label-eyebrow mb-3">Job site</div>
          <div className="mono text-sm text-paper whitespace-pre-line">{data.job_site_address}</div>
        </section>

        <section className="panel p-6">
          <div className="label-eyebrow mb-3">Line items</div>
          <table className="w-full text-sm">
            <tbody>
              {items.map((it, i) => (
                <tr key={i} className="border-b border-border/50 last:border-0">
                  <td className="py-2 pr-4">
                    {it.label || <span className="text-muted-foreground">(unlabeled)</span>}
                  </td>
                  <td className="py-2 mono text-right">{fmtMoney(it.amount)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="mt-4 space-y-1 text-sm">
            <div className="flex justify-between mono">
              <span className="text-muted-foreground">Subtotal</span>
              <span>{fmtMoney(data.subtotal)}</span>
            </div>
            <div className="flex justify-between mono">
              <span className="text-muted-foreground">
                Tax {data.tax_rate ? `@ ${Number(data.tax_rate).toFixed(2)}%` : ""}
              </span>
              <span>{fmtMoney(data.tax_amount)}</span>
            </div>
            <div className="flex justify-between border-t border-border pt-2 mt-2 font-display text-lg">
              <span>Total</span>
              <span className="mono">{fmtMoney(data.total_amount)}</span>
            </div>
            {creditLine && (
              <div className="flex justify-between mono text-moss">
                <span>Deposit already credited</span>
                <span>− {fmtMoney(data.deposit_amount)}</span>
              </div>
            )}
            <div className="flex justify-between border-t border-border pt-2 mt-2 font-display text-xl">
              <span>Balance due</span>
              <span className="mono">{fmtMoney(balance)}</span>
            </div>
          </div>
          {creditLine && <p className="mt-3 mono text-[11px] text-moss">{creditLine}</p>}
        </section>

        <section className="panel p-6">
          <div className="label-eyebrow mb-2">Status</div>
          <div className="font-display text-xl">
            {INVOICE_STATUS_LABEL[data.status as InvoiceStatus] ?? data.status}
          </div>
          {isPaid && data.balance_paid_at && (
            <div className="mono text-[11px] text-moss mt-1">
              Payment recorded {fmtDate(data.balance_paid_at)} — thank you.
            </div>
          )}
          {!isPaid && (
            <p className="text-sm text-muted-foreground mt-3">
              {contactToPayLine(data.business_name)} No payment is collected on this page.
              {data.business_phone ? ` Reach them at ${data.business_phone}.` : ""}
            </p>
          )}
          {data.status === "archived" && (
            <p className="text-sm text-muted-foreground mt-3">
              A newer invoice has replaced this one. Please use the most recent link you received.
            </p>
          )}
        </section>
      </div>
    </div>
  );
}
