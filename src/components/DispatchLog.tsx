import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";

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

  return (
    <div className="panel">
      <div className="flex items-center justify-between border-b border-border px-5 py-3">
        <div className="label-eyebrow">Activity</div>
        <span className="mono flex items-center gap-1.5 text-[10px] uppercase tracking-widest text-moss">
          <span className="h-2 w-2 animate-pulse rounded-full bg-moss" />
          Live
        </span>
      </div>
      <ul className="mono max-h-[520px] divide-y divide-border overflow-y-auto text-xs">
        {isLoading && <li className="p-5 text-muted-foreground">Loading…</li>}
        {!isLoading && data?.length === 0 && (
          <li className="p-5 text-muted-foreground">No dispatches yet. Actions will appear here in real time.</li>
        )}
        {data?.map((row) => (
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
