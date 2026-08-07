/**
 * Drift history for the generated activity-log action_type enum.
 *
 * Lists every recorded drift test run with its timestamp and pass/fail status,
 * and lets an operator expand a run to see exactly which enum values differed
 * from the database CHECK constraint at that moment.
 */

import { useState } from "react";
import { Check, ChevronRight, History, RefreshCw, ShieldAlert } from "lucide-react";
import type { DriftRun } from "@/lib/log-action-diagnostics.functions";

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
  const toggle = (id: string) =>
    setOpenIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));

  return (
    <div className="panel p-5">
      <div className="flex flex-wrap items-center gap-2">
        <History size={16} className="text-steel" />
        <div className="label-eyebrow">Drift history · last {runs.length} run{runs.length === 1 ? "" : "s"}</div>
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
      <p role="status" aria-live="polite" className="sr-only">
        {isRunning ? "Drift test running" : ""}
      </p>

      {runs.length === 0 ? (
        <p className="mt-4 text-sm text-muted-foreground">
          No drift checks recorded yet — run one with the button above.
        </p>

      ) : (
        <ul className="mt-4 divide-y divide-border border-t border-border">
          {runs.map((run) => {
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
