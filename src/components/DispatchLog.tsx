import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { useVirtualizer } from "@tanstack/react-virtual";
import { Link, useNavigate, useSearch } from "@tanstack/react-router";
import { supabase } from "@/integrations/supabase/client";
import { useEffect, useMemo, useRef, useState } from "react";
import { endOfDay, startOfDay } from "date-fns";
import { AlertTriangle, ArrowDown, ArrowUp, Copy, Download, Filter, Search, Sparkles, X } from "lucide-react";
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
  MAX_LOG_SEARCH_LENGTH,
  friendlyLogRequestError,
  validateActivityLogFilters,
} from "@/lib/activity-log-filters.schema";


import {
  LOG_ACTION_FILTER_ORDER,
  isNewLogAction,
  logActionDescription,
  logActionDot,
  logActionLabel,
} from "@/lib/log-action-presentation";


/** Above this many loaded rows the list renders windowed instead of in full. */
const VIRTUALIZE_THRESHOLD = 60;

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

/** Formats a log row as a single dispatch line suitable for support notes. */
function formatDispatchLine(row: LogRow): string {
  const time = new Date(row.created_at).toLocaleString([], {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const origin =
    row.action_type === LogAction.automation_status_change && row.status && row.status in ORIGIN_LABEL
      ? ` [${ORIGIN_LABEL[row.status as keyof typeof ORIGIN_LABEL]}]`
      : "";
  const affected = parseAffected(row)
    .map((a) => (a.type === "customer" ? `contact:${a.label}` : `intake:${a.label}`))
    .join(", ");
  const suffix = affected ? ` | affected: ${affected}` : "";
  return `${time} · ${logActionLabel(row.action_type)}${origin} · ${describe(row)}${suffix}`;
}

const ORIGIN_LABEL: Record<"this-device" | "other-device" | "backend", string> = {
  "this-device": "This device",
  "other-device": "Another device",
  "backend": "Backend",
};

const typeLabel = logActionLabel;


/** Reads ?logTypes=a,b — unknown or duplicate values are dropped. */
export function parseLogTypesParam(raw: unknown): LogActionType[] {
  return validateActivityLogFilters({ logTypes: raw }).value.selectedTypes;
}

const LOG_TYPES_STORAGE_KEY = "temaro-activity-log-types";

function readStoredTypes(): LogActionType[] | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(LOG_TYPES_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return null;
    const valid = parsed.filter((t): t is LogActionType =>
      Object.values(LogAction).includes(t as LogActionType),
    );
    return valid.length > 0 ? valid : null;
  } catch {
    return null;
  }
}

function writeStoredTypes(types: LogActionType[]) {
  if (typeof window === "undefined") return;
  try {
    if (types.length === 0) {
      window.localStorage.removeItem(LOG_TYPES_STORAGE_KEY);
    } else {
      window.localStorage.setItem(LOG_TYPES_STORAGE_KEY, JSON.stringify(types));
    }
  } catch {
    // Storage may be unavailable or full; persistence is best-effort.
  }
}

/** Parses a ?dateFrom=/?dateTo= day string (yyyy-MM-dd) into a local Date. */
function parseDayParam(value: unknown): Date | undefined {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return undefined;
  const [y, m, d] = value.split("-").map(Number) as [number, number, number];
  const date = new Date(y, m - 1, d);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

/** Serialises a Date to the yyyy-MM-dd form used in the URL. */
function toDayParam(date: Date): string {
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${m}-${d}`;
}

export function DispatchLog({ limit = 25 }: { limit?: number }) {
  // Record-type filters, sort, free-text search, and the date range all live in
  // the URL (?logTypes=a,b&logSort=oldest&q=text&dateFrom=…&dateTo=…) so a
  // reload, back/forward, or a shared link keeps the same view. Because that
  // payload is untrusted, it is Zod-validated and any problem is surfaced to the
  // user in plain language instead of silently dropped.
  const navigate = useNavigate();
  const rawSearch = useSearch({ strict: false }) as {
    logTypes?: unknown;
    logSort?: unknown;
    q?: unknown;
    dateFrom?: unknown;
    dateTo?: unknown;
  };

  const [statusRefreshOnly, setStatusRefreshOnly] = useState(false);
  const [failedOnly, setFailedOnly] = useState(false);
  const [originFilter, setOriginFilter] = useState<"all" | "active" | "this-device" | "other-device" | "backend">("all");
  const [scope, setScope] = useState<"live" | "archive">("live");
  // The input stays local for responsive typing and is mirrored into ?q= (see below).
  const [searchQuery, setSearchQuery] = useState(typeof rawSearch.q === "string" ? rawSearch.q : "");
  const urlFrom = parseDayParam(rawSearch.dateFrom);
  const urlTo = parseDayParam(rawSearch.dateTo);
  const dateRange: DateRangeValue | undefined = urlFrom
    ? { from: urlFrom, ...(urlTo ? { to: urlTo } : {}) }
    : undefined;
  const setDateRange = (next: DateRangeValue | undefined) => {
    void navigate({
      to: ".",
      search: (prev: Record<string, unknown>) => ({
        ...prev,
        dateFrom: next?.from ? toDayParam(next.from) : undefined,
        dateTo: next?.to ? toDayParam(next.to) : undefined,
      }),
      resetScroll: false,
    });
  };

  const [announcement, setAnnouncement] = useState("");
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const lastAnnouncedIdRef = useRef<string | null>(null);

  const rawLogTypes = rawSearch.logTypes;
  const validation = useMemo(
    () =>
      validateActivityLogFilters({
        logTypes: rawLogTypes,
        logSort: rawSearch.logSort,
        q: searchQuery,
        dateFrom: dateRange?.from,
        dateTo: dateRange?.to,
      }),
    [rawLogTypes, rawSearch.logSort, searchQuery, dateRange?.from, dateRange?.to],
  );

  const filterIssues = validation.issues;
  const selectedTypes = validation.value.selectedTypes;
  const sortDir = validation.value.sortDir;

  const setSelectedTypes = (next: LogActionType[] | ((prev: LogActionType[]) => LogActionType[])) => {
    const value = typeof next === "function" ? next(selectedTypes) : next;
    void navigate({
      to: ".",
      search: (prev: Record<string, unknown>) => ({
        ...prev,
        logTypes: value.length > 0 ? value.join(",") : undefined,
      }),
      resetScroll: false,
    });
  };
  const setSortDir = (value: "newest" | "oldest") => {
    void navigate({
      to: ".",
      search: (prev: Record<string, unknown>) => ({
        ...prev,
        logSort: value === "oldest" ? "oldest" : undefined,
      }),
      resetScroll: false,
    });
  };
  /** Clears every filter, including any invalid values that came from the URL. */
  const resetFilters = () => {
    setStatusRefreshOnly(false);
    setFailedOnly(false);
    setOriginFilter("all");
    setSearchQuery("");
    setDateRange(undefined);
    writeStoredTypes([]);
    void navigate({
      to: ".",
      search: (prev: Record<string, unknown>) => ({ ...prev, logTypes: undefined, logSort: undefined }),
      resetScroll: false,
    });
  };

  // Restore the last-used action-type filters from localStorage when the URL
  // does not already specify ?logTypes=. URL params always win.
  useEffect(() => {
    if (rawLogTypes != null) return;
    const stored = readStoredTypes();
    if (stored && stored.length > 0) {
      void navigate({
        to: ".",
        search: (prev: Record<string, unknown>) => ({ ...prev, logTypes: stored.join(",") }),
        replace: true,
        resetScroll: false,
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Remember action-type filter changes as the user makes them.
  useEffect(() => {
    writeStoredTypes(selectedTypes);
  }, [selectedTypes]);



  // Use the validated (length-capped) query, not the raw input.
  const safeSearchQuery = validation.value.searchQuery;
  const searchTerms = useMemo(
    () =>
      safeSearchQuery
        .trim()
        .toLowerCase()
        .split(/\s+/)
        .filter((t) => t.length > 0),
    [safeSearchQuery],
  );

  const fromISO = dateRange?.from ? startOfDay(dateRange.from).toISOString() : undefined;
  const toISO = dateRange?.to ? endOfDay(dateRange.to).toISOString() : undefined;
  const hasRange = Boolean(fromISO && toISO);

  const typeKey = [...selectedTypes].sort().join(",");
  const searchKey = searchTerms.join(" ");

  const hasActiveFilters =
    selectedTypes.length > 0 ||
    searchQuery.trim().length > 0 ||
    statusRefreshOnly ||
    failedOnly ||
    originFilter !== "all" ||
    dateRange?.from != null ||
    sortDir === "oldest";

  // A search term can also be a customer's name or phone number. Names live on
  // `customers`, not `logs`, so resolve each term to matching customer ids first
  // and fold those ids into that term's Postgres OR clause.
  const { data: termCustomerIds } = useQuery({
    queryKey: ["log-search-customers", searchKey],
    enabled: searchTerms.length > 0,
    staleTime: 30_000,
    queryFn: async (): Promise<Record<string, string[]>> => {
      const out: Record<string, string[]> = {};
      for (const term of searchTerms) {
        const safe = term.replace(/[%,()]/g, "");
        if (!safe) continue;
        const { data, error } = await supabase
          .from("customers")
          .select(sel("id"))
          .or(
            `first_name.ilike.%${safe}%,last_name.ilike.%${safe}%,phone_number.ilike.%${safe}%,email.ilike.%${safe}%`,
          )
          .limit(300)
          .returns<{ id: string }[]>();
        if (error) throw error;
        out[safe] = (data ?? []).map((r) => r.id);
      }
      return out;
    },
  });
  const customerMatchKey = JSON.stringify(termCustomerIds ?? {});

  // Every active filter is pushed down to Postgres. Shared by the paginated
  // list query and the CSV export so both always describe the same result set.
  const applyFilters = (q: FilterableQuery, timeCol: string, cursor: string | null): FilterableQuery => {
    let out = q;
    if (fromISO) out = out.gte(timeCol, fromISO);
    if (toISO) out = out.lte(timeCol, toISO);
    // Keyset cursor: strictly past the last row seen, in the active sort direction.
    if (cursor) out = sortDir === "oldest" ? out.gt(timeCol, cursor) : out.lt(timeCol, cursor);

    if (originFilter !== "all") {
      out = out.eq("action_type", LogAction.automation_status_change);
      if (originFilter !== "active") out = out.eq("status", originFilter);
    } else {
      if (statusRefreshOnly) out = out.eq("action_type", LogAction.status_refresh);
      if (failedOnly) out = out.eq("action_type", LogAction.status_refresh).eq("status", "failed");
      if (selectedTypes.length > 0) out = out.in("action_type", selectedTypes);
    }

    // Free-text search runs in Postgres so pages stay full-size. Each term must
    // match somewhere: message text, record type, the recipient phone number, or
    // a customer whose name/phone/email matched the term.
    for (const term of searchTerms) {
      const safe = term.replace(/[%,()]/g, "");
      if (!safe) continue;
      const clauses = [
        `message_sent.ilike.%${safe}%`,
        `action_type.ilike.%${safe}%`,
        `recipient_phone.ilike.%${safe}%`,
      ];
      const ids = termCustomerIds?.[safe] ?? [];
      if (ids.length > 0) clauses.push(`customer_id.in.(${ids.join(",")})`);
      out = out.or(clauses.join(","));
    }
    return out;
  };

  const fetchLogPage = async (pageSize: number, cursor: string | null): Promise<LogRow[]> => {
    const archive = scope === "archive";
    const timeCol = archive ? "original_created_at" : "created_at";
    const base = supabase
      .from(archive ? "logs_archive" : "logs")
      .select(sel(`id, action_type, message_sent, ${timeCol}, status, customer_id`))
      .order(timeCol, { ascending: sortDir === "oldest" })
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
    error: logError,
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage,
    refetch,
  } = useInfiniteQuery({
    queryKey: [
      "logs",
      scope,
      limit,
      fromISO,
      toISO,
      typeKey,
      searchKey,
      customerMatchKey,
      statusRefreshOnly,
      failedOnly,
      originFilter,
      sortDir,
    ],
    initialPageParam: null as string | null,
    getNextPageParam: (lastPage: LogRow[]) =>
      lastPage.length < limit ? undefined : (lastPage[lastPage.length - 1]?.created_at ?? undefined),
    queryFn: ({ pageParam }) => fetchLogPage(limit, pageParam),
    // Wait for the customer-name lookup so a name search doesn't briefly show
    // only message/phone matches before the ids land.
    enabled: searchTerms.length === 0 || termCustomerIds !== undefined,
  });

  const rows = useMemo(() => (data?.pages ?? []).flat(), [data]);

  // Infinite scroll: the sentinel near the end of the list requests the next
  // keyset page, so older records stream in as the user scrolls instead of
  // requiring a tap. The "Load more" button stays as an explicit fallback.
  const loadMoreRef = useRef<HTMLSpanElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);



  // Reset scroll position whenever filters change so the user always starts
  // at the top of the newly-filtered result set and never sees pages from a
  // previous view mixed in below the fold.
  useEffect(() => {
    if (listRef.current) listRef.current.scrollTop = 0;
    lastAnnouncedIdRef.current = null;
  }, [scope, selectedTypes, searchKey, fromISO, toISO, statusRefreshOnly, failedOnly, originFilter, sortDir]);

  useEffect(() => {
    const node = loadMoreRef.current;
    if (!node || !hasNextPage || isFetchingNextPage) return;
    if (typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) void fetchNextPage();
      },
      { rootMargin: "200px" },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [hasNextPage, isFetchingNextPage, fetchNextPage, rows.length]);

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
          ? `Exported the first ${EXPORT_ROW_CAP} matching records in the current sort order.`
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

  // Once many keyset pages are appended, rendering every row hurts scroll
  // performance, so long lists switch to a windowed renderer that only mounts
  // the visible slice (plus a small overscan buffer).
  const isVirtualized = filtered.length > VIRTUALIZE_THRESHOLD;
  const virtualizer = useVirtualizer({
    count: isVirtualized ? filtered.length : 0,
    getScrollElement: () => listRef.current,
    estimateSize: () => 60,
    overscan: 10,
    getItemKey: (index: number) => filtered[index]?.id ?? index,
  });





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

  const SkeletonRow = () => (
    <div
      className="grid grid-cols-[auto_auto_1fr_auto] items-start gap-3 border-b border-border px-5 py-3"
      aria-hidden="true"
    >
      <span className="h-3.5 w-12 rounded bg-muted animate-pulse" />
      <span className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-muted animate-pulse" />
      <div className="space-y-1.5">
        <span className="block h-3.5 w-32 rounded bg-muted animate-pulse" />
        <span className="block h-3 w-48 rounded bg-muted animate-pulse" />
      </div>
      <span className="h-3 w-6 rounded bg-muted animate-pulse" />
    </div>
  );

  const ErrorRetry = () => (
    <div className="border-b border-border px-5 py-6" role="alert" aria-live="polite">
      <div className="flex flex-col items-center gap-3 text-center sm:flex-row sm:justify-between sm:text-left">
        <div className="space-y-1">
          <p className="text-sm font-medium text-foreground">Couldn’t load activity</p>
          <p className="text-xs text-muted-foreground">
            {logError ? friendlyLogRequestError(logError) : "Something went wrong. Pull to retry or tap the button."}
          </p>
        </div>
        <button
          type="button"
          onClick={() => void refetch()}
          disabled={isFetchingNextPage || isLoading}
          className="kb-focus inline-flex items-center gap-1.5 rounded-full border border-border bg-background px-3 py-1.5 text-xs uppercase tracking-wider text-foreground transition-colors hover:border-primary hover:text-primary disabled:opacity-60"
        >
          {isFetchingNextPage || isLoading ? "Retrying…" : "Retry"}
        </button>
      </div>
    </div>
  );

  /** One dispatch line; shared by the plain and virtualized render paths. */
  const RowBody = ({ row }: { row: LogRow }) => {
    const affected = parseAffected(row);
    const isCopied = copiedId === row.id;
    return (
      <div className="group grid grid-cols-[auto_auto_1fr_auto] items-start gap-3 px-5 py-3">
        <span className="text-muted-foreground">
          {new Date(row.created_at).toLocaleTimeString([], {
            hour: "2-digit",
            minute: "2-digit",
            second: "2-digit",
          })}
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
        <button
          type="button"
          aria-label={isCopied ? "Copied" : "Copy dispatch line"}
          title={isCopied ? "Copied" : "Copy dispatch line"}
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(formatDispatchLine(row));
              setCopiedId(row.id);
              toast.success("Dispatch line copied");
              window.setTimeout(() => setCopiedId((id) => (id === row.id ? null : id)), 1500);
            } catch {
              toast.error("Copy failed", { description: "Clipboard access was denied." });
            }
          }}
          className="kb-focus opacity-0 transition-opacity group-hover:opacity-100 focus:opacity-100 sm:opacity-100"
        >
          {isCopied ? (
            <span className="text-[10px] uppercase tracking-widest text-moss">Copied</span>
          ) : (
            <Copy size={12} className="text-muted-foreground hover:text-foreground" aria-hidden="true" />
          )}
        </button>
      </div>
    );
  };


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

      {(filterIssues.length > 0 || logError) && (
        <div
          data-testid="log-filter-errors"
          role="status"
          aria-live="polite"
          className="border-b border-border bg-destructive/10 px-5 py-3"
        >
          <div className="flex items-start gap-2.5">
            <AlertTriangle size={14} className="mt-0.5 shrink-0 text-destructive" aria-hidden="true" />
            <div className="min-w-0 flex-1">
              <p className="text-xs font-medium text-foreground">
                {logError ? "We couldn’t load these records" : "Some filters were adjusted"}
              </p>
              <ul className="mt-1 space-y-0.5 text-xs text-muted-foreground">
                {logError && <li>{friendlyLogRequestError(logError)}</li>}
                {filterIssues.map((issue) => (
                  <li key={`${issue.field}-${issue.message}`}>{issue.message}</li>
                ))}
              </ul>
            </div>
            <button
              type="button"
              onClick={resetFilters}
              className="kb-focus shrink-0 rounded-full bg-muted px-2.5 py-1 text-[10px] uppercase tracking-wider text-foreground hover:bg-muted/80"
            >
              Reset filters
            </button>
          </div>
        </div>
      )}

      <div className="border-b border-border px-5 py-3">
        <div className="flex flex-wrap items-center gap-4">
          <span className="mono flex items-center gap-1.5 text-[10px] uppercase tracking-widest text-muted-foreground">
            <Filter size={12} />
            Filter
          </span>

          {hasActiveFilters && (
            <button
              type="button"
              onClick={resetFilters}
              aria-label="Clear all filters and reset sort"
              title="Clear all filters and reset sort"
              className="kb-focus inline-flex items-center gap-1 rounded-full border border-border bg-background px-2 py-0.5 text-[10px] uppercase tracking-wider text-foreground transition-colors hover:border-primary hover:text-primary"
            >
              <X size={10} aria-hidden="true" />
              Clear filters
            </button>
          )}

          <div className="relative flex items-center">
            <Search size={12} className="pointer-events-none absolute left-2.5 text-muted-foreground" />
            <input
              type="search"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search name, phone, message…"
              aria-label="Search activity by phone number, customer name, or message text"
              aria-invalid={filterIssues.some((i) => i.field === "q") || undefined}
              maxLength={MAX_LOG_SEARCH_LENGTH + 20}
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

          <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Sort order">
            <span className="mono text-[10px] uppercase tracking-widest text-muted-foreground">Sort</span>
            {(["newest", "oldest"] as const).map((key) => {
              const active = sortDir === key;
              return (
                <button
                  key={key}
                  type="button"
                  aria-pressed={active}
                  onClick={() => setSortDir(key)}
                  title={key === "newest" ? "Newest entries first" : "Oldest entries first"}
                  className={`kb-focus inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-[10px] uppercase tracking-wider transition-colors ${
                    active
                      ? "bg-primary text-paper"
                      : "bg-muted text-muted-foreground hover:bg-muted/80 hover:text-foreground"
                  }`}
                >
                  {key === "newest" ? <ArrowDown size={11} aria-hidden="true" /> : <ArrowUp size={11} aria-hidden="true" />}
                  {key === "newest" ? "Newest first" : "Oldest first"}
                </button>
              );
            })}
          </div>



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


      <div
        ref={listRef}
        role="list"
        className="mono max-h-[520px] divide-y divide-border overflow-y-auto text-xs"
      >
        {isLoading && (
          <>
            <SkeletonRow key="s1" />
            <SkeletonRow key="s2" />
            <SkeletonRow key="s3" />
            <SkeletonRow key="s4" />
            <SkeletonRow key="s5" />
          </>
        )}
        {!isLoading && logError && filtered.length === 0 && <ErrorRetry />}
        {!isLoading && !logError && filtered.length === 0 && (
          <div role="listitem" className="p-5 text-muted-foreground">
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
          </div>
        )}

        {/* Small lists render in full; long ones (many appended pages) switch to
            windowed rendering so scrolling stays smooth no matter how many
            keyset pages have been loaded. */}
        {isVirtualized ? (
          <div className="relative w-full" style={{ height: virtualizer.getTotalSize() }}>
            {virtualizer.getVirtualItems().map((item) => {
              const row = filtered[item.index];
              if (!row) return null;
              return (
                <div
                  key={item.key}
                  role="listitem"
                  data-index={item.index}
                  ref={virtualizer.measureElement}
                  className="absolute left-0 top-0 w-full border-b border-border"
                  style={{ transform: `translateY(${item.start}px)` }}
                >
                  <RowBody row={row} />
                </div>
              );
            })}
          </div>
        ) : (
          filtered.map((row) => (
            <div key={row.id} role="listitem" className="w-full">
              <RowBody row={row} />
            </div>
          ))
        )}
        {!isLoading && logError && filtered.length > 0 && <ErrorRetry />}
        {isFetchingNextPage && (
          <>
            <SkeletonRow key="s-more-1" />
            <SkeletonRow key="s-more-2" />
          </>
        )}
      </div>


      {filtered.length > 0 && (
        <div className="flex items-center justify-between gap-3 border-t border-border px-5 py-3">
          <span className="mono text-[10px] uppercase tracking-widest text-muted-foreground">
            {filtered.length} loaded
          </span>
          {hasNextPage ? (
            <>
              {/* Sentinel: scrolling it into view pulls the next keyset page. */}
              <span ref={loadMoreRef} aria-hidden="true" className="sr-only" />
              <button
                type="button"
                onClick={() => void fetchNextPage()}
                disabled={isFetchingNextPage}
                className="kb-focus rounded-full border border-border px-3 py-1 text-[10px] uppercase tracking-widest text-foreground transition-colors hover:border-primary hover:text-primary disabled:opacity-60"
              >
                {isFetchingNextPage ? "Loading…" : `Load ${limit} ${sortDir === "oldest" ? "newer" : "older"}`}
              </button>
            </>
          ) : (
            <span className="mono flex items-center gap-1.5 text-[10px] uppercase tracking-widest text-muted-foreground">
              <span className="h-1.5 w-1.5 rounded-full bg-muted-foreground/60" aria-hidden="true" />
              No more {sortDir === "oldest" ? "newer" : "older"} actions
            </span>
          )}
        </div>
      )}

    </div>

  );
}
