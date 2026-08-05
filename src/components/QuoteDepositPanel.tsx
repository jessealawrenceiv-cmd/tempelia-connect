import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useState } from "react";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import {
  depositBalanceRemaining,
  depositSelectionLabel,
  type DepositCustomType,
  type DepositSelection,
} from "@/lib/deposit";
import { markQuoteDeposit, DEPOSIT_AUDIT_ACTION } from "@/lib/deposit.functions";

type Props = {
  quote: {
    id: string;
    total_amount: number | string;
    deposit_required: boolean;
    deposit_selection: string;
    deposit_custom_type: string | null;
    deposit_custom_value: number | null;
    deposit_amount: number | string;
    deposit_paid: boolean;
    deposit_paid_at: string | null;
    status: string;
  };
};

function money(n: number | string | null | undefined) {
  return Number(n ?? 0).toLocaleString("en-US", { style: "currency", currency: "USD" });
}

type AuditRow = {
  id: string;
  status: string;
  message_sent: string | null;
  created_at: string;
};

export function QuoteDepositPanel({ quote }: Props) {
  const qc = useQueryClient();
  const markFn = useServerFn(markQuoteDeposit);
  const [busy, setBusy] = useState(false);

  const total = Number(quote.total_amount ?? 0);
  const deposit = Number(quote.deposit_amount ?? 0);
  const balance = depositBalanceRemaining({
    total,
    depositAmount: deposit,
    depositPaid: quote.deposit_paid,
  });

  const { data: audit } = useQuery({
    queryKey: ["quote-deposit-audit", quote.id],
    queryFn: async (): Promise<AuditRow[]> => {
      const { data, error } = await supabase
        .from("logs")
        .select("id, status, message_sent, created_at")
        .eq("action_type", DEPOSIT_AUDIT_ACTION)
        .order("created_at", { ascending: false })
        .limit(50);
      if (error) throw error;
      return (data ?? []).filter((r) => {
        try {
          return JSON.parse(r.message_sent ?? "{}").quote_id === quote.id;
        } catch {
          return false;
        }
      });
    },
    enabled: quote.deposit_required,
  });

  async function act(paid: boolean) {
    if (!paid && !window.confirm("Undo this deposit? The action is recorded in the log.")) return;
    setBusy(true);
    try {
      await markFn({ data: { quoteId: quote.id, paid } });
      toast.success(paid ? "Deposit marked received." : "Deposit receipt undone.");
      qc.invalidateQueries({ queryKey: ["quotes"] });
      qc.invalidateQueries({ queryKey: ["quote-deposit-audit", quote.id] });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Update failed");
    } finally {
      setBusy(false);
    }
  }

  if (!quote.deposit_required) {
    return (
      <div className="rounded-sm border border-border bg-background/50 p-4">
        <div className="label-eyebrow mb-1">Deposit</div>
        <div className="mono text-[11px] uppercase tracking-widest text-muted-foreground">
          // no deposit required on this quote
        </div>
        <div className="mt-2 mono text-sm">
          Balance remaining <span className="text-paper">{money(total)}</span>
        </div>
      </div>
    );
  }

  return (
    <div className="rounded-sm border border-border bg-background/50 p-4 space-y-3">
      <div className="flex items-center justify-between gap-3">
        <div className="label-eyebrow">Deposit</div>
        {quote.deposit_paid ? (
          <span className="mono rounded-sm bg-moss/30 px-2 py-0.5 text-[10px] uppercase tracking-wider text-paper">
            received
          </span>
        ) : (
          <span className="mono rounded-sm bg-orange/20 px-2 py-0.5 text-[10px] uppercase tracking-wider text-orange">
            unpaid
          </span>
        )}
      </div>

      <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm sm:grid-cols-4">
        <div>
          <dt className="mono text-[10px] uppercase tracking-widest text-muted-foreground">Required</dt>
          <dd className="mono text-paper">{money(deposit)}</dd>
        </div>
        <div>
          <dt className="mono text-[10px] uppercase tracking-widest text-muted-foreground">Preset</dt>
          <dd className="mono text-muted-foreground">
            {depositSelectionLabel(
              quote.deposit_selection as DepositSelection,
              quote.deposit_custom_type as DepositCustomType | null,
              quote.deposit_custom_value,
            )}
          </dd>
        </div>
        <div>
          <dt className="mono text-[10px] uppercase tracking-widest text-muted-foreground">Quote total</dt>
          <dd className="mono text-muted-foreground">{money(total)}</dd>
        </div>
        <div>
          <dt className="mono text-[10px] uppercase tracking-widest text-muted-foreground">
            Balance remaining
          </dt>
          <dd className="mono text-moss">{money(balance)}</dd>
        </div>
      </dl>

      {quote.deposit_paid && quote.deposit_paid_at && (
        <div className="mono text-[10px] uppercase tracking-widest text-muted-foreground">
          received {new Date(quote.deposit_paid_at).toLocaleString("en-US")}
        </div>
      )}

      {quote.status !== "archived" && (
        <div className="flex gap-2">
          {quote.deposit_paid ? (
            <button
              disabled={busy}
              onClick={() => act(false)}
              className="mono rounded-sm border border-border px-3 py-1.5 text-[10px] uppercase tracking-wider text-muted-foreground hover:border-orange hover:text-orange disabled:opacity-50"
            >
              {busy ? "…" : "undo deposit received"}
            </button>
          ) : (
            <button
              disabled={busy}
              onClick={() => act(true)}
              className="mono rounded-sm border border-moss/60 px-3 py-1.5 text-[10px] uppercase tracking-wider text-moss hover:bg-moss hover:text-charcoal disabled:opacity-50"
            >
              {busy ? "…" : "mark deposit received"}
            </button>
          )}
        </div>
      )}

      {audit && audit.length > 0 && (
        <div className="border-t border-border pt-2">
          <div className="mono text-[10px] uppercase tracking-widest text-muted-foreground mb-1">
            // deposit audit trail
          </div>
          <ul className="space-y-1">
            {audit.map((row) => {
              let actor = "unknown";
              try {
                const p = JSON.parse(row.message_sent ?? "{}");
                actor = p.actor_email || p.actor_user_id || "unknown";
              } catch {
                /* ignore */
              }
              return (
                <li key={row.id} className="mono text-[11px] text-muted-foreground">
                  <span
                    className={
                      row.status === "deposit_received" ? "text-moss" : "text-orange"
                    }
                  >
                    {row.status.replace(/_/g, " ")}
                  </span>{" "}
                  · {actor} · {new Date(row.created_at).toLocaleString("en-US")}
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </div>
  );
}
