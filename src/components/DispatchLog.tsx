import { useInfiniteQuery } from "@tanstack/react-query";
import { Link, useNavigate, useSearch } from "@tanstack/react-router";
import { supabase } from "@/integrations/supabase/client";
import { useEffect, useMemo, useRef, useState } from "react";
import { endOfDay, startOfDay } from "date-fns";
import { Download, Filter, Search, Sparkles } from "lucide-react";
import { toast } from "sonner";
import { DateRangePicker, type DateRangeValue } from "@/components/DateRangePicker";
import {
  EXPORT_ROW_CAP,
  buildLogCsv,
  downloadCsv,
  type FilterableQuery,
} from "@/lib/activity-log-csv";
import { LogAction, type LogActionType } from "@/lib/log-action-types";
import { parseLogRowsResponse } from "@/lib/log-action-types.schema";

import {
  LOG_ACTION_FILTER_ORDER,
  isNewLogAction,
  logActionDescription,
  logActionDot,
  logActionLabel,
} from "@/lib/log-action-presentation";


type AffectedRef = { type: "customer" | "intake"; id: string; label: string };

type LogRow = {
  id: string;
  action_type: LogActionType;
  message_sent: string | null;
  created_at: string;
  status: string | null;
  customer_id: string | null;
};

type RawLogRow = Omit<LogRow, "created_at" | "action_type"> & {
  action_type: string;
  created_at?: string | null;
  original_created_at?: string | null;
};


/** Keeps supabase-js from type-parsing the select string (build-time perf). */
const sel = (s: string): string => s;


function parseAffected(row: { action_type: string; message_sent: string | null }): AffectedRef[] {
  if (row.action_type !== LogAction.status_refresh || !row.message_sent) return [];
  try {
    const payload = JSON.parse(row.message_sent) as Record<string, unknown>;
    const list = payload["affected"];
    if (!Array.isArray(list)) return [];
    return list.filter(
      (a): a is AffectedRef =>
        !!a &&
        typeof a === "object" &&
        typeof (a as AffectedRef).id === "string" &&
        ((a as AffectedRef).type === "customer" || (a as AffectedRef).type === "intake"),
    );
  } catch {
    return [];
  }
}



// Refresh-attempt audit rows store structured JSON; render them as readable
// dispatch lines instead of dumping raw payloads.
const REFRESH_OUTCOME: Record<string, { text: string; dot: string }> = {
  updated: { text: "statuses updated", dot: "bg-primary" },
  already_current: { text: "already current", dot: "bg-steel" },
  failed: { text: "refresh failed", dot: "bg-orange" },
};

function describe(row: { action_type: string; status: string | null; message_sent: string | null }) {
  if (row.action_type !== LogAction.status_refresh && row.action_type !== LogAction.automation_status_change) {
    return row.message_sent ?? "—";
  }
  let payload: Record<string, unknown> = {};
  try {
    payload = row.message_sent ? (JSON.parse(row.message_sent) as Record<string, unknown>) : {};
  } catch {
    return row.message_sent ?? "—";
  }
  const parts: string[] = [];
  if (row.action_type === LogAction.status_refresh) {
    parts.push(REFRESH_OUTCOME[row.status ?? ""]?.text ?? row.status ?? "refresh");
    if (typeof payload["error_code"] === "string") parts.push(String(payload["error_code"]));
    if (typeof payload["error"] === "string") parts.push(String(payload["error"]));
    if (typeof payload["duration_ms"] === "number") parts.push(`${payload["duration_ms"]}ms`);
  } else {
    const changes = payload["changes"];
    if (Array.isArray(changes) && changes.length > 0) parts.push(changes.join(" · "));
    if (typeof payload["trigger"] === "string") parts.push(String(payload["trigger"]));
  }
  return parts.length > 0 ? parts.join(" — ") : (row.message_sent ?? "—");
}



const ORIGIN_LABEL: Record<"this-device" | "other-device" | "backend", string> = {
  "this-device": "This device",
  "other-device": "Another device",
  "backend": "Backend",
};

const typeLabel = logActionLabel;

const ALLOWED_TYPES = new Set<string>(LOG_ACTION_FILTER_ORDER);

/** Reads ?logTypes=a,b — unknown or duplicate values are dropped. */
export function parseLogTypesParam(raw: unknown): LogActionType[] {
  if (typeof raw !== "string" || raw.trim() === "") return [];
  const seen = new Set<LogActionType>();
  for (const part of raw.split(",")) {
    const value = part.trim();
    if (ALLOWED_TYPES.has(value)) seen.add(value as LogActionType);
  }
  return [...seen];
}

export function DispatchLog({ limit = 25 }: { limit?: number }) {
  const [statusRefreshOnly, setStatusRefreshOnly] = useState(false);
  const [failedOnly, setFailedOnly] = useState(false);
  const [originFilter, setOriginFilter] = useState<"all" | "active" | "this-device" | "other-device" | "backend">("all");
  // Record-type filters live in the URL (?logTypes=a,b) so a reload, back/forward,
  // or a shared link keeps the same view.
  const navigate = useNavigate();
  const rawLogTypes = useSearch({ strict: false, select: (s) => (s as { logTypes?: unknown }).logTypes });
  const selectedTypes = useMemo(() => parseLogTypesParam(rawLogTypes), [rawLogTypes]);
  const setSelectedTypes = (next: LogActionType[] | ((prev: LogActionType[]) => LogActionType[])) => {
    const value = typeof next === "function" ? next(selectedTypes) : next;
    void navigate({
      to: ".",
      search: (prev: Record<string, unknown>) => ({
        ...prev,
        logTypes: value.length > 0 ? value.join(",") : undefined,
      }),
      replace: true,
      resetScroll: false,
    });
  };
  const [scope, setScope] = useState<"live" | "archive">("live");
  const [searchQuery, setSearchQuery] = useState("");
  const [dateRange, setDateRange] = useState<DateRangeValue | undefined>(undefined);
  const [announcement, setAnnouncement] = useState("");
  const lastAnnouncedIdRef = useRef<string | null>(null);


  const searchTerms = useMemo(
    () =>
      searchQuery
        .trim()
        .toLowerCase()
        .split(/\s+/)
        .filter((t) => t.length > 0),
    [searchQuery],
  );

  const fromISO = dateRange?.from ? startOfDay(dateRange.from).toISOString() : undefined;
  const toISO = dateRange?.to ? endOfDay(dateRange.to).toISOString() : undefined;
  const hasRange = Boolean(fromISO && toISO);

  const typeKey = [...selectedTypes].sort().join(",");
  const searchKey = searchTerms.join(" ");

  // Every active filter is pushed down to Postgres. Shared by the paginated
  // list query and the CSV export so both always describe the same result set.
  const applyFilters = (q: FilterableQuery, timeCol: string, cursor: string | null): FilterableQuery => {
    let out = q;
    if (fromISO) out = out.gte(timeCol, fromISO);
    if (toISO) out = out.lte(timeCol, toISO);
    if (cursor) out = out.lt(timeCol, cursor);

    if (originFilter !== "all") {
      out = out.eq("action_type", LogAction.automation_status_change);
      if (originFilter !== "active") out = out.eq("status", originFilter);
    } else {
      if (statusRefreshOnly) out = out.eq("action_type", LogAction.status_refresh);
      if (failedOnly) out = out.eq("action_type", LogAction.status_refresh).eq("status", "failed");
      if (selectedTypes.length > 0) out = out.in("action_type", selectedTypes);
    }

    // Free-text search runs in Postgres so pages stay full-size.
    for (const term of searchTerms) {
      const safe = term.replace(/[%,()]/g, "");
      if (!safe) continue;
      out = out.or(`message_sent.ilike.%${safe}%,action_type.ilike.%${safe}%`);
    }
    return out;
  };

  const fetchLogPage = async (pageSize: number, cursor: string | null): Promise<LogRow[]> => {
    const archive = scope === "archive";
    const timeCol = archive ? "original_created_at" : "created_at";
    const base = supabase
      .from(archive ? "logs_archive" : "logs")
      .select(sel(`id, action_type, message_sent, ${timeCol}, status, customer_id`))
      .order(timeCol, { ascending: false })
      .limit(pageSize);

    const q = applyFilters(base as unknown as FilterableQuery, timeCol, cursor);
    const { data: rows, error } = await (q as unknown as typeof base).returns<RawLogRow[]>();
    if (error) throw error;
    // Validate on the way in: an action_type outside the generated whitelist
    // is dropped here so no UI code can ever receive an unknown value.
    const parsed = parseLogRowsResponse(rows ?? []);
    if (parsed.droppedCount > 0) {
      console.warn(
        `[activity-log] dropped ${parsed.droppedCount} row(s) with unknown action_type: ${parsed.unknownActionTypes.join(", ")}`,
      );
    }
    return parsed.rows.map((r) => ({
      id: r.id,
      action_type: r.action_type,
      message_sent: r.message_sent,
      created_at: (r.created_at ?? r.original_created_at) as string,
      status: r.status,
      customer_id: r.customer_id,
    }));

  };

  // Server-side keyset pagination: only one small page ships over mobile data.
  const {
    data,
    isLoading,
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage,
  } = useInfiniteQuery({
    queryKey: [
      "logs",
      scope,
      limit,
      fromISO,
      toISO,
      typeKey,
      searchKey,
      statusRefreshOnly,
      failedOnly,
      originFilter,
    ],
    initialPageParam: null as string | null,
    getNextPageParam: (lastPage: LogRow[]) =>
      lastPage.length < limit ? undefined : (lastPage[lastPage.length - 1]?.created_at ?? undefined),
    queryFn: ({ pageParam }) => fetchLogPage(limit, pageParam),
  });

  const rows = useMemo(() => (data?.pages ?? []).flat(), [data]);

  const [isExporting, setIsExporting] = useState(false);

  /** Exports every record matching the current filters (not just loaded pages). */
  const exportCsv = async () => {
    setIsExporting(true);
    try {
      const all = await fetchLogPage(EXPORT_ROW_CAP, null);
      if (all.length === 0) {
        toast.info("Nothing to export for the current filters.");
        return;
      }
      downloadCsv(buildLogCsv(all), scope);
      toast.success(
        all.length === EXPORT_ROW_CAP
          ? `Exported the newest ${EXPORT_ROW_CAP} matching records.`
          : `Exported ${all.length} record${all.length === 1 ? "" : "s"}.`,
      );
    } catch (err) {
      toast.error("Export failed", { description: err instanceof Error ? err.message : "Please try again." });
    } finally {
      setIsExporting(false);
    }
  };

  const typeCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const row of rows) counts[row.action_type] = (counts[row.action_type] ?? 0) + 1;
    return counts;
  }, [rows]);


  const toggleType = (t: LogActionType) =>
    setSelectedTypes((prev) => (prev.includes(t) ? prev.filter((v) => v !== t) : [...prev, t]));

  const filtered = rows;




  useEffect(() => {
    if (scope !== "live") return;
    const latest = filtered[0];
    if (!latest || latest.id === lastAnnouncedIdRef.current) return;
    lastAnnouncedIdRef.current = latest.id;
    const time = new Date(latest.created_at).toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit",
    });
    setAnnouncement(`New activity: ${logActionLabel(latest.action_type)} at ${time}`);
  }, [filtered, scope]);

  return (
    <div className="panel">
      <div
        aria-live="polite"
        aria-atomic="true"
        className="sr-only"
      >
        {announcement}
      </div>
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-5 py-3">
        <div className="label-eyebrow">Activity</div>
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-1.5">
            {(["live", "archive"] as const).map((key) => (
              <button
                key={key}
                type="button"
                aria-pressed={scope === key}
                onClick={() => setScope(key)}
                className={`kb-focus rounded-full px-2.5 py-1 text-[10px] uppercase tracking-wider transition-colors ${
                  scope === key
                    ? "bg-primary text-paper"
                    : "bg-muted text-muted-foreground hover:bg-muted/80 hover:text-foreground"
                }`}
              >
                {key === "live" ? "Recent" : "Archive"}
              </button>
            ))}
          </div>
          {scope === "live" ? (
            <span className="mono flex items-center gap-1.5 text-[10px] uppercase tracking-widest text-moss">
              <span className="h-2 w-2 animate-pulse rounded-full bg-moss" />
              Live
            </span>
          ) : (
            <span className="mono text-[10px] uppercase tracking-widest text-muted-foreground">
              Archived
            </span>
          )}
        </div>
      </div>

      <div className="border-b border-border px-5 py-3">
        <div className="flex flex-wrap items-center gap-4">
          <span className="mono flex items-center gap-1.5 text-[10px] uppercase tracking-widest text-muted-foreground">
            <Filter size={12} />
            Filter
          </span>

          <div className="relative flex items-center">
            <Search size={12} className="pointer-events-none absolute left-2.5 text-muted-foreground" />
            <input
              type="search"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search messages…"
              aria-label="Search activity messages"
              className="kb-focus h-7 w-40 rounded-full border border-border bg-background pl-7 pr-7 text-xs text-foreground placeholder:text-muted-foreground focus:border-primary focus:outline-none sm:w-56"
            />
            {searchQuery && (
              <button
                type="button"
                aria-label="Clear search"
                onClick={() => setSearchQuery("")}
                className="kb-focus absolute right-2 text-muted-foreground hover:text-foreground"
              >
                ×
              </button>
            )}
          </div>

          <DateRangePicker
            value={dateRange}
            onChange={(next) => {
              setDateRange(next);
            }}
            placeholder="Date range"
          />

          <label className="flex cursor-pointer items-center gap-2 text-xs text-foreground">
            <input
              type="checkbox"
              className="h-3.5 w-3.5 accent-primary"
              checked={statusRefreshOnly}
              disabled={originFilter !== "all"}
              onChange={(e) => {
                setStatusRefreshOnly(e.target.checked);
                if (!e.target.checked) setFailedOnly(false);
              }}
            />
            STATUS_REFRESH only
          </label>
          <label
            className={`flex items-center gap-2 text-xs ${
              statusRefreshOnly && originFilter === "all"
                ? "cursor-pointer text-foreground"
                : "cursor-not-allowed text-muted-foreground"
            }`}
          >
            <input
              type="checkbox"
              className="h-3.5 w-3.5 accent-primary"
              checked={failedOnly}
              disabled={!statusRefreshOnly || originFilter !== "all"}
              onChange={(e) => setFailedOnly(e.target.checked)}
            />
            Failed only
          </label>

          <span className="mx-1 h-4 w-px bg-border" aria-hidden="true" />

          <div className="flex flex-wrap items-center gap-2">
            <span className="mono text-[10px] uppercase tracking-widest text-muted-foreground">ACTIVE changes</span>
            {(["all", "active", "this-device", "other-device", "backend"] as const).map((key) => {
              const active = originFilter === key;
              return (
                <button
                  key={key}
                  type="button"
                  aria-pressed={active}
                  onClick={() => {
                    setOriginFilter(key);
                    if (key !== "all") {
                      setStatusRefreshOnly(false);
                      setFailedOnly(false);
                    }
                  }}
                  className={`kb-focus rounded-full px-2.5 py-1 text-[10px] uppercase tracking-wider transition-colors ${
                    active
                      ? "bg-primary text-paper"
                      : "bg-muted text-muted-foreground hover:bg-muted/80 hover:text-foreground"
                  }`}
                >
                  {key === "all" ? "All activity" : key === "active" ? "ACTIVE only" : ORIGIN_LABEL[key]}
                </button>
              );
            })}
          </div>

          <span className="mx-1 h-4 w-px bg-border" aria-hidden="true" />

          <button
            type="button"
            onClick={exportCsv}
            disabled={isExporting}
            aria-busy={isExporting}
            title="Download the records matching the current filters as CSV"
            className="kb-focus inline-flex items-center gap-1.5 rounded-full border border-border bg-background px-2.5 py-1 text-[10px] uppercase tracking-wider text-foreground transition-colors hover:border-primary hover:text-primary disabled:cursor-not-allowed disabled:opacity-60"
          >
            <Download size={11} aria-hidden="true" />
            {isExporting ? "Exporting…" : "Export CSV"}
          </button>

        </div>


        <fieldset className="mt-3 border-t border-border pt-3">
          <legend className="mono flex items-center gap-2 px-0 text-[10px] uppercase tracking-widest text-muted-foreground">
            Record type
            {selectedTypes.length > 0 && (
              <button
                type="button"
                onClick={() => setSelectedTypes([])}
                className="kb-focus rounded-full border border-border px-2 py-0.5 text-[10px] normal-case tracking-normal text-foreground hover:border-primary hover:text-primary"
              >
                Clear {selectedTypes.length} selected
              </button>
            )}
          </legend>
          <div className="mt-2 flex flex-wrap gap-1.5">
            {LOG_ACTION_FILTER_ORDER.map((t) => {
              const selected = selectedTypes.includes(t);
              const isNew = isNewLogAction(t);
              const count = typeCounts[t] ?? 0;
              return (
                <button
                  key={t}
                  type="button"
                  aria-pressed={selected}
                  onClick={() => toggleType(t)}
                  title={isNew ? `${logActionDescription(t)} — newly added type` : logActionDescription(t)}
                  className={`kb-focus mono inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[10px] uppercase tracking-wider transition-colors ${
                    selected
                      ? "border-primary bg-primary text-paper"
                      : isNew
                        ? "border-primary/60 bg-primary/10 text-primary hover:bg-primary/20"
                        : "border-border bg-muted text-muted-foreground hover:bg-muted/80 hover:text-foreground"
                  }`}
                >
                  {isNew && <Sparkles size={10} aria-hidden="true" />}
                  {typeLabel(t)}
                  {isNew && (
                    <span
                      className={`rounded-sm px-1 text-[9px] tracking-widest ${
                        selected ? "bg-paper/20 text-paper" : "bg-primary/20 text-primary"
                      }`}
                    >
                      New
                    </span>
                  )}
                  {count > 0 && <span className={selected ? "text-paper/80" : "text-foreground/60"}>{count}</span>}
                </button>
              );
            })}
          </div>
        </fieldset>
      </div>


      <ul className="mono max-h-[520px] divide-y divide-border overflow-y-auto text-xs">
        {isLoading && <li className="p-5 text-muted-foreground">Loading…</li>}
        {!isLoading && filtered.length === 0 && (
          <li className="p-5 text-muted-foreground">
            {hasRange
              ? "No entries in the selected date range. Try widening the range or clearing filters."
              : selectedTypes.length > 0 ||
                  searchTerms.length > 0 ||
                  statusRefreshOnly ||
                  failedOnly ||
                  originFilter !== "all"
                ? "No entries match the selected filters."
                : scope === "archive"
                  ? "Nothing archived yet. Entries older than 90 days move here automatically."
                  : "No dispatches yet. Actions will appear here in real time."}
          </li>
        )}


        {filtered.map((row) => {
          const affected = parseAffected(row);
          return (
          <li key={row.id} className="grid grid-cols-[auto_auto_1fr] items-start gap-3 px-5 py-3">
            <span className="text-muted-foreground">
              {new Date(row.created_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}
            </span>
            <span
              className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${
                (row.action_type === LogAction.status_refresh
                  ? REFRESH_OUTCOME[row.status ?? ""]?.dot
                  : undefined) ?? logActionDot(row.action_type)
              }`}
            />
            <span>
              <span className="mr-2 font-semibold text-foreground" title={logActionDescription(row.action_type)}>
                {logActionLabel(row.action_type)}
              </span>
              {row.action_type === LogAction.automation_status_change && row.status && row.status in ORIGIN_LABEL && (
                <span className="mr-2 inline-flex items-center rounded bg-muted px-1 py-0.5 text-[10px] uppercase tracking-wider text-muted-foreground">
                  {ORIGIN_LABEL[row.status as keyof typeof ORIGIN_LABEL]}
                </span>
              )}
              <span className="text-foreground/80">{describe(row)}</span>
              {affected.length > 0 && (
                <span className="mt-1.5 flex flex-wrap items-center gap-1.5">
                  <span className="text-[10px] uppercase tracking-widest text-muted-foreground">affected</span>
                  {affected.map((a) =>
                    a.type === "customer" ? (
                      <Link
                        key={`c-${a.id}`}
                        to="/dashboard/contacts"
                        search={{ customerId: a.id }}
                        className="rounded-sm border border-border px-1.5 py-0.5 text-[10px] text-primary hover:border-primary hover:underline"
                        title="Open this contact"
                      >
                        {a.label}
                      </Link>
                    ) : (
                      <Link
                        key={`i-${a.id}`}
                        to="/dashboard/intakes"
                        search={{ intakeId: a.id }}
                        className="rounded-sm border border-border px-1.5 py-0.5 text-[10px] text-steel hover:border-steel hover:underline"
                        title="Open this submission"
                      >
                        {a.label} · intake
                      </Link>
                    ),
                  )}
                </span>
              )}
            </span>
          </li>
          );
        })}
      </ul>

      {filtered.length > 0 && (
        <div className="flex items-center justify-between gap-3 border-t border-border px-5 py-3">
          <span className="mono text-[10px] uppercase tracking-widest text-muted-foreground">
            {filtered.length} loaded
          </span>
          {hasNextPage ? (
            <button
              type="button"
              onClick={() => void fetchNextPage()}
              disabled={isFetchingNextPage}
              className="kb-focus rounded-full border border-border px-3 py-1 text-[10px] uppercase tracking-widest text-foreground transition-colors hover:border-primary hover:text-primary disabled:opacity-60"
            >
              {isFetchingNextPage ? "Loading…" : `Load ${limit} older`}
            </button>
          ) : (
            <span className="mono text-[10px] uppercase tracking-widest text-muted-foreground">
              End of log
            </span>
          )}
        </div>
      )}
    </div>

  );
}
