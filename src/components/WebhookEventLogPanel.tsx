import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";

type Row = {
  id: string;
  received_at: string;
  source: string;
  event_kind: string;
  from_number: string | null;
  to_number: string | null;
  signature_valid: boolean;
  signature_detail: string | null;
  request_path: string | null;
  payload: unknown;
};

const KIND_LABEL: Record<string, string> = {
  missed_call: "MISSED CALL",
  sms_inbound: "INBOUND SMS",
  recording_status: "VOICEMAIL",
};

const FILTERS = [
  { id: "all", label: "All" },
  { id: "missed_call", label: "Missed calls" },
  { id: "sms_inbound", label: "Inbound SMS" },
  { id: "invalid", label: "Signature failures" },
] as const;

/**
 * Live webhook event log: the last 25 inbound Twilio hits with raw payloads and
 * whether the X-Twilio-Signature check passed. Streams via Postgres realtime,
 * with a slow poll as a fallback.
 */
export function WebhookEventLogPanel() {
  const [filter, setFilter] = useState<(typeof FILTERS)[number]["id"]>("all");
  const [openId, setOpenId] = useState<string | null>(null);
  const [live, setLive] = useState(true);

  const events = useQuery({
    queryKey: ["webhook-events"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("webhook_events")
        .select(
          "id, received_at, source, event_kind, from_number, to_number, signature_valid, signature_detail, request_path, payload",
        )
        .order("received_at", { ascending: false })
        .limit(25);
      if (error) throw error;
      return (data ?? []) as Row[];
    },
    refetchInterval: live ? 20000 : false,
  });

  // Realtime stream so new hits appear without waiting for the poll.
  useEffect(() => {
    if (!live) return;
    const channel = supabase
      .channel("webhook-events-stream")
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "webhook_events" },
        () => void events.refetch(),
      )
      .subscribe();
    return () => {
      void supabase.removeChannel(channel);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [live]);

  const rows = useMemo(() => {
    const all = events.data ?? [];
    if (filter === "all") return all;
    if (filter === "invalid") return all.filter((r) => !r.signature_valid);
    return all.filter((r) => r.event_kind === filter);
  }, [events.data, filter]);

  const failures = (events.data ?? []).filter((r) => !r.signature_valid).length;

  return (
    <div className="panel p-6 md:col-span-2">
      <div className="label-eyebrow">Diagnostics</div>
      <h2 className="mt-1 text-xl">Webhook event log</h2>
      <p className="mt-2 text-xs text-muted-foreground">
        Last 25 inbound missed-call and SMS webhook hits with the raw payload Twilio posted and the
        result of the signature check. Streams live; payloads are kept for 30 days.
      </p>

      <div className="mono mt-4 flex flex-wrap items-center gap-2 text-[10px] uppercase tracking-widest">
        {FILTERS.map((f) => (
          <button
            key={f.id}
            type="button"
            onClick={() => setFilter(f.id)}
            className={`rounded-sm border px-2 py-1 ${
              filter === f.id
                ? "border-orange text-orange"
                : "border-border text-muted-foreground hover:text-foreground"
            }`}
          >
            {f.label}
          </button>
        ))}
        <span className="ml-auto flex items-center gap-3 text-muted-foreground">
          <span>{events.data?.length ?? 0} events</span>
          {failures > 0 ? <span className="text-destructive">{failures} sig fail</span> : null}
          <button
            type="button"
            onClick={() => setLive((v) => !v)}
            className="underline hover:text-foreground"
          >
            {live ? "Pause stream" : "Resume stream"}
          </button>
          <button
            type="button"
            onClick={() => void events.refetch()}
            className="underline hover:text-foreground"
          >
            Refresh
          </button>
        </span>
      </div>

      <div className="mt-4 border-t border-border pt-3">
        {events.isLoading ? (
          <p className="mono text-[10px] uppercase tracking-widest text-muted-foreground">
            Loading…
          </p>
        ) : rows.length === 0 ? (
          <p className="mono text-[10px] uppercase tracking-widest text-muted-foreground">
            No webhook traffic recorded yet — call or text your Temaro number to generate an event.
          </p>
        ) : (
          <ul className="mono divide-y divide-border text-[10px] uppercase tracking-widest">
            {rows.map((r) => (
              <li key={r.id} className="py-2">
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                  <span className="text-muted-foreground">
                    {new Date(r.received_at).toLocaleString()}
                  </span>
                  <span className="text-foreground">
                    {KIND_LABEL[r.event_kind] ?? r.event_kind.toUpperCase()}
                  </span>
                  <span className="text-moss normal-case tracking-normal">
                    {r.from_number ?? "—"} → {r.to_number ?? "—"}
                  </span>
                  <span className={r.signature_valid ? "text-moss" : "text-destructive"}>
                    [{r.signature_valid ? "OK" : "XX"}] sig{" "}
                    {r.signature_valid ? "valid" : "invalid"}
                  </span>
                  <button
                    type="button"
                    onClick={() => setOpenId(openId === r.id ? null : r.id)}
                    className="ml-auto underline text-muted-foreground hover:text-foreground"
                  >
                    {openId === r.id ? "Hide payload" : "Payload"}
                  </button>
                </div>
                {openId === r.id && (
                  <div className="mt-2 space-y-1">
                    <p className="text-muted-foreground normal-case tracking-normal">
                      {r.request_path ?? "—"} · {r.signature_detail ?? "no detail"}
                    </p>
                    <pre className="max-h-64 overflow-auto rounded border border-border bg-muted/30 p-3 text-[10px] normal-case tracking-normal text-foreground">
{JSON.stringify(r.payload ?? {}, null, 2)}
                    </pre>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
