import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useMemo } from "react";
import { supabase } from "@/integrations/supabase/client";
import { signIntakePhotos } from "@/lib/intake.functions";

type Props = {
  customerId: string | null | undefined;
  /** Exclude a specific quote id (e.g. when viewing that quote itself). */
  excludeQuoteId?: string;
};

type QuoteRow = {
  id: string;
  customer_first_name: string;
  customer_last_name: string | null;
  po_number: string | null;
  job_site_address: string;
  billing_address: string | null;
  description: string | null;
  line_items: Array<{ key?: string; label?: string; description?: string; amount?: number | string }> | null;
  subtotal: number | string | null;
  tax_rate: number | string | null;
  tax_amount: number | string | null;
  total_amount: number | string;
  status: string;
  job_type: string | null;
  tax_exempt: boolean | null;
  valid_until: string | null;
  created_at: string;
};

type IntakeRow = {
  id: string;
  customer_first_name: string;
  customer_last_name: string;
  customer_business_name: string | null;
  customer_phone: string;
  customer_email: string | null;
  responses: Record<string, unknown> | null;
  photo_urls: string[] | null;
  source: string;
  status: string;
  submitted_at: string;
};

function fmtMoney(n: number | string | null | undefined) {
  const v = typeof n === "string" ? Number(n) : (n ?? 0);
  return v.toLocaleString("en-US", { style: "currency", currency: "USD" });
}
function fmtDate(s: string | null | undefined) {
  return s ? new Date(s).toLocaleDateString() : "—";
}
function fmtDateTime(s: string | null | undefined) {
  return s ? new Date(s).toLocaleString() : "—";
}

const STATUS_STYLES: Record<string, string> = {
  draft: "bg-muted text-muted-foreground",
  sent: "bg-steel/20 text-paper",
  accepted: "bg-moss/30 text-paper",
  declined: "bg-destructive/20 text-paper",
  expired: "bg-orange/20 text-paper",
  new: "bg-violet/20 text-paper",
  contacted: "bg-steel/20 text-paper",
  quoted: "bg-moss/30 text-paper",
  closed: "bg-muted text-muted-foreground",
};

export function CustomerHistory({ customerId, excludeQuoteId }: Props) {
  const sign = useServerFn(signIntakePhotos);

  const enabled = !!customerId;

  const { data: quotes, isLoading: qLoading } = useQuery({
    queryKey: ["customer-history-quotes", customerId],
    enabled,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("quotes")
        .select("id, customer_first_name, customer_last_name, job_site_address, description, line_items, subtotal, tax_amount, total_amount, status, job_type, tax_exempt, valid_until, created_at")
        .eq("customer_id", customerId!)
        .order("created_at", { ascending: false });
      if (error) throw error;
      return (data ?? []) as unknown as QuoteRow[];
    },
  });

  const { data: intakes, isLoading: iLoading } = useQuery({
    queryKey: ["customer-history-intakes", customerId],
    enabled,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("intake_submissions")
        .select("id, customer_first_name, customer_last_name, customer_business_name, customer_phone, customer_email, responses, photo_urls, source, status, submitted_at")
        .eq("customer_id", customerId!)
        .order("submitted_at", { ascending: false });
      if (error) throw error;
      return (data ?? []) as unknown as IntakeRow[];
    },
  });

  const allPhotoPaths = useMemo(
    () => (intakes ?? []).flatMap((r) => r.photo_urls ?? []),
    [intakes],
  );

  const { data: signed } = useQuery({
    queryKey: ["customer-history-photo-urls", allPhotoPaths],
    enabled: allPhotoPaths.length > 0,
    queryFn: async () => (await sign({ data: { paths: allPhotoPaths } })).urls,
  });

  if (!customerId) {
    return (
      <div className="mono text-xs text-muted-foreground italic">
        // no linked contact — history unavailable
      </div>
    );
  }

  if (qLoading || iLoading) {
    return <div className="mono text-xs text-muted-foreground">// loading history…</div>;
  }

  const filteredQuotes = (quotes ?? []).filter((q) => q.id !== excludeQuoteId);
  const isEmpty = filteredQuotes.length === 0 && (intakes ?? []).length === 0;

  if (isEmpty) {
    return (
      <div className="mono text-xs text-muted-foreground italic">
        // no prior submissions or quotes on file
      </div>
    );
  }

  return (
    <div className="space-y-5">
      {/* QUOTES */}
      {filteredQuotes.length > 0 && (
        <section>
          <div className="label-eyebrow mb-2">
            Quotes ({filteredQuotes.length})
          </div>
          <div className="space-y-3">
            {filteredQuotes.map((q) => {
              const items = Array.isArray(q.line_items) ? q.line_items : [];
              return (
                <div key={q.id} className="rounded-sm border border-border bg-background/40 p-3">
                  <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <div className="mono text-[10px] uppercase tracking-widest text-muted-foreground">
                      {fmtDateTime(q.created_at)} · {q.job_type || "—"} · valid {fmtDate(q.valid_until)}
                    </div>
                    <span className={`rounded-sm px-2 py-0.5 text-[10px] uppercase tracking-wider mono ${STATUS_STYLES[q.status] || "bg-muted text-muted-foreground"}`}>
                      {q.status}
                    </span>
                  </div>
                  <div className="mono text-xs text-paper mt-1">{q.job_site_address}</div>
                  {q.description && (
                    <div className="mono text-xs text-muted-foreground mt-1 whitespace-pre-wrap">{q.description}</div>
                  )}
                  {items.length > 0 && (
                    <table className="w-full mt-2 text-xs mono">
                      <tbody>
                        {items.map((li, i) => (
                          <tr key={i} className="border-t border-border/40">
                            <td className="py-1 pr-2 text-muted-foreground">{li.label || li.description || (li.key ? li.key.replace(/_/g, " ") : "—")}</td>
                            <td className="py-1 text-right">{fmtMoney(li.amount as any)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                  <div className="mono mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-muted-foreground">
                    <span>subtotal {fmtMoney(q.subtotal)}</span>
                    <span>tax {fmtMoney(q.tax_amount)}{q.tax_exempt ? " (exempt)" : ""}</span>
                    <span className="text-paper">total {fmtMoney(q.total_amount)}</span>
                  </div>
                </div>
              );
            })}
          </div>
        </section>
      )}

      {/* INTAKES */}
      {(intakes ?? []).length > 0 && (
        <section>
          <div className="label-eyebrow mb-2">
            Intake submissions ({intakes!.length})
          </div>
          <div className="space-y-3">
            {intakes!.map((r) => {
              const resp = (r.responses ?? {}) as Record<string, unknown>;
              return (
                <div key={r.id} className="rounded-sm border border-border bg-background/40 p-3">
                  <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <div className="mono text-[10px] uppercase tracking-widest text-muted-foreground">
                      {fmtDateTime(r.submitted_at)} · via {r.source}
                    </div>
                    <span className={`rounded-sm px-2 py-0.5 text-[10px] uppercase tracking-wider mono ${STATUS_STYLES[r.status] || "bg-muted text-muted-foreground"}`}>
                      {r.status}
                    </span>
                  </div>
                  <dl className="mt-2 grid gap-x-4 gap-y-1 text-xs md:grid-cols-2">
                    {Object.entries(resp).map(([k, v]) => (
                      <div key={k}>
                        <dt className="label-eyebrow text-[10px] uppercase tracking-wider text-muted-foreground">{k.replace(/_/g, " ")}</dt>
                        <dd className="mono text-xs whitespace-pre-wrap">{v == null || v === "" ? "—" : String(v)}</dd>
                      </div>
                    ))}
                  </dl>
                  {(r.photo_urls?.length ?? 0) > 0 && (
                    <div className="mt-3 flex flex-wrap gap-2">
                      {r.photo_urls!.map((p) => (
                        <a key={p} href={signed?.[p]} target="_blank" rel="noreferrer" className="block">
                          {signed?.[p] ? (
                            <img src={signed[p]} alt="" className="h-20 w-20 rounded-sm border border-border object-cover" />
                          ) : (
                            <div className="h-20 w-20 rounded-sm border border-border bg-muted" />
                          )}
                        </a>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </section>
      )}
    </div>
  );
}
