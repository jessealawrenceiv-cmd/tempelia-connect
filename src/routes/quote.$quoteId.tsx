import { createFileRoute } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { getPublicQuote, respondToQuote } from "@/lib/quote-public.functions";

export const Route = createFileRoute("/quote/$quoteId")({
  head: () => ({
    meta: [
      { title: "Your quote — Tempelia" },
      { name: "description", content: "Review your quote and accept or decline." },
      { name: "robots", content: "noindex" },
    ],
  }),
  component: PublicQuotePage,
});

function fmtMoney(n: number | string | null | undefined) {
  const v = Number(n ?? 0);
  return v.toLocaleString("en-US", { style: "currency", currency: "USD" });
}
function fmtDate(s: string | null | undefined) {
  return s ? new Date(s).toLocaleDateString("en-US") : "—";
}

type LineItem = { label?: string; amount?: number | string };

const STATUS_LABEL: Record<string, string> = {
  draft: "Draft — not yet sent",
  sent: "Awaiting your response",
  accepted: "Accepted",
  declined: "Declined",
  expired: "Expired",
  archived: "This quote has been replaced by a newer version",
};

function PublicQuotePage() {
  const { quoteId } = Route.useParams();
  const getFn = useServerFn(getPublicQuote);
  const respondFn = useServerFn(respondToQuote);
  const qc = useQueryClient();
  const [err, setErr] = useState<string | null>(null);

  const { data, isLoading } = useQuery({
    queryKey: ["public-quote", quoteId],
    queryFn: () => getFn({ data: { quoteId } }),
  });

  const respond = useMutation({
    mutationFn: (response: "accepted" | "declined") =>
      respondFn({ data: { quoteId, response } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["public-quote", quoteId] }),
    onError: (e: Error) => setErr(e.message),
  });

  if (isLoading) {
    return <div className="min-h-screen bg-background p-8 text-muted-foreground mono">Loading…</div>;
  }
  if (!data) {
    return (
      <div className="min-h-screen bg-background p-8">
        <div className="max-w-2xl mx-auto panel p-8">
          <h1 className="font-display text-2xl mb-2">Quote not found</h1>
          <p className="text-muted-foreground">This link may be invalid or expired.</p>
        </div>
      </div>
    );
  }

  const items: LineItem[] = Array.isArray(data.line_items) ? (data.line_items as LineItem[]) : [];
  const status = data.status as string;
  const showButtons = status === "sent";
  const customerName = [data.customer_first_name, data.customer_last_name].filter(Boolean).join(" ");

  return (
    <div className="min-h-screen bg-background p-4 md:p-8">
      <div className="max-w-2xl mx-auto space-y-5">
        <header className="panel p-6">
          <div className="mono text-[10px] uppercase tracking-widest text-muted-foreground">
            Quote from
          </div>
          <h1 className="font-display text-2xl md:text-3xl">{data.business_name || "—"}</h1>
          <div className="mt-4 text-sm text-muted-foreground">
            Prepared for <span className="text-paper">{customerName || "—"}</span>
            {data.customer_business_name ? ` · ${data.customer_business_name}` : ""}
          </div>
          <div className="mt-1 mono text-[11px] text-muted-foreground">
            Quote ID {String(data.id).slice(0, 8)} · Valid until {fmtDate(data.valid_until)}
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
                  <td className="py-2 pr-4">{it.label || <span className="text-muted-foreground">(unlabeled)</span>}</td>
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
          </div>
        </section>

        <section className="panel p-6">
          {showButtons ? (
            <>
              <div className="label-eyebrow mb-3">Your response</div>
              <div className="flex flex-col sm:flex-row gap-3">
                <button
                  disabled={respond.isPending}
                  onClick={() => { setErr(null); respond.mutate("accepted"); }}
                  className="flex-1 rounded-sm bg-primary px-4 py-3 font-display uppercase tracking-wider text-primary-foreground disabled:opacity-60"
                >
                  Accept quote
                </button>
                <button
                  disabled={respond.isPending}
                  onClick={() => { setErr(null); respond.mutate("declined"); }}
                  className="flex-1 rounded-sm border border-border px-4 py-3 font-display uppercase tracking-wider text-paper hover:border-destructive hover:text-destructive disabled:opacity-60"
                >
                  Decline
                </button>
              </div>
              {err && <div className="mt-3 text-sm text-destructive mono">{err}</div>}
            </>
          ) : (
            <div>
              <div className="label-eyebrow mb-2">Status</div>
              <div className="font-display text-xl">{STATUS_LABEL[status] ?? status}</div>
              {data.responded_at && (
                <div className="mono text-[11px] text-muted-foreground mt-1">
                  Recorded {new Date(data.responded_at).toLocaleString("en-US")}
                </div>
              )}
              <p className="text-sm text-muted-foreground mt-3">
                If you need to change this, please contact {data.business_name || "the business"} directly.
              </p>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
