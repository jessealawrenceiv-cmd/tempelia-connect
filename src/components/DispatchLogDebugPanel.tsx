/**
 * Developer/debug panel for the Activity log.
 *
 * Reconnect bugs ("rows stopped arriving", "the same row showed up twice",
 * "Load more returned nothing") are almost always one of three things: the
 * Realtime channel is not actually subscribed, no event has been received in a
 * while, or the keyset cursor has run past the end of the filtered set. This
 * panel surfaces exactly those three facts so a support conversation can be
 * resolved by reading rather than guessing.
 *
 * Hidden unless ?logDebug=1 is in the URL — it is a diagnostic surface, not a
 * feature, and it must never add noise to the normal log view.
 */
import { useEffect, useState } from "react";

/** Lifecycle of the Realtime channel, mirrored from the subscribe() callback. */
export type RealtimeDebugStatus =
  | "idle"
  | "disabled"
  | "subscribing"
  | "subscribed"
  | "reconnecting"
  | "closed"
  | "error";

export type RealtimeDebugState = {
  status: RealtimeDebugStatus;
  /** Channel topic, useful when several tabs share a connection. */
  channel: string | null;
  /** When the current status was entered (ms epoch). */
  since: number | null;
  /** Raw status string last reported by the client, verbatim. */
  rawStatus: string | null;
  /** Number of subscribe() transitions since mount — climbs on reconnect loops. */
  transitions: number;
};

export type LastEventDebugState = {
  /** Row id from the last postgres_changes payload we saw. */
  id: string | null;
  receivedAt: number | null;
  /** True when the row passed the active filter chain and was prepended. */
  applied: boolean | null;
  /** Why it was not applied, when it wasn't (filtered out, duplicate, error). */
  outcome: string | null;
  /** Total payloads received since mount, including ones we discarded. */
  received: number;
  /** Payloads that actually became a row in the list. */
  appliedCount: number;
};

export type CursorDebugState = {
  /** Cursor that the next page request will use, or null when exhausted. */
  nextCursor: string | null;
  /** Cursors already consumed, oldest first (the initial page is null). */
  pageParams: (string | null)[];
  pages: number;
  rowsLoaded: number;
  pageSize: number;
  sortDir: "newest" | "oldest";
  scope: "live" | "archive";
  hasNextPage: boolean;
  isFetchingNextPage: boolean;
  queryKey: unknown[];
};

export const REALTIME_STATUS_LABEL: Record<RealtimeDebugStatus, string> = {
  idle: "Not started",
  disabled: "Disabled (polling only)",
  subscribing: "Subscribing…",
  subscribed: "Subscribed",
  reconnecting: "Reconnecting",
  closed: "Closed",
  error: "Error",
};

const STATUS_TONE: Record<RealtimeDebugStatus, string> = {
  idle: "text-muted-foreground",
  disabled: "text-muted-foreground",
  subscribing: "text-moss",
  subscribed: "text-moss",
  reconnecting: "text-amber-400",
  closed: "text-muted-foreground",
  error: "text-destructive",
};

/** Live-updating "12s ago" so a stalled channel is obvious at a glance. */
function useAgeLabel(at: number | null): string {
  const [, setTick] = useState(0);
  useEffect(() => {
    if (at === null) return;
    const id = window.setInterval(() => setTick((t) => t + 1), 1000);
    return () => window.clearInterval(id);
  }, [at]);
  if (at === null) return "—";
  const secs = Math.max(0, Math.round((Date.now() - at) / 1000));
  if (secs < 60) return `${secs}s ago`;
  if (secs < 3600) return `${Math.floor(secs / 60)}m ago`;
  return `${Math.floor(secs / 3600)}h ago`;
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-1">
      <dt className="mono shrink-0 text-[10px] uppercase tracking-widest text-muted-foreground">
        {label}
      </dt>
      <dd className="mono min-w-0 break-all text-right text-[11px] text-foreground">{children}</dd>
    </div>
  );
}

const dash = <span className="text-muted-foreground">—</span>;

export function DispatchLogDebugPanel({
  realtime,
  lastEvent,
  cursor,
}: {
  realtime: RealtimeDebugState;
  lastEvent: LastEventDebugState;
  cursor: CursorDebugState;
}) {
  const statusAge = useAgeLabel(realtime.since);
  const eventAge = useAgeLabel(lastEvent.receivedAt);

  return (
    <section
      data-testid="dispatch-log-debug"
      aria-label="Activity log diagnostics"
      className="border-t border-dashed border-border bg-muted/30 px-5 py-3"
    >
      <div className="mono mb-2 text-[10px] uppercase tracking-widest text-muted-foreground">
        Diagnostics
      </div>
      <div className="grid gap-x-8 gap-y-1 sm:grid-cols-3">
        <dl>
          <Row label="Subscription">
            <span
              data-testid="debug-realtime-status"
              data-status={realtime.status}
              className={STATUS_TONE[realtime.status]}
            >
              {REALTIME_STATUS_LABEL[realtime.status]}
            </span>
          </Row>
          <Row label="Since">{realtime.since === null ? dash : statusAge}</Row>
          <Row label="Channel">{realtime.channel ?? dash}</Row>
          <Row label="Raw status">{realtime.rawStatus ?? dash}</Row>
          <Row label="Transitions">
            <span data-testid="debug-realtime-transitions">{realtime.transitions}</span>
          </Row>
        </dl>

        <dl>
          <Row label="Last event id">
            <span data-testid="debug-last-event-id">{lastEvent.id ?? dash}</span>
          </Row>
          <Row label="Received">{lastEvent.receivedAt === null ? dash : eventAge}</Row>
          <Row label="Outcome">
            {lastEvent.outcome ? (
              <span className={lastEvent.applied ? "text-moss" : "text-muted-foreground"}>
                {lastEvent.outcome}
              </span>
            ) : (
              dash
            )}
          </Row>
          <Row label="Events seen">
            <span data-testid="debug-events-seen">
              {lastEvent.appliedCount}/{lastEvent.received} applied
            </span>
          </Row>
        </dl>

        <dl>
          <Row label="Next cursor">
            <span data-testid="debug-next-cursor">
              {cursor.nextCursor ?? (cursor.hasNextPage ? "pending" : "end of results")}
            </span>
          </Row>
          <Row label="Pages">
            {cursor.pages} × {cursor.pageSize}
          </Row>
          <Row label="Rows loaded">{cursor.rowsLoaded}</Row>
          <Row label="Fetching next">{cursor.isFetchingNextPage ? "yes" : "no"}</Row>
          <Row label="Order / scope">
            {cursor.sortDir} · {cursor.scope}
          </Row>
        </dl>
      </div>

      <details className="mt-2">
        <summary className="kb-focus mono cursor-pointer text-[10px] uppercase tracking-widest text-muted-foreground hover:text-foreground">
          Cursor history &amp; query key
        </summary>
        <pre className="mono mt-2 max-h-48 overflow-auto whitespace-pre-wrap break-all rounded-md border border-border bg-background p-2 text-[10px] leading-relaxed text-muted-foreground">
{JSON.stringify({ pageParams: cursor.pageParams, queryKey: cursor.queryKey }, null, 2)}
        </pre>
      </details>
    </section>
  );
}
