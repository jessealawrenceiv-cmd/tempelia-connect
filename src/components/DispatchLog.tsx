import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { supabase } from "@/integrations/supabase/client";
import { useState } from "react";
import { Filter } from "lucide-react";

type AffectedRef = { type: "customer" | "intake"; id: string; label: string };

function parseAffected(row: { action_type: string; message_sent: string | null }): AffectedRef[] {
  if (row.action_type !== "status_refresh" || !row.message_sent) return [];
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



const DOT: Record<string, string> = {
  missed_call_text: "bg-orange",
  review_request: "bg-steel",
  reactivation_text: "bg-moss",
  status_refresh: "bg-orange",
  automation_status_change: "bg-primary",
};
const LABEL: Record<string, string> = {
  missed_call_text: "MISSED_CALL_TEXT",
  review_request: "REVIEW_REQUEST",
  reactivation_text: "REACTIVATION_TEXT",
  status_refresh: "STATUS_REFRESH",
  automation_status_change: "STATUS_CHANGE",
};

// Refresh-attempt audit rows store structured JSON; render them as readable
// dispatch lines instead of dumping raw payloads.
const REFRESH_OUTCOME: Record<string, { text: string; dot: string }> = {
  updated: { text: "statuses updated", dot: "bg-primary" },
  already_current: { text: "already current", dot: "bg-steel" },
  failed: { text: "refresh failed", dot: "bg-orange" },
};

function describe(row: { action_type: string; status: string | null; message_sent: string | null }) {
  if (row.action_type !== "status_refresh" && row.action_type !== "automation_status_change") {
    return row.message_sent ?? "—";
  }
  let payload: Record<string, unknown> = {};
  try {
    payload = row.message_sent ? (JSON.parse(row.message_sent) as Record<string, unknown>) : {};
  } catch {
    return row.message_sent ?? "—";
  }
  const parts: string[] = [];
  if (row.action_type === "status_refresh") {
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



export function DispatchLog({ limit = 25 }: { limit?: number }) {
  const [statusRefreshOnly, setStatusRefreshOnly] = useState(false);
  const [failedOnly, setFailedOnly] = useState(false);

  const { data, isLoading } = useQuery({
    queryKey: ["logs", limit],
    queryFn: async () => {
      const { data } = await supabase
        .from("logs")
        .select("id, action_type, message_sent, created_at, status, customer_id")
        .order("created_at", { ascending: false })
        .limit(limit);
      return data ?? [];
    },
  });

  const filtered = (data ?? []).filter((row) => {
    if (statusRefreshOnly && row.action_type !== "status_refresh") return false;
    if (failedOnly) {
      if (row.action_type !== "status_refresh") return false;
      if (row.status !== "failed") return false;
    }
    return true;
  });

  return (
    <div className="panel">
      <div className="flex items-center justify-between border-b border-border px-5 py-3">
        <div className="label-eyebrow">Activity</div>
        <span className="mono flex items-center gap-1.5 text-[10px] uppercase tracking-widest text-moss">
          <span className="h-2 w-2 animate-pulse rounded-full bg-moss" />
          Live
        </span>
      </div>
      <div className="border-b border-border px-5 py-3">
        <div className="flex flex-wrap items-center gap-4">
          <span className="mono flex items-center gap-1.5 text-[10px] uppercase tracking-widest text-muted-foreground">
            <Filter size={12} />
            Filter
          </span>
          <label className="flex cursor-pointer items-center gap-2 text-xs text-foreground">
            <input
              type="checkbox"
              className="h-3.5 w-3.5 accent-primary"
              checked={statusRefreshOnly}
              onChange={(e) => {
                setStatusRefreshOnly(e.target.checked);
                if (!e.target.checked) setFailedOnly(false);
              }}
            />
            STATUS_REFRESH only
          </label>
          <label
            className={`flex items-center gap-2 text-xs ${
              statusRefreshOnly ? "cursor-pointer text-foreground" : "cursor-not-allowed text-muted-foreground"
            }`}
          >
            <input
              type="checkbox"
              className="h-3.5 w-3.5 accent-primary"
              checked={failedOnly}
              disabled={!statusRefreshOnly}
              onChange={(e) => setFailedOnly(e.target.checked)}
            />
            Failed only
          </label>
        </div>
      </div>

      <ul className="mono max-h-[520px] divide-y divide-border overflow-y-auto text-xs">
        {isLoading && <li className="p-5 text-muted-foreground">Loading…</li>}
        {!isLoading && filtered.length === 0 && (
          <li className="p-5 text-muted-foreground">
            {data?.length === 0
              ? "No dispatches yet. Actions will appear here in real time."
              : "No entries match the selected filters."}
          </li>
        )}
        {filtered.map((row) => (

          <li key={row.id} className="grid grid-cols-[auto_auto_1fr] items-start gap-3 px-5 py-3">
            <span className="text-muted-foreground">
              {new Date(row.created_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}
            </span>
            <span
              className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${
                (row.action_type === "status_refresh" ? REFRESH_OUTCOME[row.status ?? ""]?.dot : undefined) ??
                DOT[row.action_type] ??
                "bg-muted"
              }`}
            />
            <span>
              <span className="mr-2 font-semibold text-foreground">{LABEL[row.action_type] ?? row.action_type}</span>
              <span className="text-foreground/80">{describe(row)}</span>

            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
