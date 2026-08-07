/**
 * Operator panel: webhook redelivery audit.
 *
 * Shows, per dedupe key, whether the delivery was newly inserted or served
 * from the dedupe guard on a provider redelivery — with first/last timestamps
 * and the activity-log row it produced.
 */
import { useServerFn } from "@tanstack/react-start";
import { useQuery } from "@tanstack/react-query";
import { Copy, RefreshCw, Repeat2 } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

import {
  getWebhookDeliveryAudit,
  type DeliveryClassification,
  type WebhookDeliveryAuditRow,
} from "@/lib/webhook-delivery-diagnostics.functions";

const WINDOWS = [
  { label: "24h", hours: 24 },
  { label: "72h", hours: 72 },
  { label: "7d", hours: 168 },
  { label: "30d", hours: 720 },
] as const;

const FILTERS = [
  { label: "All", value: "all" },
  { label: "Deduped", value: "deduped" },
  { label: "Inserted", value: "inserted" },
] as const;

const TONE: Record<DeliveryClassification, string> = {
  inserted: "text-moss",
  deduped: "text-orange",
};

function fmtWhen(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
}

function fmtGap(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`;
  return `${(ms / 3_600_000).toFixed(1)}h`;
}

export function WebhookDeliveryAuditPanel() {
  const listFn = useServerFn(getWebhookDeliveryAudit);
  const [windowHours, setWindowHours] = useState<number>(72);
  const [classification, setClassification] = useState<"all" | DeliveryClassification>("all");
  const [expanded, setExpanded] = useState<string | null>(null);

  const { data, isLoading, isFetching, error, refetch } = useQuery({
    queryKey: ["admin", "webhook-delivery-audit", windowHours, classification],
    queryFn: () => listFn({ data: { windowHours, classification, limit: 100 } }),
    retry: false,
  });

  return (
    <div className="panel p-5" data-testid="webhook-delivery-audit-panel">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Repeat2 size={16} className="text-steel" aria-hidden="true" />
          <div className="label-eyebrow">Webhook redelivery audit</div>
        </div>
        <button
          type="button"
          onClick={() => void refetch()}
          disabled={isFetching}
          className="kb-focus flex items-center gap-1.5 rounded-sm border border-border bg-card px-3 py-2 text-xs uppercase tracking-wider hover:bg-accent disabled:opacity-60"
        >
          <RefreshCw size={12} className={isFetching ? "motion-safe:animate-spin" : ""} />
          {isFetching ? "Loading…" : "Refresh"}
        </button>
      </div>

      <p className="mt-2 text-xs text-muted-foreground">
        Each row is one <span className="mono">delivery_key</span>. Keys claimed once were newly
        inserted; keys claimed more than once were re-delivered by the provider and served from the
        dedupe guard instead of being processed again.
      </p>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <div className="flex flex-wrap gap-1" role="group" aria-label="Time window">
          {WINDOWS.map((w) => (
            <button
              key={w.hours}
              type="button"
              onClick={() => setWindowHours(w.hours)}
              aria-pressed={windowHours === w.hours}
              className={`kb-focus mono rounded-sm border px-2.5 py-1.5 text-[10px] uppercase tracking-widest ${
                windowHours === w.hours
                  ? "border-primary bg-primary/10 text-primary"
                  : "border-border bg-card text-muted-foreground hover:bg-accent"
              }`}
            >
              {w.label}
            </button>
          ))}
        </div>
        <div className="flex flex-wrap gap-1" role="group" aria-label="Delivery classification">
          {FILTERS.map((f) => (
            <button
              key={f.value}
              type="button"
              onClick={() => setClassification(f.value)}
              aria-pressed={classification === f.value}
              className={`kb-focus mono rounded-sm border px-2.5 py-1.5 text-[10px] uppercase tracking-widest ${
                classification === f.value
                  ? "border-primary bg-primary/10 text-primary"
                  : "border-border bg-card text-muted-foreground hover:bg-accent"
              }`}
            >
              {f.label}
            </button>
          ))}
        </div>
      </div>

      {data ? (
        <dl className="mono mt-4 grid grid-cols-2 gap-3 text-[10px] uppercase tracking-widest md:grid-cols-4">
          <Stat label="Keys" value={String(data.totalKeys)} />
          <Stat label="Newly inserted" value={String(data.insertedCount)} tone="text-moss" />
          <Stat label="Deduped keys" value={String(data.dedupedCount)} tone="text-orange" />
          <Stat
            label="Suppressed redeliveries"
            value={String(data.suppressedDeliveries)}
            tone="text-orange"
          />
        </dl>
      ) : null}

      {data && data.unlinkedDedupedCount > 0 ? (
        <p className="mono mt-3 text-[10px] uppercase tracking-widest text-orange">
          {data.unlinkedDedupedCount} deduped key(s) have no matching activity-log row
        </p>
      ) : null}

      <div aria-live="polite" className="mt-4 space-y-2">
        {isLoading ? (
          <p className="mono text-xs uppercase tracking-widest text-muted-foreground">Loading…</p>
        ) : error ? (
          <p className="text-sm text-destructive">{(error as Error).message}</p>
        ) : !data || data.rows.length === 0 ? (
          <p className="mono text-xs uppercase tracking-widest text-moss">
            No webhook deliveries in this window
          </p>
        ) : (
          data.rows.map((row) => (
            <DeliveryRow
              key={row.id}
              row={row}
              expanded={expanded === row.id}
              onToggle={() => setExpanded((cur) => (cur === row.id ? null : row.id))}
            />
          ))
        )}
      </div>
    </div>
  );
}

function Stat({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <div className="rounded-sm border border-border bg-card/60 p-2.5">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className={`mt-1 text-sm ${tone ?? ""}`}>{value}</dd>
    </div>
  );
}

function DeliveryRow({
  row,
  expanded,
  onToggle,
}: {
  row: WebhookDeliveryAuditRow;
  expanded: boolean;
  onToggle: () => void;
}) {
  return (
    <div className="rounded-sm border border-border bg-card/60 p-3">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className={`mono text-[10px] uppercase tracking-widest ${TONE[row.classification]}`}>
          {row.classification === "deduped"
            ? `deduped ×${row.dedupedCount}`
            : "inserted"}
        </span>
        <span className="mono text-xs font-medium">
          {row.source} · {row.eventKind}
        </span>
        <span className="mono text-[10px] uppercase tracking-widest text-muted-foreground">
          {row.state}
          {row.responseStatus ? ` · ${row.responseStatus}` : ""}
        </span>
        <span className="mono text-[10px] uppercase tracking-widest text-muted-foreground">
          last {fmtWhen(row.lastSeenAt)}
        </span>
      </div>

      <p className="mono mt-1 truncate text-[10px] text-muted-foreground" title={row.deliveryKey}>
        key {row.deliveryKey}
      </p>

      <button
        type="button"
        onClick={onToggle}
        aria-expanded={expanded}
        className="kb-focus mono mt-2 text-[10px] uppercase tracking-widest text-primary"
      >
        {expanded ? "Hide timeline" : "Show timeline"}
      </button>

      {expanded ? (
        <dl className="mt-2 space-y-1 text-xs">
          <Field label="First delivery" value={fmtWhen(row.firstSeenAt)} />
          <Field label="Last delivery" value={fmtWhen(row.lastSeenAt)} />
          <Field label="Deliveries received" value={String(row.attemptCount)} />
          <Field label="Redelivery window" value={fmtGap(row.redeliveryWindowMs)} />
          <Field label="Completed" value={fmtWhen(row.completedAt)} />
          <Field
            label="Activity log row"
            value={
              row.logId
                ? `${row.logActionType ?? "?"} · ${fmtWhen(row.logCreatedAt)}`
                : "none (no logs.dedupe_key match)"
            }
          />
          <div className="pt-1">
            <button
              type="button"
              onClick={() => {
                void navigator.clipboard
                  ?.writeText(row.deliveryKey)
                  .then(() => toast.success("Copied delivery key"))
                  .catch(() => toast.error("Could not copy delivery key"));
              }}
              className="kb-focus mono inline-flex items-center gap-1.5 rounded-sm border border-border bg-card px-2.5 py-1.5 text-[10px] uppercase tracking-widest hover:bg-accent"
            >
              <Copy size={11} />
              Copy key
            </button>
          </div>
        </dl>
      ) : null}
    </div>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-wrap gap-x-2">
      <dt className="mono text-[10px] uppercase tracking-widest text-muted-foreground">{label}</dt>
      <dd className="mono text-[11px]">{value}</dd>
    </div>
  );
}
