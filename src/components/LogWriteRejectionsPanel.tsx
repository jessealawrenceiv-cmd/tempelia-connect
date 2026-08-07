/**
 * Operator panel: recent activity-log writes rejected by the action_type
 * whitelist, with requester context.
 */
import { useServerFn } from "@tanstack/react-start";
import { useQuery } from "@tanstack/react-query";
import { RefreshCw, ShieldAlert } from "lucide-react";
import { useState } from "react";

import {
  listLogWriteRejections,
  type LogWriteRejection,
} from "@/lib/log-write-rejections.functions";

const BLOCKED_TONE: Record<LogWriteRejection["blockedAt"], string> = {
  client: "text-steel",
  server: "text-orange",
  database: "text-destructive",
};

function fmtWhen(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
}

export function LogWriteRejectionsPanel() {
  const listFn = useServerFn(listLogWriteRejections);
  const [expanded, setExpanded] = useState<string | null>(null);

  const { data, isLoading, isFetching, error, refetch } = useQuery({
    queryKey: ["admin", "log-write-rejections"],
    queryFn: () => listFn({ data: { limit: 50 } }),
  });

  return (
    <div className="panel p-5" data-testid="log-write-rejections-panel">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <ShieldAlert size={16} className="text-orange" aria-hidden="true" />
          <div className="label-eyebrow">Rejected log writes</div>
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
        Every write blocked by <span className="mono">logs_action_type_check</span> — in the browser,
        on the server, or by the database — with the rejected action_type and requester context.
      </p>

      <div aria-live="polite" className="mt-4 space-y-2">
        {isLoading ? (
          <p className="mono text-xs uppercase tracking-widest text-muted-foreground">Loading…</p>
        ) : error ? (
          <p className="text-sm text-destructive">{(error as Error).message}</p>
        ) : !data || data.length === 0 ? (
          <p className="mono text-xs uppercase tracking-widest text-moss">
            No rejected log writes on record
          </p>
        ) : (
          data.map((row) => (
            <div key={row.id} className="rounded-sm border border-border bg-card/60 p-3">
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                <span className="mono text-xs font-medium">
                  {row.rejectedActionType ?? "(unknown)"}
                </span>
                <span
                  className={`mono text-[10px] uppercase tracking-widest ${BLOCKED_TONE[row.blockedAt]}`}
                >
                  blocked · {row.blockedAt}
                </span>
                <span className="mono text-[10px] uppercase tracking-widest text-muted-foreground">
                  {fmtWhen(row.occurredAt)}
                </span>
                {row.errorCode ? (
                  <span className="mono text-[10px] uppercase tracking-widest text-muted-foreground">
                    {row.errorCode}
                  </span>
                ) : null}
              </div>

              {row.rejectedActionTypes.length > 1 ? (
                <p className="mono mt-1 text-[10px] text-muted-foreground">
                  batch: {row.rejectedActionTypes.join(", ")}
                </p>
              ) : null}

              <button
                type="button"
                onClick={() => setExpanded((cur) => (cur === row.id ? null : row.id))}
                className="kb-focus mono mt-2 text-[10px] uppercase tracking-widest text-primary"
                aria-expanded={expanded === row.id}
              >
                {expanded === row.id ? "Hide context" : "Show context"}
              </button>

              {expanded === row.id ? (
                <dl className="mt-2 space-y-1 text-xs">
                  <Field label="Requester">{row.actorUserId ?? "—"}</Field>
                  <Field label="Route">{row.requestPath ?? "—"}</Field>
                  <Field label="Correlation">{row.correlationId ?? "—"}</Field>
                  <Field label="Constraint">{row.constraintName ?? "—"}</Field>
                  <Field label="User agent">{row.userAgent ?? "—"}</Field>
                  <Field label="Message">{row.errorMessage ?? "—"}</Field>
                  <div>
                    <dt className="mono text-[10px] uppercase tracking-widest text-muted-foreground">
                      Attempted row
                    </dt>
                    <dd>
                      <pre className="mono mt-1 overflow-x-auto rounded-sm bg-muted/40 p-2 text-[10px]">
                        {row.attemptedRowJson}
                      </pre>
                    </dd>
                  </div>
                </dl>
              ) : null}
            </div>
          ))
        )}
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-wrap gap-2">
      <dt className="mono w-28 shrink-0 text-[10px] uppercase tracking-widest text-muted-foreground">
        {label}
      </dt>
      <dd className="mono break-all text-[10px]">{children}</dd>
    </div>
  );
}
