import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { Fragment, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { PageHeader } from "@/components/AppShell";
import { CustomerHistory } from "@/components/CustomerHistory";

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
  status: "draft" | "sent" | "accepted" | "declined" | "expired";
  created_at: string;
  valid_until: string | null;
};


const STATUS_STYLES: Record<QuoteRow["status"], string> = {
  draft: "bg-muted text-muted-foreground",
  sent: "bg-steel/20 text-paper",
  accepted: "bg-moss/30 text-paper",
  declined: "bg-destructive/20 text-paper",
  expired: "bg-orange/20 text-paper",
};

function fmtMoney(n: number) {
  return n.toLocaleString("en-US", { style: "currency", currency: "USD" });
}
function fmtDate(s: string | null) {
  return s ? new Date(s).toLocaleDateString() : "—";
}

function QuotesListPage() {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const toggle = (id: string) => setExpanded((prev) => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  const { data: quotes, isLoading } = useQuery({
    queryKey: ["quotes"],
    refetchOnWindowFocus: true,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("quotes")
        .select("id, customer_id, customer_first_name, customer_last_name, customer_business_name, job_site_address, total_amount, status, created_at, valid_until")
        .order("created_at", { ascending: false });
      if (error) throw error;
      return (data ?? []) as unknown as QuoteRow[];
    },
  });


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
        {isLoading && <div className="text-muted-foreground">Loading…</div>}
        {!isLoading && (quotes?.length ?? 0) === 0 && (
          <div className="panel p-6 text-sm text-muted-foreground">
            No quotes yet. Hit <span className="mono">+ Create Quote</span> to build your first one.
          </div>
        )}

        {(quotes?.length ?? 0) > 0 && (
          <div className="panel overflow-hidden">
            <table className="w-full text-sm">
              <thead className="mono text-[10px] uppercase tracking-widest text-muted-foreground">
                <tr className="border-b border-border">
                  <th className="px-4 py-3 text-left">Customer</th>
                  <th className="px-4 py-3 text-left hidden md:table-cell">Job site</th>
                  <th className="px-4 py-3 text-right">Total</th>
                  <th className="px-4 py-3 text-left">Status</th>
                  <th className="px-4 py-3 text-left hidden lg:table-cell">Valid until</th>
                  <th className="px-4 py-3 text-left hidden md:table-cell">Created</th>
                </tr>
              </thead>
              <tbody>
                {quotes!.map((q) => {
                  const name = [q.customer_first_name, q.customer_last_name].filter(Boolean).join(" ");
                  return (
                    <tr key={q.id} className="border-b border-border/50 hover:bg-accent/30">
                      <td className="px-4 py-3">
                        <div className="font-medium">{name || "Unnamed"}</div>
                        {q.customer_business_name && (
                          <div className="mono text-[10px] text-muted-foreground">{q.customer_business_name}</div>
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
                    </tr>
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
