import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Fragment, useState } from "react";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { PageHeader } from "@/components/AppShell";
import {
  markInvoiceBalance,
  sendInvoiceSms,
  getInvoiceAudit,
} from "@/lib/invoice.functions";
import { fmtMoney, INVOICE_STATUS_LABEL, type InvoiceStatus } from "@/lib/invoice";

export const Route = createFileRoute("/_authenticated/dashboard/invoices/")({
  component: InvoicesListPage,
});

type InvoiceRow = {
  id: string;
  quote_id: string | null;
  invoice_number: string;
  invoice_seq: number;
  customer_first_name: string;
  customer_last_name: string | null;
  customer_business_name: string | null;
  customer_phone: string;
  job_site_address: string;
  total_amount: number;
  deposit_amount: number;
  deposit_paid: boolean;
  balance_due: number | null;
  status: InvoiceStatus;
  superseded_by_id: string | null;
  balance_paid_at: string | null;
  sent_at: string | null;
  created_at: string;
};

const STATUS_STYLES: Record<InvoiceStatus, string> = {
  draft: "bg-muted text-muted-foreground",
  sent: "bg-steel/20 text-paper",
  paid: "bg-moss/30 text-paper",
  archived: "bg-muted/40 text-muted-foreground line-through",
};

function fmtDate(s: string | null) {
  return s ? new Date(s).toLocaleDateString() : "—";
}

function InvoiceAuditTrail({ invoiceId }: { invoiceId: string }) {
  const getAudit = useServerFn(getInvoiceAudit);
  const { data, isLoading } = useQuery({
    queryKey: ["invoice-audit", invoiceId],
    queryFn: () => getAudit({ data: { invoiceId } }),
  });
  if (isLoading) return <div className="mono text-[11px] text-muted-foreground">loading audit…</div>;
  if (!data || data.length === 0) {
    return <div className="mono text-[11px] text-muted-foreground">// no audit entries yet</div>;
  }
  return (
    <ul className="space-y-2">
      {data.map((row) => {
        let payload: Record<string, unknown> = {};
        try {
          payload = JSON.parse(row.message_sent ?? "{}") as Record<string, unknown>;
        } catch {
          /* keep empty */
        }
        return (
          <li key={row.id} className="rounded-sm border border-border/60 bg-background/40 p-2">
            <div className="mono text-[10px] uppercase tracking-widest text-primary">{row.status}</div>
            <div className="mono text-[11px] text-muted-foreground">
              {new Date(row.created_at).toLocaleString("en-US")} ·{" "}
              {String(payload["actor_email"] ?? "system")}
              {payload["actor_is_owner"] ? " (owner)" : ""}
            </div>
            <div className="mono text-[11px] text-paper">
              status {String(payload["previous_status"] ?? "—")} → {String(payload["new_status"] ?? "—")}
              {" · "}balance {fmtMoney(payload["previous_balance_due"] as number)} →{" "}
              {fmtMoney(payload["new_balance_due"] as number)}
            </div>
          </li>
        );
      })}
    </ul>
  );
}

function InvoicesListPage() {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [showArchived, setShowArchived] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const markFn = useServerFn(markInvoiceBalance);
  const sendFn = useServerFn(sendInvoiceSms);
  const qc = useQueryClient();

  const toggle = (id: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const { data: invoices, isLoading } = useQuery({
    queryKey: ["invoices"],
    refetchOnWindowFocus: true,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("invoices")
        .select(
          "id, quote_id, invoice_number, invoice_seq, customer_first_name, customer_last_name, customer_business_name, customer_phone, job_site_address, total_amount, deposit_amount, deposit_paid, balance_due, status, superseded_by_id, balance_paid_at, sent_at, created_at",
        )
        .order("invoice_seq", { ascending: false });
      if (error) throw error;
      return (data ?? []) as unknown as InvoiceRow[];
    },
  });

  async function handleSend(invoiceId: string, force = false) {
    setBusyId(invoiceId);
    try {
      const res = await sendFn({ data: { invoiceId, force } });
      if (!res.ok && res.reason === "cooldown") {
        if (window.confirm(`Already sent ${res.minutesAgo} minute(s) ago — send again?`)) {
          setBusyId(null);
          await handleSend(invoiceId, true);
          return;
        }
        toast.info("Send canceled.");
        return;
      }
      toast.success("Invoice SMS sent.");
      qc.invalidateQueries({ queryKey: ["invoices"] });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Send failed");
    } finally {
      setBusyId(null);
    }
  }

  async function handleMark(invoiceId: string, paid: boolean) {
    if (!paid && !window.confirm("Undo this payment? The action is recorded in the log.")) return;
    setBusyId(invoiceId);
    try {
      await markFn({ data: { invoiceId, paid } });
      toast.success(paid ? "Balance marked received." : "Payment receipt undone.");
      qc.invalidateQueries({ queryKey: ["invoices"] });
      qc.invalidateQueries({ queryKey: ["invoice-audit", invoiceId] });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Update failed");
    } finally {
      setBusyId(null);
    }
  }

  const visible = (invoices ?? []).filter((i) => showArchived || i.status !== "archived");
  const archivedCount = (invoices ?? []).filter((i) => i.status === "archived").length;

  return (
    <div>
      <PageHeader
        eyebrow="Billing"
        title="Invoices"
        actions={
          <Link
            to="/dashboard/quotes"
            className="mono rounded-sm border border-border px-3 py-2 text-[10px] uppercase tracking-widest text-muted-foreground hover:border-primary hover:text-primary"
          >
            create from accepted quote →
          </Link>
        }
      />
      <div className="p-5 md:p-8 space-y-5">
        <div className="rounded-sm border border-border bg-background/40 px-3 py-2 mono text-[11px] text-muted-foreground">
          // tracking only — Temaro does not collect payments yet. Mark a balance received once
          the customer pays you directly.
        </div>

        {archivedCount > 0 && (
          <button
            onClick={() => setShowArchived((v) => !v)}
            className="mono rounded-sm border border-border px-3 py-1.5 text-[10px] uppercase tracking-widest text-muted-foreground hover:border-primary hover:text-primary"
          >
            {showArchived ? "▾ hide archived" : "▸ show archived"} ({archivedCount})
          </button>
        )}

        {isLoading && <div className="text-muted-foreground">Loading…</div>}
        {!isLoading && visible.length === 0 && (
          <div className="panel p-6 text-sm text-muted-foreground">
            No invoices yet. Open an accepted quote and hit{" "}
            <span className="mono">create invoice</span>.
          </div>
        )}

        {visible.length > 0 && (
          <div className="panel overflow-hidden">
            <table className="w-full text-sm">
              <thead className="mono text-[10px] uppercase tracking-widest text-muted-foreground">
                <tr className="border-b border-border">
                  <th className="px-2 py-3 w-6"></th>
                  <th className="px-4 py-3 text-left">Invoice</th>
                  <th className="px-4 py-3 text-left">Customer</th>
                  <th className="px-4 py-3 text-right">Total</th>
                  <th className="px-4 py-3 text-right">Deposit credited</th>
                  <th className="px-4 py-3 text-right">Balance due</th>
                  <th className="px-4 py-3 text-left">Status</th>
                  <th className="px-4 py-3 text-right">Actions</th>
                </tr>
              </thead>
              <tbody>
                {visible.map((inv) => {
                  const name = [inv.customer_first_name, inv.customer_last_name]
                    .filter(Boolean)
                    .join(" ");
                  const isOpen = expanded.has(inv.id);
                  return (
                    <Fragment key={inv.id}>
                      <tr
                        className="border-b border-border/50 hover:bg-accent/30 cursor-pointer"
                        onClick={() => toggle(inv.id)}
                      >
                        <td className="px-2 py-3 text-center mono text-xs text-muted-foreground select-none">
                          {isOpen ? "▾" : "▸"}
                        </td>
                        <td className="px-4 py-3 mono">
                          <div className="text-paper">{inv.invoice_number}</div>
                          <div className="text-[10px] text-muted-foreground">
                            {fmtDate(inv.created_at)}
                          </div>
                          {inv.superseded_by_id && (
                            <div className="mono text-[10px] text-orange">
                              // superseded by newer invoice
                            </div>
                          )}
                        </td>
                        <td className="px-4 py-3">
                          <div className="font-medium">{name || "Unnamed"}</div>
                          {inv.customer_business_name && (
                            <div className="mono text-[10px] text-muted-foreground">
                              {inv.customer_business_name}
                            </div>
                          )}
                        </td>
                        <td className="px-4 py-3 mono text-right">{fmtMoney(inv.total_amount)}</td>
                        <td className="px-4 py-3 mono text-right">
                          {inv.deposit_paid && Number(inv.deposit_amount) > 0 ? (
                            <span className="text-moss">− {fmtMoney(inv.deposit_amount)}</span>
                          ) : (
                            <span className="text-[10px] uppercase tracking-wider text-muted-foreground">
                              none
                            </span>
                          )}
                        </td>
                        <td className="px-4 py-3 mono text-right text-paper">
                          {fmtMoney(inv.balance_due)}
                        </td>
                        <td className="px-4 py-3">
                          <span
                            className={`rounded-sm px-2 py-0.5 text-[10px] uppercase tracking-wider mono ${STATUS_STYLES[inv.status]}`}
                          >
                            {inv.status}
                          </span>
                        </td>
                        <td
                          className="px-4 py-3 text-right whitespace-nowrap"
                          onClick={(e) => e.stopPropagation()}
                        >
                          <div className="inline-flex gap-1">
                            {inv.status !== "archived" && (
                              <Link
                                to="/dashboard/invoices/$invoiceId/edit"
                                params={{ invoiceId: inv.id }}
                                className="mono rounded-sm border border-border px-2 py-1 text-[10px] uppercase tracking-wider text-muted-foreground hover:border-primary hover:text-primary"
                              >
                                {inv.status === "draft" ? "edit" : "revise"}
                              </Link>
                            )}
                            <a
                              href={`/invoice/${inv.id}`}
                              target="_blank"
                              rel="noreferrer"
                              className="mono rounded-sm border border-border px-2 py-1 text-[10px] uppercase tracking-wider text-muted-foreground hover:border-primary hover:text-primary"
                            >
                              view
                            </a>
                            {inv.status !== "archived" && (
                              <button
                                disabled={busyId === inv.id}
                                onClick={() => handleSend(inv.id)}
                                className="mono rounded-sm border border-primary/60 px-2 py-1 text-[10px] uppercase tracking-wider text-primary hover:bg-primary hover:text-primary-foreground disabled:opacity-50"
                              >
                                {busyId === inv.id
                                  ? "…"
                                  : inv.status === "draft"
                                    ? "send sms"
                                    : "resend sms"}
                              </button>
                            )}
                            {inv.status !== "archived" &&
                              (inv.status === "paid" ? (
                                <button
                                  disabled={busyId === inv.id}
                                  onClick={() => handleMark(inv.id, false)}
                                  className="mono rounded-sm border border-border px-2 py-1 text-[10px] uppercase tracking-wider text-muted-foreground hover:border-orange hover:text-orange disabled:opacity-50"
                                >
                                  undo payment
                                </button>
                              ) : (
                                <button
                                  disabled={busyId === inv.id}
                                  onClick={() => handleMark(inv.id, true)}
                                  className="mono rounded-sm border border-moss/60 px-2 py-1 text-[10px] uppercase tracking-wider text-moss hover:bg-moss hover:text-charcoal disabled:opacity-50"
                                >
                                  mark balance received
                                </button>
                              ))}
                          </div>
                        </td>
                      </tr>
                      {isOpen && (
                        <tr className="border-b border-border/50 bg-background/40">
                          <td></td>
                          <td colSpan={7} className="px-4 py-4">
                            <div className="grid gap-4 md:grid-cols-2">
                              <div className="space-y-1">
                                <div className="label-eyebrow">Snapshot</div>
                                <div className="mono text-[11px] text-muted-foreground">
                                  job site:{" "}
                                  <span className="text-paper">{inv.job_site_address}</span>
                                </div>
                                <div className="mono text-[11px] text-muted-foreground">
                                  phone: <span className="text-paper">{inv.customer_phone}</span>
                                </div>
                                <div className="mono text-[11px] text-muted-foreground">
                                  status:{" "}
                                  <span className="text-paper">
                                    {INVOICE_STATUS_LABEL[inv.status]}
                                  </span>
                                </div>
                                {inv.quote_id && (
                                  <div className="mono text-[11px] text-muted-foreground">
                                    from quote{" "}
                                    <span className="text-paper">{inv.quote_id.slice(0, 8)}</span>
                                  </div>
                                )}
                                <div className="mono text-[11px] text-muted-foreground">
                                  public link:{" "}
                                  <span className="text-paper">/invoice/{inv.id.slice(0, 8)}…</span>
                                </div>
                              </div>
                              <div className="space-y-2">
                                <div className="label-eyebrow">Audit trail</div>
                                <InvoiceAuditTrail invoiceId={inv.id} />
                              </div>
                            </div>
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
