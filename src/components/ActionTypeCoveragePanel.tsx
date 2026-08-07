import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { ChevronDown, ChevronRight, Radar, RefreshCw } from "lucide-react";
import {
  getActionTypeCoverage,
  type BusinessCoverage,
} from "@/lib/log-action-coverage.functions";
import type { BusinessSignals, GapSeverity } from "@/lib/log-action-coverage";
import {
  describeGapDrilldown,
  type CheckOutcome,
  type SourceCheck,
} from "@/lib/log-action-coverage-drilldown";
import type { LogActionType } from "@/lib/log-action-types";
import { LOG_ACTION_PRESENTATION } from "@/lib/log-action-presentation";

const SEVERITY_LABEL: Record<GapSeverity, string> = {
  attention: "Needs review",
  idle: "No source events",
  expected: "Explained by setup",
};

const SEVERITY_CLASS: Record<GapSeverity, string> = {
  attention: "border-orange/50 bg-orange/10 text-orange",
  idle: "border-steel/40 bg-steel/10 text-steel",
  expected: "border-border bg-muted/40 text-muted-foreground",
};

const FILTERS: Array<{ key: GapSeverity | "all"; label: string }> = [
  { key: "all", label: "All gaps" },
  { key: "attention", label: "Needs review" },
  { key: "idle", label: "No source events" },
  { key: "expected", label: "Explained by setup" },
];

export function ActionTypeCoveragePanel() {
  const fetchCoverage = useServerFn(getActionTypeCoverage);
  const [filter, setFilter] = useState<GapSeverity | "all">("all");
  const [open, setOpen] = useState<Record<string, boolean>>({});

  const { data, isLoading, isFetching, error, refetch } = useQuery({
    queryKey: ["admin", "log-action-coverage"],
    queryFn: () => fetchCoverage(),
    retry: false,
  });

  const businesses = useMemo<BusinessCoverage[]>(() => {
    if (!data) return [];
    if (filter === "all") return data.businesses;
    return data.businesses
      .map((b) => ({ ...b, gaps: b.gaps.filter((g) => g.severity === filter) }))
      .filter((b) => b.gaps.length > 0);
  }, [data, filter]);

  return (
    <section className="panel p-5" aria-labelledby="coverage-heading">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <Radar size={16} className="text-violet" />
            <h2 id="coverage-heading" className="label-eyebrow">
              Per-business action type coverage
            </h2>
          </div>
          <p className="mt-2 max-w-2xl text-sm text-muted-foreground">
            Action types the constraint allows but which have no entries for a business — with the
            likely reason. “Needs review” means source records exist while log entries don’t.
          </p>
        </div>
        <button
          type="button"
          onClick={() => void refetch()}
          disabled={isFetching}
          className="kb-focus flex items-center gap-1.5 rounded-sm border border-border bg-card px-3 py-2 text-xs uppercase tracking-wider hover:bg-accent disabled:opacity-60"
        >
          <RefreshCw size={12} className={isFetching ? "motion-safe:animate-spin" : ""} />
          Recheck
        </button>
      </div>

      {isLoading && (
        <p className="mono mt-4 text-xs uppercase tracking-widest text-muted-foreground">
          Analyzing coverage…
        </p>
      )}
      {error && (
        <p className="mt-4 text-sm text-orange">{(error as Error).message}</p>
      )}

      {data && (
        <>
          <div className="mono mt-4 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] uppercase tracking-widest text-muted-foreground">
            <span>{data.allowedCount} allowed types</span>
            <span>{data.businesses.length} businesses</span>
            <span className="text-orange">{data.totals.attention} needs review</span>
            <span>{data.totals.idle} no source events</span>
            <span>{data.totals.expected} explained</span>
          </div>

          {data.globallyUnused.length > 0 && (
            <p className="mt-3 text-xs text-muted-foreground">
              Never used by any business:{" "}
              <span className="mono">
                {data.globallyUnused
                  .map((a) => LOG_ACTION_PRESENTATION[a].label)
                  .join(", ")}
              </span>
            </p>
          )}

          <div className="mt-4 flex flex-wrap gap-2">
            {FILTERS.map((f) => (
              <button
                key={f.key}
                type="button"
                aria-pressed={filter === f.key}
                onClick={() => setFilter(f.key)}
                className={`kb-focus rounded-sm border px-2.5 py-1 text-[11px] uppercase tracking-widest ${
                  filter === f.key
                    ? "border-violet bg-violet/15 text-paper"
                    : "border-border bg-card text-muted-foreground hover:bg-accent"
                }`}
              >
                {f.label}
              </button>
            ))}
          </div>

          <div className="mt-4 space-y-2">
            {businesses.length === 0 && (
              <p className="text-sm text-muted-foreground">No gaps match this filter.</p>
            )}
            {businesses.map((b) => {
              const isOpen = open[b.userId] ?? b.attentionCount > 0;
              return (
                <div key={b.userId} className="rounded-sm border border-border bg-card/60">
                  <button
                    type="button"
                    aria-expanded={isOpen}
                    onClick={() => setOpen((o) => ({ ...o, [b.userId]: !isOpen }))}
                    className="kb-focus flex w-full items-center justify-between gap-3 px-3 py-2.5 text-left hover:bg-accent/50"
                  >
                    <span className="min-w-0">
                      <span className="block truncate text-sm text-paper">{b.businessName}</span>
                      <span className="mono block text-[11px] uppercase tracking-widest text-muted-foreground">
                        {b.covered.length}/{data.allowedCount} types seen · {b.totalLogRows} entries
                        {b.hasPhoneNumber ? "" : " · no number"}
                      </span>
                    </span>
                    <span className="flex shrink-0 items-center gap-2">
                      {b.attentionCount > 0 && (
                        <span className="mono rounded-sm border border-orange/50 bg-orange/10 px-1.5 py-0.5 text-[10px] uppercase tracking-widest text-orange">
                          {b.attentionCount} review
                        </span>
                      )}
                      <span className="mono text-[10px] uppercase tracking-widest text-muted-foreground">
                        {b.gaps.length} gaps
                      </span>
                      {isOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                    </span>
                  </button>

                  {isOpen && (
                    <ul className="divide-y divide-border border-t border-border">
                      {b.gaps.map((g) => (
                        <li key={g.actionType} className="px-3 py-2.5">
                          <div className="flex flex-wrap items-center gap-2">
                            <span
                              className={`h-2 w-2 shrink-0 rounded-full ${LOG_ACTION_PRESENTATION[g.actionType].dot}`}
                              aria-hidden
                            />
                            <span className="mono text-[11px] uppercase tracking-widest text-paper">
                              {LOG_ACTION_PRESENTATION[g.actionType].label}
                            </span>
                            <span
                              className={`mono rounded-sm border px-1.5 py-0.5 text-[10px] uppercase tracking-widest ${SEVERITY_CLASS[g.severity]}`}
                            >
                              {SEVERITY_LABEL[g.severity]}
                            </span>
                          </div>
                          <p className="mt-1 text-xs text-muted-foreground">{g.cause}</p>
                          <GapDrilldown
                            actionType={g.actionType}
                            signals={b.signals}
                            businessId={b.userId}
                          />
                        </li>
                      ))}
                    </ul>
                  )}

                </div>
              );
            })}
          </div>
        </>
      )}
    </section>
  );
}

const OUTCOME_CLASS: Record<CheckOutcome, string> = {
  "rows-exist": "border-orange/50 bg-orange/10 text-orange",
  "no-rows": "border-steel/40 bg-steel/10 text-steel",
  config: "border-border bg-muted/40 text-muted-foreground",
};

const OUTCOME_LABEL: Record<CheckOutcome, string> = {
  "rows-exist": "rows exist",
  "no-rows": "no rows",
  config: "setting",
};

function CheckTable({ title, checks, businessId }: { title: string; checks: SourceCheck[]; businessId: string }) {
  return (
    <div className="mt-2">
      <p className="mono text-[10px] uppercase tracking-widest text-muted-foreground">{title}</p>
      <ul className="mt-1 space-y-1.5">
        {checks.map((c, i) => (
          <li key={`${c.table}-${i}`} className="rounded-sm border border-border bg-background/40 px-2 py-1.5">
            <div className="flex flex-wrap items-center gap-2">
              <span className="mono text-[11px] text-paper">{c.table}</span>
              <span
                className={`mono rounded-sm border px-1.5 py-0.5 text-[10px] uppercase tracking-widest ${OUTCOME_CLASS[c.outcome]}`}
              >
                {OUTCOME_LABEL[c.outcome]} · {c.observed}
              </span>
            </div>
            <p className="mono mt-1 break-words text-[11px] text-muted-foreground">
              {c.predicate.replace("<business id>", businessId)}
            </p>
            <p className="mt-1 text-[11px] text-muted-foreground">
              <span className="uppercase tracking-widest">Window:</span> {c.window}
            </p>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Expandable "how we decided there are no entries" view for one missing action type. */
function GapDrilldown({
  actionType,
  signals,
  businessId,
}: {
  actionType: LogActionType;
  signals: BusinessSignals;
  businessId: string;
}) {
  const [open, setOpen] = useState(false);
  const detail = useMemo(() => describeGapDrilldown(actionType, signals), [actionType, signals]);

  return (
    <div className="mt-2">
      <button
        type="button"
        aria-expanded={open}
        data-testid={`drilldown-toggle-${actionType}`}
        onClick={() => setOpen((v) => !v)}
        className="kb-focus mono flex items-center gap-1 rounded-sm border border-border bg-card px-2 py-1 text-[10px] uppercase tracking-widest text-muted-foreground hover:bg-accent"
      >
        {open ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
        {open ? "Hide checks" : "Show source checks"}
      </button>

      {open && (
        <div data-testid={`drilldown-${actionType}`} className="mt-2">
          <CheckTable title="Log presence checks" checks={detail.presence} businessId={businessId} />
          <CheckTable title="Source-of-truth checks" checks={detail.sources} businessId={businessId} />
          <ul className="mt-2 list-disc space-y-1 pl-4 text-[11px] text-muted-foreground">
            {detail.notes.map((n) => (
              <li key={n}>{n}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
