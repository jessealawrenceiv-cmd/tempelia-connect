import { useInfiniteQuery, useQuery, useQueryClient, type InfiniteData } from "@tanstack/react-query";
import { useVirtualizer } from "@tanstack/react-virtual";
import { Link, useNavigate, useSearch } from "@tanstack/react-router";
import { reportFilterRejection } from "@/lib/activity-log-validation.reporter";
import { supabase } from "@/integrations/supabase/client";
import type { ExportContact, ExportContactLookup } from "@/lib/activity-log-csv";
import { useEffect, useMemo, useRef, useState } from "react";
import { endOfDay, startOfDay } from "date-fns";
import { AlertTriangle, ArrowDown, ArrowUp, Bookmark, BookmarkPlus, ChevronRight, Copy, Download, Filter, RefreshCw, Search, Sparkles, X } from "lucide-react";
import { DispatchLogRowDetails } from "@/components/DispatchLogRowDetails";
import { toast } from "sonner";
import { DateRangePicker, type DateRangeValue } from "@/components/DateRangePicker";
import { JumpToDatePicker } from "@/components/JumpToDatePicker";
import {
  EXPORT_ROW_CAP,
  buildLogCsv,
  downloadCsv,
  type FilterableQuery,
} from "@/lib/activity-log-csv";
import { LogAction, type LogActionType } from "@/lib/log-action-types";
import { parseLogRowsResponse } from "@/lib/log-action-types.schema";
import { logActionFilterValue, logActionFilterValues, pickLogActionTypes } from "@/lib/log-action-query";
import { phoneDigits } from "@/lib/phone";
import {
  MAX_LOG_PRESETS,
  readStoredPresets,
  summarizePreset,
  writeStoredPresets,
  type LogFilterPreset,
} from "@/lib/activity-log-presets";
import {
  MAX_LOG_SEARCH_LENGTH,
  describeLogRequestError,
  friendlyLogRequestError,
  hasBlockingFilterIssues,
  validateActivityLogFilters,
  type ActivityLogFilterIssue,
} from "@/lib/activity-log-filters.schema";


import {
  LOG_ACTION_FILTER_ORDER,
  availableLogActionOptions,
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
  recipient_phone: string | null;
  twilio_message_sid: string | null;
  voicemail_url: string | null;
  recording_sid: string | null;
  call_sid: string | null;
  prompt_template: string | null;
  prompt_template_hash: string | null;
  prompt_cooldown_minutes: number | null;
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

function readStoredTypes(): { valid: LogActionType[]; invalid: string[] } {
  if (typeof window === "undefined") return { valid: [], invalid: [] };
  try {
    const raw = window.localStorage.getItem(LOG_TYPES_STORAGE_KEY);
    if (!raw) return { valid: [], invalid: [] };
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return { valid: [], invalid: [] };
    // Stored values are untrusted too (older build, hand-edited storage).
    return pickLogActionTypes(parsed);
  } catch {
    return { valid: [], invalid: [] };
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

/** Auto-refresh: 0 = off. Persisted so the choice survives reloads. */
const LOG_AUTO_REFRESH_STORAGE_KEY = "temaro-activity-log-auto-refresh";
const AUTO_REFRESH_OPTIONS = [0, 15, 30, 60] as const;
type AutoRefreshSeconds = (typeof AUTO_REFRESH_OPTIONS)[number];

function readStoredAutoRefresh(): AutoRefreshSeconds {
  if (typeof window === "undefined") return 0;
  try {
    const raw = Number(window.localStorage.getItem(LOG_AUTO_REFRESH_STORAGE_KEY));
    return (AUTO_REFRESH_OPTIONS as readonly number[]).includes(raw) ? (raw as AutoRefreshSeconds) : 0;
  } catch {
    return 0;
  }
}


/** Parses a ?dateFrom=/?dateTo= day string (yyyy-MM-dd) into a local Date. */
function parseDayParam(value: unknown): Date | undefined {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return undefined;
  const [y, m, d] = value.split("-").map(Number) as [number, number, number];
  const date = new Date(y, m - 1, d);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

/** Matches a customer id pasted into the contact filter. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Serialises a Date to the yyyy-MM-dd form used in the URL. */
function toDayParam(date: Date): string {
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${m}-${d}`;
}

/**
 * Placeholder row shown while a page of activity loads. Defined at module
 * scope so it keeps a stable component identity across renders.
 */
function SkeletonRow() {
  return (
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
}

/**
 * Inline alert for a failed logs request (including the HTTP 400 raised by the
 * `logs_action_type_check` constraint). Lives at module scope on purpose: when
 * it was declared inside DispatchLog, every render produced a brand-new
 * component type, React remounted the whole alert, and the freshly-rendered
 * "Clear filters" button could be detached from the tree before a click
 * landed — so clearing filters silently did nothing.
 */
function LogErrorRetry({
  logError,
  hasActiveFilters,
  filtersBlocked,
  busy,
  onClearFilters,
  onRetry,
}: {
  logError: unknown;
  hasActiveFilters: boolean;
  filtersBlocked: boolean;
  busy: boolean;
  onClearFilters: () => void;
  onRetry: () => void;
}) {
  const info = logError ? describeLogRequestError(logError) : null;
  return (
    <div className="border-b border-border px-5 py-6" role="alert" aria-live="polite">
      <div className="flex flex-col items-start gap-3 sm:flex-row sm:justify-between">
        <div className="space-y-1">
          <p className="text-sm font-medium text-foreground">{info?.title ?? "Couldn’t load activity"}</p>
          <p className="text-xs text-muted-foreground">
            {info?.message ?? "Something went wrong. Pull to retry or tap the button."}
          </p>
          {info?.allowedTypes && (
            <p className="mono text-[10px] uppercase tracking-wider text-muted-foreground">
              Allowed: {info.allowedTypes.join(", ")}
            </p>
          )}
          {info?.technicalDetail && (
            <details className="pt-1">
              <summary className="kb-focus cursor-pointer text-[10px] uppercase tracking-wider text-muted-foreground">
                Technical details{info.status ? ` (HTTP ${info.status})` : ""}
              </summary>
              <p className="mono mt-1 break-words text-[10px] leading-relaxed text-muted-foreground">
                {info.technicalDetail}
              </p>
            </details>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {info?.suggestClearFilters && hasActiveFilters && (
            <button
              type="button"
              onClick={onClearFilters}
              data-testid="log-error-clear-filters"
              className="kb-focus inline-flex items-center gap-1.5 rounded-full border border-border bg-background px-3 py-1.5 text-xs uppercase tracking-wider text-foreground transition-colors hover:border-primary hover:text-primary"
            >
              Clear filters
            </button>
          )}
          <button
            type="button"
            onClick={onRetry}
            disabled={busy || filtersBlocked}
            className="kb-focus inline-flex items-center gap-1.5 rounded-full border border-border bg-background px-3 py-1.5 text-xs uppercase tracking-wider text-foreground transition-colors hover:border-primary hover:text-primary disabled:opacity-60"
          >
            {busy ? "Retrying…" : "Retry"}
          </button>
        </div>
      </div>
    </div>
  );
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
    logCustomer?: unknown;
    logScope?: unknown;
    logStatusOnly?: unknown;
    logFailed?: unknown;
    logOrigin?: unknown;
  };

  /**
   * The toggle-style filters (scope, status-refresh only, failures only, origin)
   * also live in the URL so a copied link reproduces the exact same view. Each
   * setter writes the param and the value is derived straight back from it —
   * there is no local mirror to drift out of sync.
   */
  const setSearchParam = (key: string, value: string | undefined) => {
    void navigate({
      to: ".",
      search: (prev: Record<string, unknown>) => ({ ...prev, [key]: value }),
      resetScroll: false,
    });
  };
  type OriginFilter = "all" | "active" | "this-device" | "other-device" | "backend";
  const ORIGIN_FILTERS: OriginFilter[] = ["all", "active", "this-device", "other-device", "backend"];
  const statusRefreshOnly = rawSearch.logStatusOnly === "1";
  const failedOnly = rawSearch.logFailed === "1";
  const originFilter: OriginFilter = ORIGIN_FILTERS.includes(rawSearch.logOrigin as OriginFilter)
    ? (rawSearch.logOrigin as OriginFilter)
    : "all";
  const scope: "live" | "archive" = rawSearch.logScope === "archive" ? "archive" : "live";
  const setStatusRefreshOnly = (next: boolean) => setSearchParam("logStatusOnly", next ? "1" : undefined);
  const setFailedOnly = (next: boolean) => setSearchParam("logFailed", next ? "1" : undefined);
  const setOriginFilter = (next: OriginFilter) => setSearchParam("logOrigin", next === "all" ? undefined : next);
  const setScope = (next: "live" | "archive") => setSearchParam("logScope", next === "archive" ? "archive" : undefined);

  // Auto-refresh polls the live log on an interval so newly captured automated
  // actions appear without a page reload. Paused in the archive scope and while
  // the tab is hidden so a backgrounded phone isn't quietly polling.
  const [autoRefreshSeconds, setAutoRefreshSeconds] = useState<AutoRefreshSeconds>(0);
  useEffect(() => setAutoRefreshSeconds(readStoredAutoRefresh()), []);

  // Saved filter combinations ("presets"): per-device shortcuts for the views the
  // user keeps coming back to. Loaded after mount so SSR markup stays stable.
  const [presets, setPresets] = useState<LogFilterPreset[]>([]);
  const [presetName, setPresetName] = useState("");
  const [showSavePreset, setShowSavePreset] = useState(false);
  useEffect(() => setPresets(readStoredPresets()), []);


  // The input stays local for responsive typing and is mirrored into ?q= (see below).
  const [searchQuery, setSearchQuery] = useState(typeof rawSearch.q === "string" ? rawSearch.q : "");
  // Contact filter: an exact customer id (uuid) or a phone number. Mirrored into
  // ?logCustomer= the same way as the free-text search.
  const urlCustomer = typeof rawSearch.logCustomer === "string" ? rawSearch.logCustomer : "";
  const [customerInput, setCustomerInput] = useState(urlCustomer);

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
  // Rows the user has expanded to see the full dispatch payload.
  const [expandedIds, setExpandedIds] = useState<string[]>([]);
  const toggleExpanded = (id: string) =>
    setExpandedIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
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
  /**
   * Client-side prevalidation: when a filter value can't be corrected (search
   * too long, inverted date range) we never send the request. The same friendly
   * messages render immediately from the Zod issues below.
   */
  const filtersBlocked = hasBlockingFilterIssues(filterIssues);

  /**
   * Ship every rejected/adjusted filter payload to the server so bad links can
   * be traced. De-duplicated inside the reporter; fire-and-forget.
   */
  useEffect(() => {
    if (filterIssues.length === 0) return;
    reportFilterRejection({
      source: "log_list",
      blocked: filtersBlocked,
      issues: filterIssues,
      rawFilters: {
        logTypes: typeof rawLogTypes === "string" ? rawLogTypes : null,
        logSort: (rawSearch.logSort as string | undefined) ?? null,
        q: searchQuery,
        dateFrom: dateRange?.from ? dateRange.from.toISOString() : null,
        dateTo: dateRange?.to ? dateRange.to.toISOString() : null,
        scope,
      },
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filterIssues, filtersBlocked]);

  /**
   * An invalid action_type is dropped before the request goes out. That used to
   * be silent (the banner is below the fold on mobile), so also toast it once
   * per distinct set of rejected values.
   */
  const logTypeIssue = filterIssues.find((i) => i.field === "logTypes")?.message;
  const toastedLogTypeIssueRef = useRef<string | null>(null);
  useEffect(() => {
    if (!logTypeIssue) {
      toastedLogTypeIssueRef.current = null;
      return;
    }
    if (toastedLogTypeIssueRef.current === logTypeIssue) return;
    toastedLogTypeIssueRef.current = logTypeIssue;
    toast.error("Record type filter ignored", { description: logTypeIssue });
  }, [logTypeIssue]);

  /**
   * Field-level helper text: the summary banner above says "some filters were
   * adjusted", but each control also needs to say what went wrong right where
   * the user can fix it. Keyed by the Zod issue's field.
   */
  const issueFor = (field: ActivityLogFilterIssue["field"]): string | undefined =>
    filterIssues.find((i) => i.field === field)?.message;
  const helpId = (field: ActivityLogFilterIssue["field"]) => `log-filter-help-${field}`;
  const FieldHelp = ({ field }: { field: ActivityLogFilterIssue["field"] }) => {
    const message = issueFor(field);
    if (!message) return null;
    return (
      <p
        id={helpId(field)}
        data-testid={`log-filter-help-${field}`}
        className="mt-1 flex items-start gap-1 text-[10px] leading-snug text-orange"
      >
        <AlertTriangle size={10} className="mt-[1px] shrink-0" aria-hidden="true" />
        <span>{message}</span>
      </p>
    );
  };
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
    setSearchQuery("");
    setCustomerInput("");
    writeStoredTypes([]);
    void navigate({
      to: ".",
      search: (prev: Record<string, unknown>) => ({
        ...prev,
        logTypes: undefined,
        logSort: undefined,
        q: undefined,
        dateFrom: undefined,
        dateTo: undefined,
        logCustomer: undefined,
        logStatusOnly: undefined,
        logFailed: undefined,
        logOrigin: undefined,
      }),
      resetScroll: false,
    });
    // The query key changes with the filters, but re-run explicitly so a failed
    // request (e.g. the 400 from logs_action_type_check) is retried immediately
    // instead of leaving the error alert on screen.
    void refetch();
  };



  /** Captures the current filter bar as a named preset. */
  const savePreset = () => {
    const name = presetName.trim().slice(0, 40);
    if (!name) return;
    const next: LogFilterPreset = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      name,
      scope,
      types: selectedTypes,
      sort: sortDir,
      q: searchQuery.trim(),
      customer: customerInput.trim(),
      ...(dateRange?.from ? { dateFrom: toDayParam(dateRange.from) } : {}),
      ...(dateRange?.from && dateRange.to ? { dateTo: toDayParam(dateRange.to) } : {}),
      statusRefreshOnly,
      failedOnly,
      origin: originFilter,
    };
    // Saving under an existing name overwrites it instead of piling up duplicates.
    const others = presets.filter((p) => p.name.toLowerCase() !== name.toLowerCase());
    const updated = [next, ...others].slice(0, MAX_LOG_PRESETS);
    setPresets(updated);
    writeStoredPresets(updated);
    setPresetName("");
    setShowSavePreset(false);
    setAnnouncement(`Saved filter view “${name}”`);
  };

  /** Reapplies every field a preset captured, clearing anything it didn't. */
  const applyPreset = (preset: LogFilterPreset) => {
    setSearchQuery(preset.q);
    setCustomerInput(preset.customer);
    writeStoredTypes(preset.types);
    void navigate({
      to: ".",
      search: (prev: Record<string, unknown>) => ({
        ...prev,
        logTypes: preset.types.length > 0 ? preset.types.join(",") : undefined,
        logSort: preset.sort === "oldest" ? "oldest" : undefined,
        q: preset.q || undefined,
        dateFrom: preset.dateFrom ?? undefined,
        dateTo: preset.dateTo ?? undefined,
        logCustomer: preset.customer || undefined,
        logScope: preset.scope === "archive" ? "archive" : undefined,
        logStatusOnly: preset.statusRefreshOnly ? "1" : undefined,
        logFailed: preset.failedOnly ? "1" : undefined,
        logOrigin: preset.origin === "all" ? undefined : preset.origin,
      }),
      resetScroll: false,
    });
    setAnnouncement(`Applied filter view “${preset.name}”`);
  };


  const deletePreset = (preset: LogFilterPreset) => {
    const updated = presets.filter((p) => p.id !== preset.id);
    setPresets(updated);
    writeStoredPresets(updated);
    setAnnouncement(`Removed filter view “${preset.name}”`);
  };


  // Mirror the contact filter into ?logCustomer= so a "just this contact" view is
  // shareable. Debounced and history-replacing, like the free-text search.
  useEffect(() => {
    if (customerInput === urlCustomer) return;
    const id = window.setTimeout(() => {
      void navigate({
        to: ".",
        search: (prev: Record<string, unknown>) => ({
          ...prev,
          logCustomer: customerInput.trim() === "" ? undefined : customerInput.trim(),
        }),
        replace: true,
        resetScroll: false,
      });
    }, 250);
    return () => window.clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [customerInput, urlCustomer]);

  // Keep the contact input in step with back/forward navigation.
  useEffect(() => {
    setCustomerInput((prev) => (prev === urlCustomer ? prev : urlCustomer));
  }, [urlCustomer]);

  // Mirror the search box into ?q= so the view is shareable and survives a
  // reload. Debounced and history-replacing so typing doesn't spam the stack.
  const urlQ = typeof rawSearch.q === "string" ? rawSearch.q : "";
  useEffect(() => {
    if (searchQuery === urlQ) return;
    const id = window.setTimeout(() => {
      void navigate({
        to: ".",
        search: (prev: Record<string, unknown>) => ({
          ...prev,
          q: searchQuery.trim() === "" ? undefined : searchQuery,
        }),
        replace: true,
        resetScroll: false,
      });
    }, 250);
    return () => window.clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchQuery, urlQ]);

  // Keep the input in step when the URL changes underneath it (back/forward).
  useEffect(() => {
    setSearchQuery((prev) => (prev === urlQ ? prev : urlQ));
  }, [urlQ]);


  // Restore the last-used action-type filters from localStorage when the URL
  // does not already specify ?logTypes=. URL params always win.
  useEffect(() => {
    if (rawLogTypes != null) return;
    const stored = readStoredTypes();
    // Values we had to drop are surfaced instead of disappearing quietly.
    if (stored.invalid.length > 0) {
      toast.error(
        stored.invalid.length === 1
          ? "A saved record-type filter is no longer valid"
          : "Some saved record-type filters are no longer valid",
        {
          description: `Ignored: ${stored.invalid.join(", ")}.${
            stored.valid.length > 0 ? ` Still filtering by ${stored.valid.map((t) => typeLabel(t)).join(", ")}.` : " Showing all record types."
          }`,
        },
      );
      writeStoredTypes(stored.valid);
    }
    if (stored.valid.length > 0) {
      void navigate({
        to: ".",
        search: (prev: Record<string, unknown>) => ({ ...prev, logTypes: stored.valid.join(",") }),
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

  // A contact filter is either an exact customer id or a phone number. Phone
  // input is reduced to its last 10 digits so "(415) 555-0777", "4155550777",
  // and "+14155550777" all narrow to the same contact.
  const customerFilter = urlCustomer.trim().slice(0, 64);
  const customerFilterIsId = UUID_RE.test(customerFilter);
  const customerFilterDigits = customerFilterIsId ? "" : phoneDigits(customerFilter).slice(-10);
  const hasPhoneFilter = customerFilterDigits.length >= 4;
  const customerFilterActive = customerFilterIsId || hasPhoneFilter;
  const customerFilterInvalid = customerFilter.length > 0 && !customerFilterActive;

  // Phone numbers live on `customers`, so resolve the phone to customer ids and
  // fold them into the log query alongside the logged recipient_phone.
  const { data: phoneCustomerIds } = useQuery({
    queryKey: ["log-customer-phone", customerFilterDigits],
    enabled: hasPhoneFilter && !filtersBlocked,
    staleTime: 30_000,
    queryFn: async (): Promise<string[]> => {
      const { data, error } = await supabase
        .from("customers")
        .select(sel("id"))
        .ilike("phone_number", `%${customerFilterDigits}%`)
        .limit(300)
        .returns<{ id: string }[]>();
      if (error) throw error;
      return (data ?? []).map((r) => r.id);
    },
  });
  const phoneCustomerKey = hasPhoneFilter ? (phoneCustomerIds ?? []).join(",") : "";

  const hasActiveFilters =
    selectedTypes.length > 0 ||
    searchQuery.trim().length > 0 ||
    statusRefreshOnly ||
    failedOnly ||
    originFilter !== "all" ||
    dateRange?.from != null ||
    customerFilter.length > 0 ||
    sortDir === "oldest";

  // A search term can also be a customer's name or phone number. Names live on
  // `customers`, not `logs`, so resolve each term to matching customer ids first
  // and fold those ids into that term's Postgres OR clause.
  const { data: termCustomerIds } = useQuery({
    queryKey: ["log-search-customers", searchKey],
    enabled: searchTerms.length > 0 && !filtersBlocked,
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
      out = out.eq("action_type", logActionFilterValue(LogAction.automation_status_change));
      if (originFilter !== "active") out = out.eq("status", originFilter);
    } else {
      if (statusRefreshOnly) out = out.eq("action_type", logActionFilterValue(LogAction.status_refresh));
      if (failedOnly)
        out = out.eq("action_type", logActionFilterValue(LogAction.status_refresh)).eq("status", "failed");
      if (selectedTypes.length > 0) out = out.in("action_type", logActionFilterValues(selectedTypes));
    }

    // Contact filter: an exact customer id, or any record tied to that phone
    // number (either through the customer record or the logged recipient).
    if (customerFilterIsId) {
      out = out.eq("customer_id", customerFilter);
    } else if (hasPhoneFilter) {
      const clauses = [`recipient_phone.ilike.%${customerFilterDigits}%`];
      const ids = phoneCustomerIds ?? [];
      if (ids.length > 0) clauses.push(`customer_id.in.(${ids.join(",")})`);
      out = out.or(clauses.join(","));
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
      .select(
        sel(
          `id, action_type, message_sent, ${timeCol}, status, customer_id, recipient_phone, twilio_message_sid, voicemail_url, recording_sid, call_sid, prompt_template, prompt_template_hash, prompt_cooldown_minutes`,
        ),
      )
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
      recipient_phone: r.recipient_phone ?? null,
      twilio_message_sid: r.twilio_message_sid ?? null,
      voicemail_url: r.voicemail_url ?? null,
      recording_sid: r.recording_sid ?? null,
      call_sid: r.call_sid ?? null,
      prompt_template: r.prompt_template ?? null,
      prompt_template_hash: r.prompt_template_hash ?? null,
      prompt_cooldown_minutes: r.prompt_cooldown_minutes ?? null,
    }));


  };

  // Re-fetch a single record through the exact same filter chain. Used by the
  // live subscription so a streamed insert is only prepended when it genuinely
  // belongs in the current view (and is readable under RLS).
  const fetchLogRowById = async (id: string): Promise<LogRow | null> => {
    const base = supabase
      .from("logs")
      .select(
        sel(
          `id, action_type, message_sent, created_at, status, customer_id, recipient_phone, twilio_message_sid, voicemail_url, recording_sid, call_sid, prompt_template, prompt_template_hash, prompt_cooldown_minutes`,
        ),
      )
      .eq("id", id)
      .limit(1);
    const q = applyFilters(base as unknown as FilterableQuery, "created_at", null);
    const { data: rows, error } = await (q as unknown as typeof base).returns<RawLogRow[]>();
    if (error) throw error;
    const parsed = parseLogRowsResponse(rows ?? []);
    const r = parsed.rows[0];
    if (!r) return null;
    return {
      id: r.id,
      action_type: r.action_type,
      message_sent: r.message_sent,
      created_at: (r.created_at ?? r.original_created_at) as string,
      status: r.status,
      customer_id: r.customer_id,
      recipient_phone: r.recipient_phone ?? null,
      twilio_message_sid: r.twilio_message_sid ?? null,
      voicemail_url: r.voicemail_url ?? null,
      recording_sid: r.recording_sid ?? null,
      call_sid: r.call_sid ?? null,
      prompt_template: r.prompt_template ?? null,
      prompt_template_hash: r.prompt_template_hash ?? null,
      prompt_cooldown_minutes: r.prompt_cooldown_minutes ?? null,
    };
  };

  const logsQueryKey = useMemo(
    () => [
      "logs",
      scope,
      limit,
      fromISO,
      toISO,
      typeKey,
      searchKey,
      customerMatchKey,
      customerFilter,
      phoneCustomerKey,
      statusRefreshOnly,
      failedOnly,
      originFilter,
      sortDir,
    ],
    [
      scope,
      limit,
      fromISO,
      toISO,
      typeKey,
      searchKey,
      customerMatchKey,
      customerFilter,
      phoneCustomerKey,
      statusRefreshOnly,
      failedOnly,
      originFilter,
      sortDir,
    ],
  );

  // Server-side keyset pagination: only one small page ships over mobile data.
  const {
    data,
    isLoading,
    error: logError,
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage,
    isFetching,
    dataUpdatedAt,
    refetch,

  } = useInfiniteQuery({
    queryKey: logsQueryKey,
    initialPageParam: null as string | null,
    getNextPageParam: (lastPage: LogRow[]) =>
      lastPage.length < limit ? undefined : (lastPage[lastPage.length - 1]?.created_at ?? undefined),
    queryFn: ({ pageParam }) => fetchLogPage(limit, pageParam),
    // Wait for the customer-name lookup so a name search doesn't briefly show
    // only message/phone matches before the ids land.
    enabled:
      !filtersBlocked &&
      (searchTerms.length === 0 || termCustomerIds !== undefined) &&
      (!hasPhoneFilter || phoneCustomerIds !== undefined),
  });


  const rows = useMemo(() => (data?.pages ?? []).flat(), [data]);

  // Poll on the chosen interval. A tick is skipped while another fetch is in
  // flight (including "Load more") so slow connections never stack requests.
  useEffect(() => {
    if (autoRefreshSeconds === 0 || scope !== "live" || filtersBlocked) return;
    if (typeof window === "undefined") return;
    const tick = () => {
      if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
      if (isFetching || isFetchingNextPage) return;
      void refetch();
    };
    const id = window.setInterval(tick, autoRefreshSeconds * 1000);
    const onVisible = () => {
      if (document.visibilityState === "visible") tick();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.clearInterval(id);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [autoRefreshSeconds, scope, isFetching, isFetchingNextPage, refetch]);

  // Live updates: new dispatch rows written by the server stream in over
  // Realtime and are prepended to the top page instead of waiting for a poll.
  // Each insert is re-read through the active filter chain so only records that
  // belong in the current view (and are readable under RLS) are added, and
  // newest-first is required so "prepend" is actually correct.
  const queryClient = useQueryClient();
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (scope !== "live" || sortDir !== "newest" || filtersBlocked) return;
    // Realtime is optional: environments (and tests) without a channel-capable
    // client simply fall back to polling.
    if (typeof supabase.channel !== "function") return;

    let cancelled = false;
    const channel = supabase
      .channel("dispatch-log-live")
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "logs" },
        (payload) => {
          const id = (payload.new as { id?: string } | null)?.id;
          if (!id) return;
          void (async () => {
            try {
              const row = await fetchLogRowById(id);
              if (!row || cancelled) return;
              queryClient.setQueryData<InfiniteData<LogRow[], string | null>>(
                logsQueryKey,
                (prev) => {
                  if (!prev || prev.pages.length === 0) return prev;
                  if (prev.pages.some((page) => page.some((r) => r.id === row.id))) return prev;
                  const pages = prev.pages.slice();
                  pages[0] = [row, ...(pages[0] ?? [])];
                  return { ...prev, pages };
                },
              );
            } catch {
              // A transient failure just means this row shows up on the next poll.
            }
          })();
        },
      )
      .subscribe();

    return () => {
      cancelled = true;
      void supabase.removeChannel(channel);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scope, sortDir, filtersBlocked, logsQueryKey, queryClient]);



  const updatedLabel = useMemo(
    () =>
      dataUpdatedAt
        ? new Date(dataUpdatedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
        : null,
    [dataUpdatedAt],
  );


  // Infinite scroll: the sentinel near the end of the list requests the next
  // keyset page, so older records stream in as the user scrolls instead of
  // requiring a tap. The "Load more" button stays as an explicit fallback.
  const loadMoreRef = useRef<HTMLSpanElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);

  /**
   * Accessibility for validation errors: the banner is a focusable alert. When a
   * new problem appears we move focus to it (so keyboard and screen-reader users
   * land on the explanation instead of hunting for it) and announce a summary in
   * the live region. Focus only moves when the message actually changes, so
   * typing in a filter field is never interrupted twice for the same error.
   */
  const errorBannerRef = useRef<HTMLDivElement | null>(null);
  const lastErrorSignatureRef = useRef<string | null>(null);
  const bannerVisible = filterIssues.length > 0 || Boolean(logError);
  const errorSignature = bannerVisible
    ? [logError ? friendlyLogRequestError(logError) : "", ...filterIssues.map((i) => `${i.field}:${i.message}`)].join("|")
    : null;

  useEffect(() => {
    if (!errorSignature) {
      lastErrorSignatureRef.current = null;
      return;
    }
    if (lastErrorSignatureRef.current === errorSignature) return;
    lastErrorSignatureRef.current = errorSignature;

    const count = filterIssues.length + (logError ? 1 : 0);
    const heading = logError
      ? "We couldn’t load these records"
      : filtersBlocked
        ? "Fix these filters to load records"
        : "Some filters were adjusted";
    setAnnouncement(`${heading}. ${count} ${count === 1 ? "issue" : "issues"}.`);

    // Only pull focus for problems that stop the request; advisory adjustments
    // are announced but must not steal focus mid-typing.
    if (logError || filtersBlocked) {
      errorBannerRef.current?.focus();
    }
  }, [errorSignature, filtersBlocked, filterIssues.length, logError]);





  // Reset scroll position whenever filters change so the user always starts
  // at the top of the newly-filtered result set and never sees pages from a
  // previous view mixed in below the fold.
  useEffect(() => {
    if (listRef.current) listRef.current.scrollTop = 0;
    lastAnnouncedIdRef.current = null;
  }, [
    scope,
    selectedTypes,
    searchKey,
    customerFilter,
    fromISO,
    toISO,
    statusRefreshOnly,
    failedOnly,
    originFilter,
    sortDir,
  ]);

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
  /**
   * Looks up first name + phone for every contact referenced by the rows being
   * exported. Batched because an export can span thousands of records; a failed
   * lookup degrades to an empty map rather than blocking the download.
   */
  const fetchExportContacts = async (
    exportRows: readonly LogRow[],
  ): Promise<ExportContactLookup> => {
    const ids = [...new Set(exportRows.map((r) => r.customer_id).filter((id): id is string => !!id))];
    const map = new Map<string, ExportContact>();
    if (ids.length === 0) return map;
    const CHUNK = 200;
    try {
      for (let i = 0; i < ids.length; i += CHUNK) {
        const { data, error } = await supabase
          .from("customers")
          .select("id, first_name, phone_number")
          .in("id", ids.slice(i, i + CHUNK));
        if (error) throw error;
        for (const c of data ?? []) {
          map.set(c.id, { first_name: c.first_name, phone_number: c.phone_number });
        }
      }
    } catch (err) {
      console.warn("[activity-log] contact lookup for export failed", err);
    }
    return map;
  };

  const exportCsv = async () => {
    setIsExporting(true);
    try {
      const all = await fetchLogPage(EXPORT_ROW_CAP, null);
      if (all.length === 0) {
        toast.info("Nothing to export for the current filters.");
        return;
      }
      // Resolve the contacts these records point at so the file answers
      // "who was texted?" instead of just showing an opaque customer id.
      const contacts = await fetchExportContacts(all);
      downloadCsv(buildLogCsv(all, contacts), scope);
      toast.success(
        all.length === EXPORT_ROW_CAP
          ? `Exported the first ${EXPORT_ROW_CAP} matching records in the current sort order.`
          : `Exported ${all.length} record${all.length === 1 ? "" : "s"}.`,
      );
    } catch (err) {
      // Same treatment as the list view: a 400 from logs_action_type_check gets
      // the friendly headline plus the exact constraint text, not a raw dump.
      const info = describeLogRequestError(err);
      toast.error(info.isActionTypeCheck ? info.title : "Export failed", {
        description: [
          info.message,
          info.technicalDetail ? `${info.status ? `HTTP ${info.status}: ` : ""}${info.technicalDetail}` : null,
        ]
          .filter(Boolean)
          .join(" "),
      });
    } finally {
      setIsExporting(false);
    }
  };

  const typeCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const row of rows) counts[row.action_type] = (counts[row.action_type] ?? 0) + 1;
    return counts;
  }, [rows]);


  // Enum-derived options for the record-type picker, minus what is already on.
  const typePickerOptions = availableLogActionOptions(selectedTypes);

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

  // Rendered inline (not via a locally-declared component) so the alert keeps a
  // stable identity across renders and its buttons stay attached to the DOM.
  const errorRetryPanel = (
    <LogErrorRetry
      logError={logError}
      hasActiveFilters={hasActiveFilters}
      filtersBlocked={filtersBlocked}
      busy={isFetchingNextPage || isLoading}
      onClearFilters={resetFilters}
      onRetry={() => {
        if (filtersBlocked) return;
        void refetch();
      }}
    />
  );


  /** One dispatch line; shared by the plain and virtualized render paths. */
  const RowBody = ({ row }: { row: LogRow }) => {
    const affected = parseAffected(row);
    const isCopied = copiedId === row.id;
    const isExpanded = expandedIds.includes(row.id);
    return (
      <div>
      <div className="group grid grid-cols-[auto_auto_auto_1fr_auto] items-start gap-3 px-5 py-3">
        <button
          type="button"
          aria-expanded={isExpanded}
          aria-controls={`log-details-${row.id}`}
          aria-label={isExpanded ? "Hide dispatch details" : "Show dispatch details"}
          title={isExpanded ? "Hide details" : "Show details"}
          onClick={() => toggleExpanded(row.id)}
          className="kb-focus mt-0.5 rounded text-muted-foreground transition-colors hover:text-foreground"
        >
          <ChevronRight
            size={13}
            aria-hidden="true"
            className={`transition-transform ${isExpanded ? "rotate-90" : ""}`}
          />
        </button>
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
      {isExpanded && (
        <div id={`log-details-${row.id}`}>
          <DispatchLogRowDetails row={row} />
        </div>
      )}
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
            <>
              <span className="mono flex items-center gap-1.5 text-[10px] uppercase tracking-widest text-moss">
                <span className="h-2 w-2 animate-pulse rounded-full bg-moss" />
                Live
              </span>
              <label className="mono flex items-center gap-1.5 text-[10px] uppercase tracking-widest text-muted-foreground">
                Auto-refresh
                <select
                  data-testid="log-auto-refresh"
                  value={autoRefreshSeconds}
                  onChange={(e) => {
                    const next = Number(e.target.value) as AutoRefreshSeconds;
                    setAutoRefreshSeconds(next);
                    try {
                      window.localStorage.setItem(LOG_AUTO_REFRESH_STORAGE_KEY, String(next));
                    } catch {
                      // best-effort persistence
                    }
                    setAnnouncement(
                      next === 0
                        ? "Activity auto-refresh off"
                        : `Activity auto-refresh every ${next} seconds`,
                    );
                  }}
                  aria-label="Auto-refresh the activity log"
                  className="kb-focus rounded-full border border-border bg-background px-2 py-0.5 text-[10px] uppercase tracking-wider text-foreground"
                >
                  {AUTO_REFRESH_OPTIONS.map((s) => (
                    <option key={s} value={s}>
                      {s === 0 ? "Off" : `${s}s`}
                    </option>
                  ))}
                </select>
              </label>
              <button
                type="button"
                onClick={() => {
                  if (filtersBlocked) {
                    setAnnouncement("Fix the highlighted filters before refreshing");
                    return;
                  }
                  void refetch();
                  setAnnouncement("Refreshing activity");
                }}
                disabled={isFetching || filtersBlocked}
                aria-label="Refresh activity now"
                title={updatedLabel ? `Updated ${updatedLabel}` : "Refresh activity now"}
                className="kb-focus inline-flex items-center gap-1 rounded-full border border-border bg-background px-2 py-0.5 text-[10px] uppercase tracking-wider text-foreground transition-colors hover:border-primary hover:text-primary disabled:opacity-50"
              >
                <RefreshCw size={10} className={isFetching ? "animate-spin" : ""} aria-hidden="true" />
                {updatedLabel ?? "Refresh"}
              </button>
            </>
          ) : (
            <span className="mono text-[10px] uppercase tracking-widest text-muted-foreground">
              Archived
            </span>
          )}

        </div>
      </div>

      {bannerVisible && (
        <div
          ref={errorBannerRef}
          data-testid="log-filter-errors"
          role="alert"
          aria-live="assertive"
          aria-atomic="true"
          tabIndex={-1}
          aria-label="Activity filter problems"
          className="kb-focus border-b border-border bg-destructive/10 px-5 py-3"
        >

          <div className="flex items-start gap-2.5">
            <AlertTriangle size={14} className="mt-0.5 shrink-0 text-destructive" aria-hidden="true" />
            <div className="min-w-0 flex-1">
              <p className="text-xs font-medium text-foreground">
                {logError
                  ? "We couldn’t load these records"
                  : filtersBlocked
                    ? "Fix these filters to load records"
                    : "Some filters were adjusted"}
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

          {/* Saved views: one tap reapplies a whole filter combination. */}
          <div className="flex flex-wrap items-center gap-1.5" data-testid="log-saved-views">
            <span className="mono flex items-center gap-1 text-[10px] uppercase tracking-widest text-muted-foreground">
              <Bookmark size={11} aria-hidden="true" />
              Saved
            </span>
            {presets.length === 0 && !showSavePreset && (
              <span className="text-[10px] text-muted-foreground">none yet</span>
            )}
            {presets.map((preset) => (
              <span
                key={preset.id}
                className="inline-flex items-center overflow-hidden rounded-full border border-border bg-background"
              >
                <button
                  type="button"
                  onClick={() => applyPreset(preset)}
                  title={summarizePreset(preset)}
                  aria-label={`Apply saved view ${preset.name}: ${summarizePreset(preset)}`}
                  className="kb-focus px-2 py-0.5 text-[10px] uppercase tracking-wider text-foreground transition-colors hover:text-primary"
                >
                  {preset.name}
                </button>
                <button
                  type="button"
                  onClick={() => deletePreset(preset)}
                  aria-label={`Delete saved view ${preset.name}`}
                  title={`Delete saved view ${preset.name}`}
                  className="kb-focus border-l border-border px-1.5 py-0.5 text-muted-foreground transition-colors hover:text-destructive"
                >
                  <X size={9} aria-hidden="true" />
                </button>
              </span>
            ))}
            {showSavePreset ? (
              <span className="inline-flex items-center gap-1">
                <input
                  autoFocus
                  value={presetName}
                  onChange={(e) => setPresetName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") savePreset();
                    if (e.key === "Escape") {
                      setShowSavePreset(false);
                      setPresetName("");
                    }
                  }}
                  maxLength={40}
                  placeholder="Name this view"
                  aria-label="Name for this saved filter view"
                  className="kb-focus w-32 rounded-full border border-border bg-background px-2 py-0.5 text-[10px] text-foreground placeholder:text-muted-foreground"
                />
                <button
                  type="button"
                  onClick={savePreset}
                  disabled={presetName.trim().length === 0}
                  className="kb-focus rounded-full bg-primary px-2 py-0.5 text-[10px] uppercase tracking-wider text-paper disabled:opacity-50"
                >
                  Save
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setShowSavePreset(false);
                    setPresetName("");
                  }}
                  className="kb-focus rounded-full border border-border px-2 py-0.5 text-[10px] uppercase tracking-wider text-muted-foreground"
                >
                  Cancel
                </button>
              </span>
            ) : (
              presets.length < MAX_LOG_PRESETS && (
                <button
                  type="button"
                  onClick={() => setShowSavePreset(true)}
                  aria-label="Save the current filters as a view"
                  title="Save the current filters as a view"
                  className="kb-focus inline-flex items-center gap-1 rounded-full border border-dashed border-border px-2 py-0.5 text-[10px] uppercase tracking-wider text-muted-foreground transition-colors hover:border-primary hover:text-primary"
                >
                  <BookmarkPlus size={10} aria-hidden="true" />
                  Save view
                </button>
              )
            )}
          </div>



          <div>
            <div className="relative flex items-center">
              <Search size={12} className="pointer-events-none absolute left-2.5 text-muted-foreground" />
              <input
                type="search"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Search name, phone, message…"
                aria-label="Search activity by phone number, customer name, or message text"
                aria-invalid={issueFor("q") ? true : undefined}
                aria-describedby={issueFor("q") ? helpId("q") : undefined}
                maxLength={MAX_LOG_SEARCH_LENGTH + 20}
                className={`kb-focus h-7 w-40 rounded-full border bg-background pl-7 pr-7 text-xs text-foreground placeholder:text-muted-foreground focus:border-primary focus:outline-none sm:w-56 ${
                  issueFor("q") ? "border-orange" : "border-border"
                }`}
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
            <FieldHelp field="q" />
          </div>


          <div className="relative flex items-center">
            <input
              type="text"
              value={customerInput}
              onChange={(e) => setCustomerInput(e.target.value)}
              placeholder="Contact phone or ID…"
              aria-label="Filter activity by customer phone number or customer ID"
              aria-invalid={customerFilterInvalid || undefined}
              aria-describedby="log-customer-filter-hint"
              maxLength={64}
              className="kb-focus h-7 w-40 rounded-full border border-border bg-background px-3 pr-7 text-xs text-foreground placeholder:text-muted-foreground focus:border-primary focus:outline-none sm:w-48"
            />
            {customerInput && (
              <button
                type="button"
                aria-label="Clear contact filter"
                onClick={() => setCustomerInput("")}
                className="kb-focus absolute right-2 text-muted-foreground hover:text-foreground"
              >
                ×
              </button>
            )}
            <span id="log-customer-filter-hint" className="sr-only">
              Enter a full customer ID or at least four digits of a phone number.
            </span>
          </div>

          {customerFilterInvalid && (
            <span className="mono text-[10px] uppercase tracking-wider text-orange">
              Enter a customer ID or 4+ phone digits
            </span>
          )}

          <div>
            <DateRangePicker
              value={dateRange}
              onChange={(next) => {
                setDateRange(next);
              }}
              placeholder="Date range"
            />
            <FieldHelp field="dateRange" />
          </div>

          <JumpToDatePicker
            onJump={(day) => {
              setDateRange({ from: day, to: day });
              setAnnouncement(`Jumped to ${day.toLocaleDateString()}`);
            }}
          />



          <label className="flex cursor-pointer items-center gap-2 text-xs text-foreground">
            <input
              type="checkbox"
              className="h-3.5 w-3.5 accent-primary"
              checked={statusRefreshOnly}
              disabled={originFilter !== "all"}
              onChange={(e) => {
                const on = e.target.checked;
                void navigate({
                  to: ".",
                  search: (prev: Record<string, unknown>) => ({
                    ...prev,
                    logStatusOnly: on ? "1" : undefined,
                    logFailed: on ? (prev.logFailed as string | undefined) : undefined,
                  }),
                  resetScroll: false,
                });
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
                    void navigate({
                      to: ".",
                      search: (prev: Record<string, unknown>) => ({
                        ...prev,
                        logOrigin: key === "all" ? undefined : key,
                        logStatusOnly:
                          key === "all" ? (prev.logStatusOnly as string | undefined) : undefined,
                        logFailed: key === "all" ? (prev.logFailed as string | undefined) : undefined,
                      }),
                      resetScroll: false,
                    });
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

          <div>
            <div
              className="flex flex-wrap items-center gap-2"
              role="group"
              aria-label="Sort order"
              aria-describedby={issueFor("logSort") ? helpId("logSort") : undefined}
            >
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
            <FieldHelp field="logSort" />
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


        <fieldset
          className="mt-3 border-t border-border pt-3"
          aria-describedby={issueFor("logTypes") ? helpId("logTypes") : undefined}
        >
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
          <FieldHelp field="logTypes" />
          {/* Compact picker for the same record types as the chips below: on a
              phone the full chip row is long, so this adds one type at a time.
              Options come from the generated enum, so the value can only ever
              be an action_type the database accepts. */}
          <div className="mt-2 flex items-center gap-2">
            <label
              htmlFor="log-type-picker"
              className="mono text-[10px] uppercase tracking-widest text-muted-foreground"
            >
              Add type
            </label>
            <select
              id="log-type-picker"
              value=""
              disabled={typePickerOptions.length === 0}
              onChange={(e) => {
                const picked = logActionFilterValue(e.target.value);
                setSelectedTypes((prev) => (prev.includes(picked) ? prev : [...prev, picked]));
                setAnnouncement(`Added record type filter ${typeLabel(picked)}`);
              }}
              aria-label="Add a record type filter"
              className="kb-focus h-7 max-w-[14rem] flex-1 rounded-full border border-border bg-background px-2 text-xs text-foreground sm:flex-none sm:w-56"
            >
              <option value="" disabled>
                {typePickerOptions.length === 0
                  ? "All record types selected"
                  : `Choose a record type (${typePickerOptions.length})`}
              </option>
              {typePickerOptions.map((o) => (
                <option key={o.value} value={o.value} title={o.description}>
                  {o.label}
                  {o.isNew ? " · new" : ""}
                </option>
              ))}
            </select>
          </div>

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
        {!isLoading && logError && errorRetryPanel}
        {filtersBlocked && filtered.length === 0 && (
          <div role="listitem" data-testid="log-filters-blocked" className="p-5 text-muted-foreground">
            We didn’t search yet — fix the highlighted filters above and results will load.
          </div>
        )}
        {!filtersBlocked && !isLoading && !logError && filtered.length === 0 && (
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
