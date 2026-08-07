/**
 * Drift history for the generated activity-log action_type enum.
 *
 * Lists every recorded drift test run with its timestamp and pass/fail status,
 * and lets an operator expand a run to see exactly which enum values differed
 * from the database CHECK constraint at that moment.
 */

import { useMemo, useState } from "react";
import { Check, ChevronRight, History, RefreshCw, ShieldAlert, X } from "lucide-react";
import type { DriftRun } from "@/lib/log-action-diagnostics.functions";
import { DateRangePicker, type DateRangeValue } from "@/components/DateRangePicker";

const fmtWhen = (iso: string) =>
  new Date(iso).toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });

/** Set/order differences between a run's snapshot of code and database values. */
export function driftRunDifferences(run: DriftRun) {
  const dbSet = new Set(run.dbValues);
  const genSet = new Set(run.generatedValues);
  const missingInDb = run.generatedValues.filter((v) => !dbSet.has(v));
  const missingInGenerated = run.dbValues.filter((v) => !genSet.has(v));
  const sameSet = missingInDb.length === 0 && missingInGenerated.length === 0;
  const orderDiffers = sameSet && run.dbValues.join("|") !== run.generatedValues.join("|");
  return { missingInDb, missingInGenerated, orderDiffers };
}

/**
 * Concise, human-readable summary of why a run failed, highlighting the top
 * mismatching values so an operator does not have to read the whole diff.
 */
export function driftRunFailureSummary(run: DriftRun, max = 3) {
  const { missingInDb, missingInGenerated, orderDiffers } = driftRunDifferences(run);
  if (missingInDb.length === 0 && missingInGenerated.length === 0 && !orderDiffers) return null;

  const parts: string[] = [];
  if (missingInDb.length > 0) parts.push(`${missingInDb.length} only in code`);
  if (missingInGenerated.length > 0) parts.push(`${missingInGenerated.length} only in database`);
  if (orderDiffers) parts.push("order differs");

  const highlights: { value: string; where: string; tone: string }[] = [
    ...missingInDb.slice(0, max).map((value) => ({
      value,
      where: "missing in database",
      tone: "border-orange/40 bg-orange/10 text-orange",
    })),
    ...missingInGenerated.slice(0, max).map((value) => ({
      value,
      where: "missing in code",
      tone: "border-primary/40 bg-primary/10 text-primary",
    })),
  ];
  const extra =
    Math.max(0, missingInDb.length - max) + Math.max(0, missingInGenerated.length - max);

  return { headline: parts.join(" · "), highlights, extra };
}

const FailureSummary = ({ run }: { run: DriftRun }) => {
  const summary = driftRunFailureSummary(run);
  if (!summary) return null;
  return (
    <div className="rounded-sm border border-orange/40 bg-orange/5 p-3">
      <div className="mono text-[10px] uppercase tracking-widest text-orange">
        Failure summary · {summary.headline}
      </div>
      {summary.highlights.length > 0 && (
        <ul className="mt-2 space-y-1">
          {summary.highlights.map((h) => (
            <li key={`${h.where}-${h.value}`} className="flex items-center gap-2">
              <span className={`mono rounded-sm border px-1.5 py-0.5 text-[10px] ${h.tone}`}>{h.value}</span>
              <span className="mono text-[10px] uppercase tracking-widest text-muted-foreground">{h.where}</span>
            </li>
          ))}
        </ul>
      )}
      {summary.extra > 0 && (
        <p className="mono mt-2 text-[10px] uppercase tracking-widest text-muted-foreground">
          + {summary.extra} more mismatch{summary.extra === 1 ? "" : "es"} below
        </p>
      )}
    </div>
  );
};

const ValueList = ({ label, values, tone }: { label: string; values: string[]; tone: string }) => (
  <div>
    <div className="mono text-[10px] uppercase tracking-widest text-muted-foreground">{label}</div>
    <div className="mt-1 flex flex-wrap gap-1.5">
      {values.map((v) => (
        <span key={v} className={`mono rounded-sm border px-1.5 py-0.5 text-[10px] ${tone}`}>
          {v}
        </span>
      ))}
    </div>
  </div>
);


type StatusFilter = "all" | "pass" | "fail";

function isRunInDateRange(run: DriftRun, range: DateRangeValue | undefined) {
  if (!range?.from) return true;
  const ranAt = new Date(run.ranAt);
  const from = range.from.getTime();
  const to = range.to ? range.to.getTime() : from;
  const startOfFrom = new Date(from).setHours(0, 0, 0, 0);
  const endOfTo = new Date(to).setHours(23, 59, 59, 999);
  return ranAt.getTime() >= startOfFrom && ranAt.getTime() <= endOfTo;
}

export function DriftHistoryPanel({
  runs,
  onRunNow,
  isRunning = false,
}: {
  runs: DriftRun[];
  /** Triggers a fresh drift test; the panel refreshes when it completes. */
  onRunNow?: () => void;
  isRunning?: boolean;
}) {
  const [openIds, setOpenIds] = useState<string[]>([]);
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [dateRange, setDateRange] = useState<DateRangeValue | undefined>(undefined);

  const filteredRuns = useMemo(() => {
    return runs.filter((run) => {
      const statusMatch =
        statusFilter === "all" ||
        (statusFilter === "pass" && run.matched) ||
        (statusFilter === "fail" && !run.matched);
      const dateMatch = isRunInDateRange(run, dateRange);
      return statusMatch && dateMatch;
    });
  }, [runs, statusFilter, dateRange]);

  const hasFilters = statusFilter !== "all" || dateRange?.from;

  const toggle = (id: string) =>
    setOpenIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));

  const clearFilters = () => {
    setStatusFilter("all");
    setDateRange(undefined);
  };

  const statusPill = (key: StatusFilter, label: string) => (
    <button
      key={key}
      type="button"
      onClick={() => setStatusFilter(key)}
      aria-pressed={statusFilter === key}
      aria-label={`Filter by ${label.toLowerCase()}`}
      className={`kb-focus rounded-full px-2.5 py-1 text-[10px] uppercase tracking-wider transition-colors ${
        statusFilter === key
          ? "bg-foreground text-background"
          : "border border-border bg-card text-muted-foreground hover:text-foreground"
      }`}
    >
      {label}
    </button>
  );

  return (
    <div className="panel p-5">
      <div className="flex flex-wrap items-center gap-2">
        <History size={16} className="text-steel" />
        <div className="label-eyebrow">
          Drift history · {filteredRuns.length} of {runs.length} run{runs.length === 1 ? "" : "s"}
        </div>
        {onRunNow && (
          <button
            type="button"
            onClick={onRunNow}
            disabled={isRunning}
            className="kb-focus ml-auto flex items-center gap-1.5 rounded-sm border border-border bg-card px-2.5 py-1.5 text-[10px] uppercase tracking-widest hover:bg-accent disabled:opacity-60"
          >
            <RefreshCw size={11} aria-hidden="true" className={isRunning ? "motion-safe:animate-spin" : ""} />
            {isRunning ? "Running drift test…" : "Run drift test now"}
          </button>
        )}
      </div>
      <p className="mono mt-1 text-[10px] uppercase tracking-widest text-muted-foreground">
        Every recorded drift test, newest first — expand a run for the exact differences
      </p>

      <div className="mt-4 flex flex-wrap items-center gap-2" aria-label="Filter drift runs">
        {statusPill("all", "All")}
        {statusPill("pass", "Passed")}
        {statusPill("fail", "Failed")}
        <div className="h-4 w-px bg-border" aria-hidden="true" />
        <DateRangePicker
          value={dateRange}
          onChange={setDateRange}
          placeholder="Date range"
          presets={[
            { label: "Today", days: 0 },
            { label: "7 days", days: 7 },
            { label: "30 days", days: 30 },
          ]}
        />
        {hasFilters && (
          <button
            type="button"
            onClick={clearFilters}
            aria-label="Clear filters"
            className="kb-focus flex items-center gap-1 rounded-full px-2 py-1 text-[10px] uppercase tracking-wider text-muted-foreground hover:text-foreground"
          >
            <X size={11} aria-hidden="true" />
            Clear filters
          </button>
        )}
      </div>

      <p role="status" aria-live="polite" className="sr-only">
        {isRunning ? "Drift test running" : `Showing ${filteredRuns.length} drift runs`}
      </p>

      {runs.length === 0 ? (
        <p className="mt-4 text-sm text-muted-foreground">
          No drift checks recorded yet — run one with the button above.
        </p>
      ) : filteredRuns.length === 0 ? (
        <div className="mt-4 rounded-sm border border-border bg-background p-4">
          <p className="text-sm text-muted-foreground">
            No drift runs match the current filters.
          </p>
          <button
            type="button"
            onClick={clearFilters}
            className="kb-focus mt-2 text-xs text-primary hover:underline"
          >
            Clear filters and show all runs
          </button>
        </div>
      ) : (
        <ul className="mt-4 divide-y divide-border border-t border-border">
          {filteredRuns.map((run) => {
            const isOpen = openIds.includes(run.id);
            const diff = driftRunDifferences(run);
            return (
              <li key={run.id}>
                <button
                  type="button"
                  aria-expanded={isOpen}
                  aria-controls={`drift-run-${run.id}`}
                  onClick={() => toggle(run.id)}
                  className="kb-focus flex w-full items-start gap-3 py-3 text-left"
                >
                  <ChevronRight
                    size={13}
                    aria-hidden="true"
                    className={`mt-1 shrink-0 text-muted-foreground transition-transform ${isOpen ? "rotate-90" : ""}`}
                  />
                  {run.matched ? (
                    <Check size={14} className="mt-0.5 shrink-0 text-moss" aria-hidden="true" />
                  ) : (
                    <ShieldAlert size={14} className="mt-0.5 shrink-0 text-orange" aria-hidden="true" />
                  )}
                  <span className="min-w-0 flex-1">
                    <span className="mono block text-xs text-foreground">{fmtWhen(run.ranAt)}</span>
                    <span className="mt-0.5 block text-xs text-muted-foreground">
                      {run.detail ?? (run.matched ? "Values matched" : "Drift detected")}
                    </span>
                  </span>
                  <span
                    className={`mono shrink-0 rounded-sm px-1.5 py-0.5 text-[9px] uppercase tracking-widest ${
                      run.matched ? "bg-moss/15 text-moss" : "bg-orange/15 text-orange"
                    }`}
                  >
                    {run.matched ? "Passed" : "Failed"}
                  </span>
                </button>

                {isOpen && (
                  <div id={`drift-run-${run.id}`} className="space-y-3 pb-4 pl-8">
                    <FailureSummary run={run} />
                    <div className="mono text-[10px] uppercase tracking-widest text-muted-foreground">
                      {run.dbValues.length} database value{run.dbValues.length === 1 ? "" : "s"} ·{" "}
                      {run.generatedValues.length} generated value{run.generatedValues.length === 1 ? "" : "s"}
                    </div>

                    {diff.missingInDb.length > 0 && (
                      <ValueList
                        label="In code, not in database"
                        values={diff.missingInDb}
                        tone="border-orange/40 bg-orange/10 text-orange"
                      />
                    )}
                    {diff.missingInGenerated.length > 0 && (
                      <ValueList
                        label="In database, not in code"
                        values={diff.missingInGenerated}
                        tone="border-primary/40 bg-primary/10 text-primary"
                      />
                    )}
                    {diff.orderDiffers && (
                      <p className="mono text-[10px] uppercase tracking-widest text-orange">
                        Same values, different order
                      </p>
                    )}
                    {run.matched && (
                      <p className="text-xs text-muted-foreground">
                        No differences — the constraint and generated enum were identical, in order.
                      </p>
                    )}
                    <ValueList
                      label="Database constraint values at run time"
                      values={run.dbValues}
                      tone="border-border bg-background text-muted-foreground"
                    />
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
