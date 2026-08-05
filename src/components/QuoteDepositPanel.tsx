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
import {
  consumeDepositJump,
  parseDepositDeepLink,
  resolveDepositJump,
  type DepositJumpMissReason,
} from "@/lib/deposit-deep-link";
import { trackDepositJump } from "@/lib/analytics";
import { DepositRowPopover } from "@/components/DepositRowPopover";
import {
  DepositInlinePreviewDialog,
  type DepositInlinePreviewTarget,
} from "@/components/DepositInlinePreviewDialog";

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
  const [openPreviewId, setOpenPreviewId] = useState<string | null>(null);
  const [inlinePreview, setInlinePreview] = useState<DepositInlinePreviewTarget | null>(null);
  const openModeRef = useRef<"hover" | "keyboard" | null>(null);
  const currentBalanceRemaining =
    Number(quote.total_amount ?? 0) - (quote.deposit_paid ? Number(quote.deposit_amount ?? 0) : 0);
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

  const { data: audit, isLoading: auditLoading } = useQuery({
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
  const triggerRefs = useRef<Record<string, HTMLButtonElement | null>>({});
  const popoverFocusedRef = useRef(false);
  const filterKey = `${term}|${auditAction}|${auditActor}|${auditFrom}|${auditTo}|${filteredAudit.length}`;

  useEffect(() => {
    setAuditCursor(0);
  }, [filterKey]);

  const activeEntry = filteredAudit[auditCursor];

  const location = useLocation();
  function eventLinkSuffix(eventId: string) {
    const returnTo = `${location.pathname}`;
    const id = encodeURIComponent(eventId);
    return `?eventId=${id}&depositEvent=${id}&returnTo=${encodeURIComponent(returnTo)}#deposit-event-${id}`;
  }

  function goToEntry(next: number) {
    if (filteredAudit.length === 0) return;
    const clamped = Math.min(Math.max(next, 0), filteredAudit.length - 1);
    setAuditCursor(clamped);
    const id = filteredAudit[clamped]?.id;
    if (id) {
      entryRefs.current[id]?.scrollIntoView({ behavior: "smooth", block: "center" });
    }
  }

  // Focus the event referenced by ?eventId= / ?depositEvent= / #deposit-event-<id> on arrival.
  const { eventId: incomingEventId, source: incomingSource } = parseDepositDeepLink(
    location.searchStr,
    location.hash,
  );
  const focusedIncomingRef = useRef<string | null>(null);
  const timelineRef = useRef<HTMLDivElement | null>(null);
  const [jumpedId, setJumpedId] = useState<string | null>(null);
  const [jumpMiss, setJumpMiss] = useState<
    { id: string; reason: DepositJumpMissReason } | null
  >(null);
  const jumpMissHeadingRef = useRef<HTMLHeadingElement | null>(null);

  // Pull keyboard focus onto the not-found heading so the message is read at once.
  useEffect(() => {
    if (!jumpMiss) return;
    const t = requestAnimationFrame(() => {
      jumpMissHeadingRef.current?.focus({ preventScroll: false });
    });
    return () => cancelAnimationFrame(t);
  }, [jumpMiss]);


  function clearJumpParams() {
    if (typeof window === "undefined") return;
    const url = new URL(window.location.href);
    url.searchParams.delete("eventId");
    url.searchParams.delete("depositEvent");
    url.hash = "";
    window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}`);
  }

  // Disables the scroll-jump entirely after the first attempt in this mount, so
  // re-renders / lingering params can never re-scroll the timeline.
  const jumpDisabledRef = useRef(false);

  useEffect(() => {
    if (!incomingEventId || jumpDisabledRef.current) return;
    if (focusedIncomingRef.current === incomingEventId) return;
    if (auditLoading) return;

    focusedIncomingRef.current = incomingEventId;
    jumpDisabledRef.current = true;

    // Already handled this link earlier in the session (back/forward/refresh):
    // strip the params and leave the scroll position alone.
    const allowed = consumeDepositJump(
      typeof window === "undefined" ? null : window.sessionStorage,
      location.pathname,
      incomingEventId,
    );
    if (!allowed) {
      clearJumpParams();
      return;
    }


    const resolution = resolveDepositJump(
      incomingEventId,
      filteredAudit.map((r) => r.id),
      (audit ?? []).map((r) => r.id),
    );

    if (resolution.kind === "miss") {
      // Graceful fallback: the linked event isn't in view. Explain why and land
      // the reader at the closest available spot (first entry / timeline top).
      trackDepositJump({
        kind: "miss",
        quoteId: quote.id,
        eventId: incomingEventId,
        reason: resolution.reason,
        source: incomingSource,
      });
      setJumpMiss({ id: incomingEventId, reason: resolution.reason });
      setAuditCursor(resolution.fallbackIndex);
      // Strip the deep-link params immediately (not in a rAF) so a refresh or
      // back navigation never retries a jump we already know can't resolve.
      clearJumpParams();
      requestAnimationFrame(() => {
        const fallbackId = filteredAudit[resolution.fallbackIndex]?.id;
        const target = fallbackId ? entryRefs.current[fallbackId] : timelineRef.current;
        (target ?? timelineRef.current)?.scrollIntoView({ behavior: "smooth", block: "center" });
        if (fallbackId) entryRefs.current[fallbackId]?.focus({ preventScroll: true });
      });
      return;
    }

    trackDepositJump({
      kind: "success",
      quoteId: quote.id,
      eventId: incomingEventId,
      source: incomingSource,
    });
    setJumpMiss(null);
    setAuditCursor(resolution.index);
    setJumpedId(incomingEventId);
    requestAnimationFrame(() => {
      const el = entryRefs.current[incomingEventId];
      el?.scrollIntoView({ behavior: "smooth", block: "center" });
      // Move keyboard focus onto the row so screen readers announce it on arrival.
      el?.focus({ preventScroll: true });
      // Clear the jump params (and hash) so refresh / back doesn't re-scroll.
      clearJumpParams();
    });
  }, [incomingEventId, filteredAudit, audit, auditLoading]);


  // Fade the arrival highlight after a moment, keeping focus where it is.
  useEffect(() => {
    if (!jumpedId) return;
    const t = setTimeout(() => setJumpedId(null), 6000);
    return () => clearTimeout(t);
  }, [jumpedId]);










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

  function copyShortId(id: string) {
    const short = id.slice(0, 8);
    navigator.clipboard
      .writeText(short)
      .then(() => toast.success(`Quote ID ${short} copied.`))
      .catch(() => toast.error("Copy failed."));
  }

  function copyShareLink(eventId: string) {
    const url = new URL(window.location.href);
    url.searchParams.set("eventId", eventId);
    url.searchParams.set("depositEvent", eventId);
    url.searchParams.delete("returnTo");
    url.hash = "";
    navigator.clipboard
      .writeText(url.toString())
      .then(() => toast.success("Share link copied."))
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

      {jumpMiss && (
        <div
          role="alert"
          aria-live="assertive"
          aria-atomic="true"
          className="mono rounded-sm border border-orange/60 bg-orange/10 px-4 py-3 text-[11px] text-orange"
        >
          <div className="flex items-start gap-3">
            <div className="mt-0.5 text-lg leading-none" aria-hidden="true">
              🔎
            </div>
            <div className="flex-1">
              <h3
                ref={jumpMissHeadingRef}
                tabIndex={-1}
                className="font-semibold uppercase tracking-widest text-[10px] outline-none focus-visible:ring-2 focus-visible:ring-orange/70"
              >
                // we couldn't find that deposit row
              </h3>
              <p className="mt-1 normal-case text-muted-foreground">
                {jumpMiss.reason === "empty"
                  ? "This quote doesn't have any deposit events yet, so there's nothing to jump to."
                  : jumpMiss.reason === "filtered"
                    ? "That event exists but is hidden by the current search or filters. Clear the filters to reveal it."
                    : "That event ID isn't part of this quote's deposit timeline — it may have been pruned, or the link points at another quote."}
                {jumpMiss.reason !== "empty" && " We landed you on the most recent entry instead."}
              </p>
              <div className="mt-2 flex items-center gap-2">
                <span className="text-[10px] uppercase tracking-widest text-muted-foreground">
                  requested id
                </span>
                <code className="mono break-all rounded-sm border border-orange/40 bg-charcoal/40 px-1.5 py-0.5 text-[11px] text-paper">
                  {jumpMiss.id}
                </code>
              </div>
              <div className="mt-3 flex flex-wrap gap-2">
                {jumpMiss.reason === "filtered" && (
                  <button
                    onClick={() => {
                      setAuditQuery("");
                      setAuditAction("all");
                      setAuditActor("all");
                      setAuditFrom("");
                      setAuditTo("");
                      focusedIncomingRef.current = null;
                      setJumpMiss(null);
                      const id = jumpMiss.id;
                      requestAnimationFrame(() => {
                        entryRefs.current[id]?.scrollIntoView({ behavior: "smooth", block: "center" });
                      });
                    }}
                    className="rounded-sm border border-orange/60 px-2 py-1 text-[10px] uppercase tracking-wider hover:bg-orange/20"
                  >
                    clear filters &amp; jump
                  </button>
                )}
                {filteredAudit.length > 0 && (
                  <button
                    onClick={() => {
                      const latest = filteredAudit[0];
                      setJumpMiss(null);
                      setAuditCursor(0);
                      if (latest) {
                        setJumpedId(latest.id);
                        requestAnimationFrame(() => {
                          const el = entryRefs.current[latest.id];
                          el?.scrollIntoView({ behavior: "smooth", block: "center" });
                          el?.focus({ preventScroll: true });
                        });
                      }
                    }}
                    className="rounded-sm border border-orange/60 px-2 py-1 text-[10px] uppercase tracking-wider hover:bg-orange/20"
                  >
                    show latest deposit
                  </button>
                )}
                <button
                  onClick={() => {
                    setJumpMiss(null);
                    goToEntry(0);
                  }}
                  className="rounded-sm border border-border px-2 py-1 text-[10px] uppercase tracking-wider text-muted-foreground hover:border-primary hover:text-paper"
                >
                  return to timeline top
                </button>
                <button
                  onClick={() => setJumpMiss(null)}
                  className="rounded-sm border border-border px-2 py-1 text-[10px] uppercase tracking-wider text-muted-foreground hover:border-primary hover:text-paper"
                >
                  dismiss
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {audit && audit.length > 0 && (
        <div ref={timelineRef} className="border-t border-border pt-3">

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
              {activeEntry && (
                <span className="ml-auto flex flex-wrap items-center gap-2 text-muted-foreground">
                  <span aria-hidden="true" className="flex items-center gap-2">
                    <span className="text-paper">
                      deposit {money(parsePayload(activeEntry).deposit_amount ?? 0)}
                    </span>
                    <span>·</span>
                    <span className="text-moss">
                      balance {money(parsePayload(activeEntry).balance_remaining ?? 0)}
                    </span>
                    <span>·</span>
                    <span>
                      total {money(parsePayload(activeEntry).total_amount ?? quote.total_amount)}
                    </span>
                  </span>
                  <a
                    href={`/dashboard/quotes/${parsePayload(activeEntry).quote_id ?? quote.id}/print${eventLinkSuffix(activeEntry.id)}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    aria-label="Open quote details for the highlighted deposit event in a new tab"
                    className="rounded-sm border border-border px-2 py-1 text-muted-foreground hover:border-primary hover:text-paper"
                  >
                    quote ↗
                  </a>
                  <a
                    href={`/quote/${parsePayload(activeEntry).quote_id ?? quote.id}${eventLinkSuffix(activeEntry.id)}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    aria-label="Open the customer view for the highlighted deposit event in a new tab"
                    className="rounded-sm border border-border px-2 py-1 text-muted-foreground hover:border-primary hover:text-paper"
                  >
                    customer view ↗
                  </a>
                </span>
              )}

            </div>
          )}

          {/* Screen-reader announcement for the highlighted timeline row */}
          <div aria-live="polite" aria-atomic="true" className="sr-only">
            {activeEntry
              ? `Event ${auditCursor + 1} of ${filteredAudit.length}, ${new Date(
                  activeEntry.created_at,
                ).toLocaleString("en-US")}. Deposit ${money(
                  parsePayload(activeEntry).deposit_amount ?? 0,
                )}, balance remaining ${money(
                  parsePayload(activeEntry).balance_remaining ?? 0,
                )}, quote total ${money(
                  parsePayload(activeEntry).total_amount ?? quote.total_amount,
                )}.`
              : ""}
          </div>



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
              const isJumped = jumpedId === row.id;
              return (
                <li
                  key={row.id}
                  id={`deposit-event-${row.id}`}
                  ref={(el) => {
                    entryRefs.current[row.id] = el;
                  }}
                  tabIndex={-1}
                  aria-current={isJumped ? "true" : undefined}
                  aria-label={
                    isJumped
                      ? `Linked deposit event ${idx + 1} of ${filteredAudit.length}: ${
                          received ? "deposit received" : "deposit undone"
                        }, deposit ${money(p.deposit_amount ?? 0)}, balance ${money(
                          p.balance_remaining ?? 0,
                        )}, total ${money(p.total_amount ?? quote.total_amount)}, by ${actor}`
                      : undefined
                  }
                  className={`relative outline-none ${
                    isActive ? "-ml-2 rounded-sm border-l-2 border-primary bg-primary/5 pl-2" : ""
                  } ${
                    isJumped
                      ? "-ml-2 rounded-sm bg-primary/10 pl-2 ring-2 ring-primary ring-offset-2 ring-offset-background"
                      : ""
                  }`}
                >


                  <span
                    className={`absolute -left-[21px] top-1 h-2 w-2 rounded-full ${
                      received ? "bg-moss" : "bg-orange"
                    }`}
                  />
                  <div className="mono text-[11px]">
                    <DepositRowPopover
                      rowId={row.id}
                      quoteId={p.quote_id ?? quote.id}
                      received={received}
                      open={openPreviewId === row.id}
                      onOpenChange={(o) => setOpenPreviewId(o ? row.id : null)}
                      depositAtEvent={money(p.deposit_amount ?? 0)}
                      balanceAtEvent={money(p.balance_remaining ?? 0)}
                      quoteTotal={money(p.total_amount ?? quote.total_amount)}
                      currentBalance={money(currentBalanceRemaining)}
                      onPreviewQuote={() =>
                        setInlinePreview({
                          kind: "quote",
                          shortId: (p.quote_id ?? quote.id).slice(0, 8),
                          href: `/dashboard/quotes/${p.quote_id ?? quote.id}/print${eventLinkSuffix(row.id)}`,
                        })
                      }
                      onPreviewCustomer={() =>
                        setInlinePreview({
                          kind: "customer",
                          shortId: (p.quote_id ?? quote.id).slice(0, 8),
                          href: `/quote/${p.quote_id ?? quote.id}${eventLinkSuffix(row.id)}`,
                        })
                      }
                      onCopyShortId={() => copyShortId(p.quote_id ?? quote.id)}
                      onCopyShareLink={() => copyShareLink(row.id)}
                    />

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
                    <button
                      type="button"
                      onClick={() => copyShareLink(row.id)}
                      aria-label={`Copy share link for deposit event ${row.id.slice(0, 8)}`}
                      className="text-muted-foreground underline decoration-dotted underline-offset-2 hover:text-paper focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      copy share link
                    </button>
                  </div>



                </li>
              );
            })}
          </ol>
          )}
        </div>
      )}

      <DepositInlinePreviewDialog target={inlinePreview} onClose={() => setInlinePreview(null)} />
    </div>

  );
}
