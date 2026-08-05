import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useLocation } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import {
  depositBalanceRemaining,
  depositSelectionLabel,
  type DepositCustomType,
  type DepositSelection,
} from "@/lib/deposit";
import { markQuoteDeposit, DEPOSIT_AUDIT_ACTION } from "@/lib/deposit.functions";
import { previewQuoteSms } from "@/lib/quote-sms.functions";
import { buildDepositAuditCsv, type DepositAuditCsvRow } from "@/lib/deposit-audit-csv";
import { downloadCsv } from "@/lib/missed-calls-csv";

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
    customer_first_name?: string | null;
    customer_last_name?: string | null;
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

type AuditPayload = {
  quote_id?: string;
  actor_user_id?: string;
  actor_email?: string;
  actor_is_owner?: boolean;
  deposit_amount?: number;
  total_amount?: number;
  balance_remaining?: number;
  previous_paid?: boolean;
  previous_paid_at?: string | null;
  new_paid?: boolean;
  new_paid_at?: string | null;
};

function parsePayload(row: AuditRow): AuditPayload {
  try {
    return JSON.parse(row.message_sent ?? "{}") as AuditPayload;
  } catch {
    return {};
  }
}

export function QuoteDepositPanel({ quote }: Props) {
  const qc = useQueryClient();
  const markFn = useServerFn(markQuoteDeposit);
  const previewFn = useServerFn(previewQuoteSms);
  const [busy, setBusy] = useState(false);
  const [showPreview, setShowPreview] = useState(false);
  const [auditQuery, setAuditQuery] = useState("");
  const [auditAction, setAuditAction] = useState<"all" | "deposit_received" | "deposit_undone">(
    "all",
  );
  const [auditActor, setAuditActor] = useState("all");
  const [auditFrom, setAuditFrom] = useState("");
  const [auditTo, setAuditTo] = useState("");

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
      return (data ?? []).filter((r) => parsePayload(r as AuditRow).quote_id === quote.id);
    },
    enabled: quote.deposit_required,
  });

  const auditActors = Array.from(
    new Set(
      (audit ?? [])
        .map((r) => parsePayload(r).actor_email || parsePayload(r).actor_user_id || "")
        .filter(Boolean),
    ),
  ).sort();

  const term = auditQuery.trim().toLowerCase();
  const fromMs = auditFrom ? new Date(`${auditFrom}T00:00:00`).getTime() : null;
  const toMs = auditTo ? new Date(`${auditTo}T23:59:59.999`).getTime() : null;
  const filteredAudit = (audit ?? []).filter((row) => {
    const p = parsePayload(row);
    const actor = p.actor_email || p.actor_user_id || "";
    if (auditAction !== "all" && row.status !== auditAction) return false;
    if (auditActor !== "all" && actor !== auditActor) return false;
    const t = new Date(row.created_at).getTime();
    if (fromMs != null && t < fromMs) return false;
    if (toMs != null && t > toMs) return false;
    if (!term) return true;
    const haystack = [
      row.status,
      actor,
      p.actor_is_owner === false ? "staff" : "owner",
      quote.id,
      quote.id.slice(0, 8),
      quote.customer_first_name ?? "",
      quote.customer_last_name ?? "",
      p.deposit_amount != null ? String(p.deposit_amount) : "",
      p.balance_remaining != null ? String(p.balance_remaining) : "",
      new Date(row.created_at).toLocaleString("en-US"),
    ]
      .join(" ")
      .toLowerCase();
    return haystack.includes(term);
  });

  const dateRangeInvalid = fromMs != null && toMs != null && fromMs > toMs;

  const auditFiltersActive =
    term !== "" ||
    auditAction !== "all" ||
    auditActor !== "all" ||
    auditFrom !== "" ||
    auditTo !== "";

  const [auditCursor, setAuditCursor] = useState(0);
  const entryRefs = useRef<Record<string, HTMLLIElement | null>>({});
  const filterKey = `${term}|${auditAction}|${auditActor}|${auditFrom}|${auditTo}|${filteredAudit.length}`;
  useEffect(() => {
    setAuditCursor(0);
  }, [filterKey]);

  const activeEntry = filteredAudit[auditCursor];

  function goToEntry(next: number) {
    if (filteredAudit.length === 0) return;
    const clamped = Math.min(Math.max(next, 0), filteredAudit.length - 1);
    setAuditCursor(clamped);
    const id = filteredAudit[clamped]?.id;
    if (id) {
      entryRefs.current[id]?.scrollIntoView({ behavior: "smooth", block: "center" });
    }
  }






  const {
    data: preview,
    isFetching: previewLoading,
    error: previewError,
    refetch: refetchPreview,
  } = useQuery({
    queryKey: ["quote-sms-preview", quote.id],
    queryFn: () => previewFn({ data: { quoteId: quote.id } }),
    enabled: showPreview,
    staleTime: 0,
  });

  async function act(paid: boolean) {
    if (!paid && !window.confirm("Undo this deposit? The action is recorded in the log.")) return;
    setBusy(true);
    try {
      await markFn({ data: { quoteId: quote.id, paid } });
      toast.success(paid ? "Deposit marked received." : "Deposit receipt undone.");
      qc.invalidateQueries({ queryKey: ["quotes"] });
      qc.invalidateQueries({ queryKey: ["quote-deposit-audit", quote.id] });
      qc.invalidateQueries({ queryKey: ["quote-sms-preview", quote.id] });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Update failed");
    } finally {
      setBusy(false);
    }
  }

  function copyPreview() {
    if (!preview?.message) return;
    navigator.clipboard
      .writeText(preview.message)
      .then(() => toast.success("SMS text copied."))
      .catch(() => toast.error("Copy failed."));
  }

  function exportAudit() {
    const rows: DepositAuditCsvRow[] = filteredAudit
      .slice()
      .reverse()
      .map((row) => {
        const p = parsePayload(row);
        const name = [quote.customer_first_name, quote.customer_last_name]
          .filter(Boolean)
          .join(" ");
        return {
          created_at: row.created_at,
          status: row.status,
          quote_id: quote.id,
          quote_short_id: quote.id.slice(0, 8),
          customer_name: name,
          actor_email: p.actor_email ?? "",
          actor_user_id: p.actor_user_id ?? "",
          actor_is_owner: p.actor_is_owner == null ? "" : String(p.actor_is_owner),
          deposit_amount: p.deposit_amount != null ? p.deposit_amount.toFixed(2) : "",
          total_amount: p.total_amount != null ? p.total_amount.toFixed(2) : "",
          balance_remaining: p.balance_remaining != null ? p.balance_remaining.toFixed(2) : "",
          previous_paid: p.previous_paid == null ? "" : String(p.previous_paid),
          previous_paid_at: p.previous_paid_at ?? "",
          new_paid: p.new_paid == null ? "" : String(p.new_paid),
          new_paid_at: p.new_paid_at ?? "",
        };
      });
    if (rows.length === 0) {
      toast.error(
        auditFiltersActive
          ? "No entries match the current filters."
          : "No deposit audit entries to export yet.",
      );
      return;
    }
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
    downloadCsv(`deposit-audit-${quote.id.slice(0, 8)}-${stamp}.csv`, buildDepositAuditCsv(rows));
    toast.success(`Exported ${rows.length} entr${rows.length === 1 ? "y" : "ies"}`);
  }

  const previewButton = (
    <button
      onClick={() => {
        if (showPreview) {
          refetchPreview();
        } else {
          setShowPreview(true);
        }
      }}
      className="mono rounded-sm border border-border px-3 py-1.5 text-[10px] uppercase tracking-wider text-muted-foreground hover:border-primary hover:text-paper"
    >
      {showPreview ? "refresh sms preview" : "deposit sms preview"}
    </button>
  );

  const previewBlock = showPreview && (
    <div className="rounded-sm border border-border bg-charcoal/40 p-3 space-y-2">
      <div className="flex items-center justify-between gap-2">
        <div className="mono text-[10px] uppercase tracking-widest text-muted-foreground">
          // outbound sms preview · not sent
        </div>
        <div className="flex gap-2">
          <button
            onClick={copyPreview}
            disabled={!preview?.message}
            className="mono rounded-sm border border-border px-2 py-1 text-[10px] uppercase tracking-wider text-muted-foreground hover:border-primary hover:text-paper disabled:opacity-50"
          >
            copy sms text
          </button>
          <button
            onClick={() => setShowPreview(false)}
            className="mono rounded-sm border border-border px-2 py-1 text-[10px] uppercase tracking-wider text-muted-foreground hover:text-paper"
          >
            hide
          </button>
        </div>
      </div>

      {previewLoading && (
        <div className="mono text-[11px] text-muted-foreground">building preview…</div>
      )}
      {previewError && (
        <div className="mono text-[11px] text-orange">
          {previewError instanceof Error ? previewError.message : "Preview failed"}
        </div>
      )}

      {preview && (
        <>
          <pre className="mono whitespace-pre-wrap break-words rounded-sm border border-border/60 bg-background/60 p-3 text-[12px] text-paper">
{preview.message}
          </pre>
          <dl className="grid grid-cols-2 gap-x-4 gap-y-2 sm:grid-cols-4">
            {[
              {
                k: "encoding",
                v: `${preview.encoding}${preview.unicode ? " (unicode)" : ""}`,
              },
              {
                k: "length",
                v: `${preview.chars} / ${preview.segmentCapacity} chars`,
              },
              {
                k: "segments",
                v: `${preview.segments} × billed`,
              },
              {
                k: "room left",
                v: `${preview.charsUntilNextSegment} chars`,
              },
              { k: "from", v: preview.fromNumber ?? "— none provisioned" },
              { k: "to", v: preview.toNumber ?? "— no phone on quote" },
              { k: "quote status", v: preview.status },
              {
                k: "last sent",
                v: preview.lastSentAt
                  ? new Date(preview.lastSentAt).toLocaleString("en-US")
                  : "never",
              },
            ].map((d) => (
              <div key={d.k}>
                <dt className="mono text-[10px] uppercase tracking-widest text-muted-foreground">
                  {d.k}
                </dt>
                <dd className="mono break-words text-[11px] text-paper">{d.v}</dd>
              </div>
            ))}
          </dl>

          {preview.nonAsciiChars.length > 0 && (
            <div className="mono text-[10px] uppercase tracking-widest text-orange">
              // non-gsm characters force ucs-2 (halves capacity):{" "}
              {preview.nonAsciiChars.join(" ")}
            </div>
          )}

          <div className="mono break-all text-[10px] text-muted-foreground">
            link <span className="text-steel">{preview.link}</span>
          </div>

          <div className="rounded-sm border border-border/60 bg-background/40 p-2">
            <div className="mono text-[10px] uppercase tracking-widest text-muted-foreground">
              deposit wording
            </div>
            {preview.depositLine ? (
              <>
                <div className="mono mt-1 text-[11px] text-moss">{preview.depositLine}</div>
                <div className="mono mt-1 text-[10px] uppercase tracking-widest text-muted-foreground">
                  deposit {money(preview.depositAmount)} · total {money(preview.totalAmount)} ·
                  balance {money(preview.totalAmount - preview.depositAmount)}
                  {preview.depositPaid ? " · already received" : ""}
                </div>
              </>
            ) : (
              <div className="mono mt-1 text-[10px] uppercase tracking-widest text-muted-foreground">
                // none — this quote has no deposit requirement
              </div>
            )}
          </div>

          {preview.blockedReasons.length > 0 ? (
            <div className="mono text-[10px] uppercase tracking-widest text-orange">
              // not sendable as-is: {preview.blockedReasons.join(" · ")}
            </div>
          ) : (
            <div className="mono text-[10px] uppercase tracking-widest text-moss">
              // ready to send
            </div>
          )}

          <div className="mono text-[10px] uppercase tracking-widest text-muted-foreground">
            // preview generated {new Date(preview.generatedAt).toLocaleString("en-US")} · byte-for-byte
            identical to the real send
          </div>

        </>
      )}
    </div>
  );

  if (!quote.deposit_required) {
    return (
      <div className="rounded-sm border border-border bg-background/50 p-4 space-y-3">
        <div>
          <div className="label-eyebrow mb-1">Deposit</div>
          <div className="mono text-[11px] uppercase tracking-widest text-muted-foreground">
            // no deposit required on this quote
          </div>
          <div className="mt-2 mono text-sm">
            Balance remaining <span className="text-paper">{money(total)}</span>
          </div>
        </div>
        <div className="flex gap-2">{previewButton}</div>
        {previewBlock}
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

      <div className="flex flex-wrap gap-2">
        {quote.status !== "archived" &&
          (quote.deposit_paid ? (
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
          ))}
        {previewButton}
        <button
          onClick={exportAudit}
          className="mono rounded-sm border border-border px-3 py-1.5 text-[10px] uppercase tracking-wider text-muted-foreground hover:border-primary hover:text-paper"
        >
          export deposit audit (csv){auditFiltersActive ? " · filtered" : ""}
        </button>
      </div>

      {previewBlock}

      {audit && audit.length > 0 && (
        <div className="border-t border-border pt-3">
          <div className="mono text-[10px] uppercase tracking-widest text-muted-foreground mb-2">
            // deposit status timeline · {filteredAudit.length} of {audit.length} entr
            {audit.length === 1 ? "y" : "ies"}
          </div>

          <div className="mb-3 flex flex-wrap gap-2">
            <input
              value={auditQuery}
              onChange={(e) => setAuditQuery(e.target.value)}
              placeholder="search actor, quote id, amount, date…"
              className="mono min-w-[200px] flex-1 rounded-sm border border-border bg-background/60 px-2 py-1.5 text-[11px] text-paper placeholder:text-muted-foreground focus:border-primary focus:outline-none"
            />
            <select
              value={auditAction}
              onChange={(e) =>
                setAuditAction(e.target.value as "all" | "deposit_received" | "deposit_undone")
              }
              className="mono rounded-sm border border-border bg-background/60 px-2 py-1.5 text-[10px] uppercase tracking-wider text-muted-foreground focus:border-primary focus:outline-none"
            >
              <option value="all">all actions</option>
              <option value="deposit_received">received</option>
              <option value="deposit_undone">undone</option>
            </select>
            <select
              value={auditActor}
              onChange={(e) => setAuditActor(e.target.value)}
              className="mono max-w-[220px] rounded-sm border border-border bg-background/60 px-2 py-1.5 text-[10px] uppercase tracking-wider text-muted-foreground focus:border-primary focus:outline-none"
            >
              <option value="all">all actors</option>
              {auditActors.map((a) => (
                <option key={a} value={a}>
                  {a}
                </option>
              ))}
            </select>
            <label className="mono flex items-center gap-1 text-[10px] uppercase tracking-wider text-muted-foreground">
              from
              <input
                type="date"
                value={auditFrom}
                max={auditTo || undefined}
                onChange={(e) => setAuditFrom(e.target.value)}
                className="mono rounded-sm border border-border bg-background/60 px-2 py-1 text-[11px] text-paper focus:border-primary focus:outline-none"
              />
            </label>
            <label className="mono flex items-center gap-1 text-[10px] uppercase tracking-wider text-muted-foreground">
              to
              <input
                type="date"
                value={auditTo}
                min={auditFrom || undefined}
                onChange={(e) => setAuditTo(e.target.value)}
                className="mono rounded-sm border border-border bg-background/60 px-2 py-1 text-[11px] text-paper focus:border-primary focus:outline-none"
              />
            </label>
            {[
              { label: "7d", days: 7 },
              { label: "30d", days: 30 },
            ].map((r) => (
              <button
                key={r.label}
                onClick={() => {
                  const to = new Date();
                  const from = new Date(to.getTime() - (r.days - 1) * 86400000);
                  setAuditFrom(from.toISOString().slice(0, 10));
                  setAuditTo(to.toISOString().slice(0, 10));
                }}
                className="mono rounded-sm border border-border px-2 py-1.5 text-[10px] uppercase tracking-wider text-muted-foreground hover:border-primary hover:text-paper"
              >
                last {r.label}
              </button>
            ))}
            {auditFiltersActive && (
              <button
                onClick={() => {
                  setAuditQuery("");
                  setAuditAction("all");
                  setAuditActor("all");
                  setAuditFrom("");
                  setAuditTo("");
                }}
                className="mono rounded-sm border border-border px-2 py-1.5 text-[10px] uppercase tracking-wider text-muted-foreground hover:border-orange hover:text-orange"
              >
                clear
              </button>
            )}
          </div>

          {dateRangeInvalid && (
            <div className="mono mb-2 text-[10px] uppercase tracking-widest text-orange">
              // from date is after to date — no entries can match
            </div>
          )}

          {filteredAudit.length > 1 && (
            <div className="mono mb-2 flex flex-wrap items-center gap-2 text-[10px] uppercase tracking-widest">
              <button
                onClick={() => goToEntry(auditCursor - 1)}
                disabled={auditCursor === 0}
                className="rounded-sm border border-border px-2 py-1 text-muted-foreground hover:border-primary hover:text-paper disabled:cursor-not-allowed disabled:opacity-40"
              >
                ← prev event
              </button>
              <span className="text-muted-foreground">
                event {auditCursor + 1} of {filteredAudit.length}
                {activeEntry ? ` · ${new Date(activeEntry.created_at).toLocaleString("en-US")}` : ""}
              </span>
              <button
                onClick={() => goToEntry(auditCursor + 1)}
                disabled={auditCursor >= filteredAudit.length - 1}
                className="rounded-sm border border-border px-2 py-1 text-muted-foreground hover:border-primary hover:text-paper disabled:cursor-not-allowed disabled:opacity-40"
              >
                next event →
              </button>
            </div>
          )}

          {filteredAudit.length === 0 ? (
            <div className="mono text-[11px] text-muted-foreground">
              // no entries match the current filters
            </div>
          ) : (
          <ol className="relative space-y-3 border-l border-border/70 pl-4">
            {filteredAudit.map((row, idx) => {
              const p = parsePayload(row);
              const received = row.status === "deposit_received";
              const actor = p.actor_email || p.actor_user_id || "unknown";
              const isActive = idx === auditCursor && filteredAudit.length > 1;
              return (
                <li
                  key={row.id}
                  ref={(el) => {
                    entryRefs.current[row.id] = el;
                  }}
                  className={`relative ${
                    isActive ? "-ml-2 rounded-sm border-l-2 border-primary bg-primary/5 pl-2" : ""
                  }`}
                >

                  <span
                    className={`absolute -left-[21px] top-1 h-2 w-2 rounded-full ${
                      received ? "bg-moss" : "bg-orange"
                    }`}
                  />
                  <div className="mono text-[11px]">
                    <span className={received ? "text-moss" : "text-orange"}>
                      {received ? "deposit received" : "deposit undone"}
                    </span>
                    <span className="text-muted-foreground">
                      {" "}
                      · {new Date(row.created_at).toLocaleString("en-US")}
                    </span>
                  </div>
                  <div className="mono text-[10px] uppercase tracking-widest text-muted-foreground">
                    by {actor}
                    {p.actor_is_owner === false ? " (staff)" : ""}
                  </div>
                  <div className="mono text-[10px] text-muted-foreground">
                    {p.deposit_amount != null && <>deposit {money(p.deposit_amount)} · </>}
                    {p.balance_remaining != null && (
                      <>balance {money(p.balance_remaining)}</>
                    )}
                  </div>
                  <div className="mono mt-1 flex flex-wrap items-center gap-2 text-[10px] uppercase tracking-widest">
                    <a
                      href={`/dashboard/quotes/${p.quote_id ?? quote.id}/print${eventLinkSuffix(row.id)}`}
                      target="_blank"
                      rel="noreferrer"
                      className="text-violet underline decoration-dotted underline-offset-2 hover:text-violet/80"
                    >
                      open quote {(p.quote_id ?? quote.id).slice(0, 8)} ↗
                    </a>
                    <a
                      href={`/quote/${p.quote_id ?? quote.id}${eventLinkSuffix(row.id)}`}
                      target="_blank"
                      rel="noreferrer"
                      className="text-steel underline decoration-dotted underline-offset-2 hover:text-steel/80"
                    >
                      customer view ↗
                    </a>
                  </div>


                </li>
              );
            })}
          </ol>
          )}
        </div>
      )}
    </div>
  );
}
