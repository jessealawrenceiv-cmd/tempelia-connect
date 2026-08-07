import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Link } from "@tanstack/react-router";
import { toast } from "sonner";
import { AlarmClock, Check, Inbox, RefreshCw, ScrollText, Undo2 } from "lucide-react";
import {
  acknowledgeCoverageGapAlert,
  getCoverageGapInbox,
  runCoverageGapScan,
  type CoverageGapAlert,
  type CoverageGapInbox,
} from "@/lib/coverage-gap-alerts.functions";
import { LOG_ACTION_PRESENTATION } from "@/lib/log-action-presentation";

const fmtWhen = (iso: string) =>
  new Date(iso).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });

const ageLabel = (hours: number) =>
  hours >= 48
    ? `${Math.floor(hours / 24)}d`
    : hours >= 1
      ? `${Math.floor(hours)}h`
      : `${Math.max(1, Math.round(hours * 60))}m`;

function actionLabel(actionType: string) {
  const preset = (LOG_ACTION_PRESENTATION as Record<string, { label?: string } | undefined>)[
    actionType
  ];
  return preset?.label ?? actionType;
}

/**
 * Operator inbox for coverage gaps that outlive the 24h escalation window.
 * The scheduled scan writes the rows; this panel is where an operator triages
 * them and jumps into the activity log for the affected action type.
 */
export function CoverageGapInboxPanel() {
  const fetchInbox = useServerFn(getCoverageGapInbox);
  const scanFn = useServerFn(runCoverageGapScan);
  const ackFn = useServerFn(acknowledgeCoverageGapAlert);
  const queryClient = useQueryClient();
  const [includeResolved, setIncludeResolved] = useState(false);
  const [flaggedOnly, setFlaggedOnly] = useState(true);

  const queryKey = ["admin", "coverage-gap-inbox", includeResolved] as const;
  const { data, isLoading, isFetching, error, refetch } = useQuery<CoverageGapInbox>({
    queryKey,
    queryFn: () => fetchInbox({ data: { includeResolved } }),
    retry: false,
  });

  const scan = useMutation({
    mutationFn: () => scanFn(),
    onSuccess: (summary) => {
      toast.success(
        `Scan complete — ${summary.alertsFlagged} newly flagged, ${summary.alertsOpened} opened, ${summary.alertsResolved} cleared`,
      );
      void queryClient.invalidateQueries({ queryKey: ["admin", "coverage-gap-inbox"] });
    },
    onError: (e: unknown) => toast.error(e instanceof Error ? e.message : "Scan failed"),
  });

  const ack = useMutation({
    mutationFn: (vars: { alertId: string; undo?: boolean }) =>
      ackFn({ data: { alertId: vars.alertId, ...(vars.undo ? { undo: true } : {}) } }),
    onSuccess: (_r, vars) => {
      toast.success(vars.undo ? "Alert reopened" : "Alert acknowledged");
      void queryClient.invalidateQueries({ queryKey: ["admin", "coverage-gap-inbox"] });
    },
    onError: (e: unknown) => toast.error(e instanceof Error ? e.message : "Could not update alert"),
  });

  const alerts: CoverageGapAlert[] = (data?.alerts ?? []).filter((a) =>
    flaggedOnly ? Boolean(a.flaggedAt) : true,
  );

  return (
    <section className="panel p-5" aria-labelledby="gap-inbox-heading">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2
            id="gap-inbox-heading"
            className="flex items-center gap-2 font-display text-lg uppercase tracking-wide"
          >
            <Inbox className="h-4 w-4 text-orange" aria-hidden="true" />
            Operator inbox · persistent gaps
          </h2>
          <p className="mt-1 max-w-2xl text-xs text-moss">
            High-severity coverage gaps are recorded on every scan. A gap still present after{" "}
            {data?.escalationHours ?? 24}h is flagged here for an operator. Alerts clear themselves
            once the gap disappears.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => void refetch()}
            className="kb-focus mono inline-flex items-center gap-1.5 rounded border border-border px-2.5 py-1.5 text-[10px] uppercase tracking-widest text-moss hover:text-foreground"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${isFetching ? "animate-spin" : ""}`} aria-hidden="true" />
            Reload
          </button>
          <button
            type="button"
            onClick={() => scan.mutate()}
            disabled={scan.isPending}
            className="kb-focus mono inline-flex items-center gap-1.5 rounded border border-orange/50 bg-orange/10 px-2.5 py-1.5 text-[10px] uppercase tracking-widest text-orange disabled:opacity-60"
          >
            <AlarmClock className="h-3.5 w-3.5" aria-hidden="true" />
            {scan.isPending ? "Scanning…" : "Run gap scan"}
          </button>
        </div>
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => setFlaggedOnly((v) => !v)}
          aria-pressed={flaggedOnly}
          className={`kb-focus mono rounded-full border px-3 py-1 text-[10px] uppercase tracking-widest ${
            flaggedOnly
              ? "border-orange/50 bg-orange/10 text-orange"
              : "border-border text-moss hover:text-foreground"
          }`}
        >
          Flagged over 24h only
        </button>
        <button
          type="button"
          onClick={() => setIncludeResolved((v) => !v)}
          aria-pressed={includeResolved}
          className={`kb-focus mono rounded-full border px-3 py-1 text-[10px] uppercase tracking-widest ${
            includeResolved
              ? "border-steel/50 bg-steel/10 text-steel"
              : "border-border text-moss hover:text-foreground"
          }`}
        >
          Include cleared
        </button>
        {data ? (
          <span className="mono ml-auto text-[10px] uppercase tracking-widest text-moss">
            {data.flaggedCount} flagged · {data.openCount} open
            {data.lastScan ? ` · last scan ${fmtWhen(data.lastScan.ranAt)} (${data.lastScan.scope})` : ""}
          </span>
        ) : null}
      </div>

      <div aria-live="polite" className="mt-4">
        {isLoading ? (
          <p className="mono text-xs text-moss">Loading alerts…</p>
        ) : error ? (
          <p className="mono text-xs text-orange">
            {error instanceof Error ? error.message : "Could not load the operator inbox."}
          </p>
        ) : alerts.length === 0 ? (
          <p className="mono text-xs text-moss">
            {flaggedOnly
              ? "No gap has persisted past the 24h window. Nothing to triage."
              : "No coverage gaps are currently being tracked."}
          </p>
        ) : (
          <ul className="space-y-2">
            {alerts.map((a) => (
              <li
                key={a.id}
                className={`rounded border p-3 ${
                  a.resolvedAt
                    ? "border-border bg-muted/30"
                    : a.status === "acknowledged"
                      ? "border-steel/40 bg-steel/5"
                      : "border-orange/40 bg-orange/5"
                }`}
              >
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-display text-sm uppercase tracking-wide">{a.businessName}</span>
                  <span className="mono rounded border border-border px-1.5 py-0.5 text-[10px] uppercase tracking-widest text-moss">
                    {actionLabel(a.actionType)}
                  </span>
                  <span
                    className={`mono rounded px-1.5 py-0.5 text-[10px] uppercase tracking-widest ${
                      a.resolvedAt
                        ? "text-moss"
                        : a.flaggedAt
                          ? "bg-orange/15 text-orange"
                          : "text-moss"
                    }`}
                  >
                    {a.resolvedAt
                      ? `cleared ${fmtWhen(a.resolvedAt)}`
                      : a.flaggedAt
                        ? `persisting ${ageLabel(a.ageHours)}`
                        : `watching ${ageLabel(a.ageHours)}`}
                  </span>
                  {a.status === "acknowledged" && !a.resolvedAt ? (
                    <span className="mono rounded bg-steel/15 px-1.5 py-0.5 text-[10px] uppercase tracking-widest text-steel">
                      acknowledged
                    </span>
                  ) : null}
                </div>

                <p className="mt-1.5 text-xs text-foreground/85">{a.cause}</p>
                <p className="mono mt-1 text-[10px] uppercase tracking-widest text-moss">
                  first seen {fmtWhen(a.firstSeenAt)} · last seen {fmtWhen(a.lastSeenAt)} ·{" "}
                  {a.observationCount} scan{a.observationCount === 1 ? "" : "s"}
                </p>

                <div className="mt-2 flex flex-wrap items-center gap-2">
                  <Link
                    to="/dashboard"
                    search={{ logTypes: a.actionType }}
                    className="kb-focus mono inline-flex items-center gap-1.5 rounded border border-border px-2 py-1 text-[10px] uppercase tracking-widest text-moss hover:text-foreground"
                  >
                    <ScrollText className="h-3 w-3" aria-hidden="true" />
                    Open in activity log
                  </Link>
                  {!a.resolvedAt ? (
                    a.status === "acknowledged" ? (
                      <button
                        type="button"
                        onClick={() => ack.mutate({ alertId: a.id, undo: true })}
                        disabled={ack.isPending}
                        className="kb-focus mono inline-flex items-center gap-1.5 rounded border border-border px-2 py-1 text-[10px] uppercase tracking-widest text-moss hover:text-foreground disabled:opacity-60"
                      >
                        <Undo2 className="h-3 w-3" aria-hidden="true" />
                        Reopen
                      </button>
                    ) : (
                      <button
                        type="button"
                        onClick={() => ack.mutate({ alertId: a.id })}
                        disabled={ack.isPending}
                        className="kb-focus mono inline-flex items-center gap-1.5 rounded border border-steel/50 bg-steel/10 px-2 py-1 text-[10px] uppercase tracking-widest text-steel disabled:opacity-60"
                      >
                        <Check className="h-3 w-3" aria-hidden="true" />
                        Acknowledge
                      </button>
                    )
                  ) : null}
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
