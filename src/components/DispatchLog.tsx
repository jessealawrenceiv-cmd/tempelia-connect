import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";

const DOT: Record<string, string> = {
  missed_call_text: "bg-orange",
  review_request: "bg-steel",
  reactivation_text: "bg-moss",
};
const LABEL: Record<string, string> = {
  missed_call_text: "MISSED_CALL_TEXT",
  review_request: "REVIEW_REQUEST",
  reactivation_text: "REACTIVATION_TEXT",
};

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
        <div className="label-eyebrow">Dispatch log</div>
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
            <span className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${DOT[row.action_type] ?? "bg-muted"}`} />
            <span>
              <span className="mr-2 font-semibold text-foreground">{LABEL[row.action_type] ?? row.action_type}</span>
              <span className="text-foreground/80">{row.message_sent ?? "—"}</span>
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
