import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Loader2, PlayCircle } from "lucide-react";
import { toast } from "sonner";
import {
  runActionTypeBackfill,
  listScopedBackfillRuns,
} from "@/lib/log-action-backfill.functions";
import {
  BACKFILL_SOURCE_LABEL,
  isBackfillable,
  type BackfillResult,
} from "@/lib/log-action-backfill";
import type { LogActionType } from "@/lib/log-action-types";

/**
 * One-click reconciliation/backfill for a single business + action type, with
 * live progress, the run result, and the recent run history for that business.
 */
export function ActionTypeBackfillButton({
  businessId,
  businessName,
  actionType,
}: {
  businessId: string;
  businessName: string;
  actionType: LogActionType;
}) {
  const run = useServerFn(runActionTypeBackfill);
  const fetchRuns = useServerFn(listScopedBackfillRuns);
  const queryClient = useQueryClient();
  const [result, setResult] = useState<BackfillResult | null>(null);
  const [showHistory, setShowHistory] = useState(false);

  const supported = isBackfillable(actionType);

  const history = useQuery({
    queryKey: ["admin", "scoped-backfill-runs", businessId],
    queryFn: () => fetchRuns({ data: { businessId } }),
    enabled: showHistory,
    retry: false,
  });

  const mutation = useMutation({
    mutationFn: () => run({ data: { businessId, actionType } }),
    onSuccess: (res) => {
      setResult(res);
      if (!res.supported) {
        toast.info("Nothing to backfill", { description: res.detail });
      } else if (res.insertedCount > 0) {
        toast.success(`Rebuilt ${res.insertedCount} entr${res.insertedCount === 1 ? "y" : "ies"}`, {
          description: `${businessName} · ${actionType}`,
        });
      } else {
        toast.info("No missing entries found", {
          description: `${businessName} · ${actionType}`,
        });
      }
      void queryClient.invalidateQueries({ queryKey: ["admin", "log-action-coverage"] });
      void queryClient.invalidateQueries({
        queryKey: ["admin", "scoped-backfill-runs", businessId],
      });
    },
    onError: (err: Error) => {
      setResult(null);
      toast.error("Backfill failed", { description: err.message });
    },
  });

  return (
    <div className="mt-2">
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          disabled={mutation.isPending || !supported}
          data-testid={`backfill-run-${actionType}`}
          onClick={() => mutation.mutate()}
          title={
            supported
              ? `Rebuild missing entries from ${BACKFILL_SOURCE_LABEL[actionType as keyof typeof BACKFILL_SOURCE_LABEL]}`
              : "No backfill source for this action type"
          }
          className="kb-focus mono flex items-center gap-1 rounded-sm border border-violet/50 bg-violet/10 px-2 py-1 text-[10px] uppercase tracking-widest text-paper hover:bg-violet/20 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {mutation.isPending ? (
            <Loader2 size={11} className="motion-safe:animate-spin" />
          ) : (
            <PlayCircle size={11} />
          )}
          {mutation.isPending ? "Backfilling…" : "Run backfill"}
        </button>

        <button
          type="button"
          aria-expanded={showHistory}
          onClick={() => setShowHistory((v) => !v)}
          className="kb-focus mono rounded-sm border border-border bg-card px-2 py-1 text-[10px] uppercase tracking-widest text-muted-foreground hover:bg-accent"
        >
          {showHistory ? "Hide run history" : "Run history"}
        </button>
      </div>

      <p
        aria-live="polite"
        data-testid={`backfill-status-${actionType}`}
        className="mono mt-1.5 text-[11px] text-muted-foreground"
      >
        {mutation.isPending
          ? `Scanning source records for ${actionType}…`
          : mutation.isError
            ? `Failed: ${(mutation.error as Error).message}`
            : result
              ? `${result.insertedCount} inserted · ${result.durationMs} ms · ${result.detail}`
              : supported
                ? `Source: ${BACKFILL_SOURCE_LABEL[actionType as keyof typeof BACKFILL_SOURCE_LABEL]}`
                : "No backfill source — entries are only written live by the app."}
      </p>

      {showHistory && (
        <div className="mt-2" data-testid={`backfill-history-${actionType}`}>
          {history.isLoading && (
            <p className="mono text-[11px] uppercase tracking-widest text-muted-foreground">
              Loading runs…
            </p>
          )}
          {history.error && (
            <p className="text-[11px] text-orange">{(history.error as Error).message}</p>
          )}
          {history.data && history.data.length === 0 && (
            <p className="text-[11px] text-muted-foreground">No manual backfill runs yet.</p>
          )}
          {history.data && history.data.length > 0 && (
            <ul className="space-y-1">
              {history.data.map((r) => (
                <li
                  key={r.id}
                  className="mono rounded-sm border border-border bg-background/40 px-2 py-1 text-[11px] text-muted-foreground"
                >
                  <span className="text-paper">
                    {new Date(r.ranAt).toLocaleString()} · {r.actionType ?? "—"}
                  </span>{" "}
                  · {r.insertedCount} inserted · {r.durationMs} ms
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
