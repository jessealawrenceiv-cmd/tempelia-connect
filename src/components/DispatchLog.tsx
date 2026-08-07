import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { supabase } from "@/integrations/supabase/client";
import { useEffect, useMemo, useRef, useState } from "react";
import { endOfDay, startOfDay } from "date-fns";
import { Filter, Search, Sparkles } from "lucide-react";
import { DateRangePicker, type DateRangeValue } from "@/components/DateRangePicker";
import { LogAction, type LogActionType } from "@/lib/log-action-types";
import {
  LOG_ACTION_FILTER_ORDER,
  isNewLogAction,
  logActionDescription,
  logActionDot,
  logActionLabel,
} from "@/lib/log-action-presentation";


type AffectedRef = { type: "customer" | "intake"; id: string; label: string };

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

export function DispatchLog({ limit = 25 }: { limit?: number }) {
  const [statusRefreshOnly, setStatusRefreshOnly] = useState(false);
  const [failedOnly, setFailedOnly] = useState(false);
  const [originFilter, setOriginFilter] = useState<"all" | "active" | "this-device" | "other-device" | "backend">("all");
  const [selectedTypes, setSelectedTypes] = useState<LogActionType[]>([]);
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

  const { data, isLoading } = useQuery({
    queryKey: ["logs", scope, limit, fromISO, toISO, typeKey],
    queryFn: async () => {
      if (scope === "archive") {
        let q = supabase
          .from("logs_archive")
          .select("id, action_type, message_sent, original_created_at, status, customer_id")
          .order("original_created_at", { ascending: false });
        if (fromISO) q = q.gte("original_created_at", fromISO);
        if (toISO) q = q.lte("original_created_at", toISO);
        if (selectedTypes.length > 0) q = q.in("action_type", selectedTypes);
        if (!hasRange) q = q.limit(limit);
        else q = q.limit(500);
        const { data } = await q;
        return (data ?? []).map((r) => ({
          id: r.id,
          action_type: r.action_type,
          message_sent: r.message_sent,
          created_at: r.original_created_at,
          status: r.status,
          customer_id: r.customer_id,
        }));
      }
      let q = supabase
        .from("logs")
        .select("id, action_type, message_sent, created_at, status, customer_id")
        .order("created_at", { ascending: false });
      if (fromISO) q = q.gte("created_at", fromISO);
      if (toISO) q = q.lte("created_at", toISO);
      if (selectedTypes.length > 0) q = q.in("action_type", selectedTypes);
      if (!hasRange) q = q.limit(limit);
      else q = q.limit(500);
      const { data } = await q;
      return data ?? [];
    },
  });

  const typeCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const row of data ?? []) counts[row.action_type] = (counts[row.action_type] ?? 0) + 1;
    return counts;
  }, [data]);

  const toggleType = (t: LogActionType) =>
    setSelectedTypes((prev) => (prev.includes(t) ? prev.filter((v) => v !== t) : [...prev, t]));

  const filtered = (data ?? []).filter((row) => {
    if (selectedTypes.length > 0 && !selectedTypes.includes(row.action_type as LogActionType)) return false;
    if (originFilter !== "all") {
      if (row.action_type !== LogAction.automation_status_change) return false;
      if (originFilter !== "active" && row.status !== originFilter) return false;
      return true;
    }
    if (statusRefreshOnly && row.action_type !== LogAction.status_refresh) return false;
    if (failedOnly) {
      if (row.action_type !== LogAction.status_refresh) return false;
      if (row.status !== "failed") return false;
    }
    if (searchTerms.length > 0) {
      const haystack = `${typeLabel(row.action_type)} ${describe(row)}`.toLowerCase();
      if (!searchTerms.every((term) => haystack.includes(term))) return false;
    }
    if (hasRange) {
      const t = new Date(row.created_at).getTime();
      if (fromISO && t < new Date(fromISO).getTime()) return false;
      if (toISO && t > new Date(toISO).getTime()) return false;
    }
    return true;
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
            {data?.length !== 0
              ? hasRange
                ? "No entries in the selected date range. Try widening the range or clearing filters."
                : "No entries match the selected filters."
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
    </div>
  );
}
