import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Fragment, useState } from "react";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { PageHeader } from "@/components/AppShell";
import { CustomerHistory } from "@/components/CustomerHistory";
import { sendQuoteSms } from "@/lib/quote-sms.functions";

export const Route = createFileRoute("/_authenticated/dashboard/quotes/")({
  component: QuotesListPage,
});

type QuoteRow = {
  id: string;
  customer_id: string | null;
  customer_first_name: string;
  customer_last_name: string | null;
  customer_business_name: string | null;
  job_site_address: string;
  total_amount: number;
  status: "draft" | "sent" | "accepted" | "declined" | "expired" | "archived";
  created_at: string;
  valid_until: string | null;
  superseded_by_id: string | null;
};

const STATUS_STYLES: Record<QuoteRow["status"], string> = {
  draft: "bg-muted text-muted-foreground",
  sent: "bg-steel/20 text-paper",
  accepted: "bg-moss/30 text-paper",
  declined: "bg-destructive/20 text-paper",
  expired: "bg-orange/20 text-paper",
  archived: "bg-muted/40 text-muted-foreground line-through",
};

function fmtMoney(n: number) {
  return n.toLocaleString("en-US", { style: "currency", currency: "USD" });
}
function fmtDate(s: string | null) {
  return s ? new Date(s).toLocaleDateString() : "—";
}

function QuotesListPage() {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [showArchived, setShowArchived] = useState(false);
  const [sendingId, setSendingId] = useState<string | null>(null);
  const sendSmsFn = useServerFn(sendQuoteSms);
  const toggle = (id: string) => setExpanded((prev) => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  async function handleSendSms(quoteId: string, force = false) {
    setSendingId(quoteId);
    try {
      const res = await sendSmsFn({ data: { quoteId, force } });
      if (!res.ok && res.reason === "cooldown") {
        if (window.confirm(`Already sent ${res.minutesAgo} minute(s) ago — send again?`)) {
          await handleSendSms(quoteId, true);
          return;
        }
        toast.info("Send canceled.");
        return;
      }
      toast.success(`SMS sent · ${"sid" in res ? res.sid : ""}`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Send failed");
    } finally {
      setSendingId(null);
    }
  }

  const { data: quotes, isLoading } = useQuery({
    queryKey: ["quotes"],
    refetchOnWindowFocus: true,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("quotes")
        .select("id, customer_id, customer_first_name, customer_last_name, customer_business_name, job_site_address, total_amount, status, created_at, valid_until, superseded_by_id")
        .order("created_at", { ascending: false });
      if (error) throw error;
      return (data ?? []) as unknown as QuoteRow[];
    },
  });

  const visible = (quotes ?? []).filter((q) => showArchived || q.status !== "archived");
  const archivedCount = (quotes ?? []).filter((q) => q.status === "archived").length;

  return (
    <div>
      <PageHeader
        eyebrow="Estimates"
        title="Quotes"
        actions={
          <Link
            to="/dashboard/quotes/new"
            className="rounded-sm bg-primary px-4 py-2 text-xs font-display uppercase tracking-wider text-primary-foreground"
          >
            + Create Quote
          </Link>
        }
      />
      <div className="p-5 md:p-8 space-y-5">
        {archivedCount > 0 && (
          <div className="flex items-center gap-2">
            <button
              onClick={() => setShowArchived((v) => !v)}
              className="mono rounded-sm border border-border px-3 py-1.5 text-[10px] uppercase tracking-widest text-muted-foreground hover:border-primary hover:text-primary"
            >
              {showArchived ? "▾ hide archived" : "▸ show archived"} ({archivedCount})
            </button>
          </div>
        )}
        {isLoading && <div className="text-muted-foreground">Loading…</div>}
        {!isLoading && visible.length === 0 && (
          <div className="panel p-6 text-sm text-muted-foreground">
            No quotes yet. Hit <span className="mono">+ Create Quote</span> to build your first one.
          </div>
        )}

        {visible.length > 0 && (
          <div className="panel overflow-hidden">
            <table className="w-full text-sm">
              <thead className="mono text-[10px] uppercase tracking-widest text-muted-foreground">
                <tr className="border-b border-border">
                  <th className="px-2 py-3 w-6"></th>
                  <th className="px-4 py-3 text-left">Customer</th>
                  <th className="px-4 py-3 text-left hidden md:table-cell">Job site</th>
                  <th className="px-4 py-3 text-right">Total</th>
                  <th className="px-4 py-3 text-left">Status</th>
                  <th className="px-4 py-3 text-left hidden lg:table-cell">Valid until</th>
                  <th className="px-4 py-3 text-left hidden md:table-cell">Created</th>
                  <th className="px-4 py-3 text-right">Actions</th>
                </tr>
              </thead>
              <tbody>
                {visible.map((q) => {
                  const name = [q.customer_first_name, q.customer_last_name].filter(Boolean).join(" ");
                  const isOpen = expanded.has(q.id);
                  return (
                    <Fragment key={q.id}>
                      <tr
                        className="border-b border-border/50 hover:bg-accent/30 cursor-pointer"
                        onClick={() => toggle(q.id)}
                      >
                        <td className="px-2 py-3 text-center mono text-xs text-muted-foreground select-none">
                          {isOpen ? "▾" : "▸"}
                        </td>
                        <td className="px-4 py-3">
                          <div className="font-medium">{name || "Unnamed"}</div>
                          {q.customer_business_name && (
                            <div className="mono text-[10px] text-muted-foreground">{q.customer_business_name}</div>
                          )}
                          {q.superseded_by_id && (
                            <div className="mono text-[10px] text-orange">// superseded by newer revision</div>
                          )}
                        </td>
                        <td className="px-4 py-3 mono text-xs hidden md:table-cell">{q.job_site_address}</td>
                        <td className="px-4 py-3 mono text-right">{fmtMoney(Number(q.total_amount))}</td>
                        <td className="px-4 py-3">
                          <span className={`rounded-sm px-2 py-0.5 text-[10px] uppercase tracking-wider mono ${STATUS_STYLES[q.status]}`}>
                            {q.status}
                          </span>
                        </td>
                        <td className="px-4 py-3 mono text-[10px] text-muted-foreground hidden lg:table-cell">{fmtDate(q.valid_until)}</td>
                        <td className="px-4 py-3 mono text-[10px] text-muted-foreground hidden md:table-cell">{fmtDate(q.created_at)}</td>
                        <td className="px-4 py-3 text-right whitespace-nowrap" onClick={(e) => e.stopPropagation()}>
                          <div className="inline-flex gap-1">
                            {q.status !== "archived" && (
                              <Link
                                to="/dashboard/quotes/new"
                                search={{ edit: q.id }}
                                className="mono rounded-sm border border-border px-2 py-1 text-[10px] uppercase tracking-wider text-muted-foreground hover:border-primary hover:text-primary"
                              >
                                edit
                              </Link>
                            )}
                            <a
                              href={`/dashboard/quotes/${q.id}/print`}
                              target="_blank"
                              rel="noreferrer"
                              className="mono rounded-sm border border-border px-2 py-1 text-[10px] uppercase tracking-wider text-muted-foreground hover:border-primary hover:text-primary"
                            >
                              export
                            </a>
                            {(q.status === "draft" || q.status === "sent") && (
                              <button
                                disabled={sendingId === q.id}
                                onClick={() => handleSendSms(q.id)}
                                className="mono rounded-sm border border-primary/60 px-2 py-1 text-[10px] uppercase tracking-wider text-primary hover:bg-primary hover:text-primary-foreground disabled:opacity-50"
                              >
                                {sendingId === q.id ? "…" : q.status === "draft" ? "send sms" : "resend sms"}
                              </button>
                            )}
                          </div>
                        </td>
                      </tr>
                      {isOpen && (
                        <tr className="border-b border-border/50 bg-background/40">
                          <td></td>
                          <td colSpan={7} className="px-4 py-4">
                            <div className="label-eyebrow mb-3">
                              Quote detail + customer history {name ? `· ${name}` : ""}
                            </div>
                            <CustomerHistory customerId={q.customer_id} />
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
