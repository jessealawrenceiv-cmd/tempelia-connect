import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";

type LogRow = {
  id: string;
  created_at: string;
  status: string;
  message_sent: string | null;
};

type Detail = {
  changes?: string[];
  changed_fields?: string[];
  trigger?: string;
  previous_values?: Record<string, unknown>;
  new_values?: Record<string, unknown>;
  at?: string;
};

type AuditEntry = {
  id: string;
  at: Date;
  origin: string;
  changes: string[];
  changedFields: string[];
  previous: Record<string, unknown>;
  next: Record<string, unknown>;
};

const ORIGIN_LABEL: Record<string, string> = {
  "this-device": "This device",
  "other-device": "Another device",
  backend: "Backend",
};

const ORIGIN_CLASS: Record<string, string> = {
  "this-device": "border-primary/60 text-primary",
  "other-device": "border-steel/60 text-steel",
  backend: "border-border text-muted-foreground",
};

const FILTERS = [
  { id: "all", label: "All" },
  { id: "this-device", label: "This device" },
  { id: "other-device", label: "Another device" },
  { id: "backend", label: "Backend" },
] as const;

const FIELD_LABEL: Record<string, string> = {
  voicemail_enabled: "Missed-call text",
  decline_followup_mode: "Declined-quote follow-up",
  review_requests_enabled: "Reviews",
  intake_enabled: "Intake form",
};

function parse(row: LogRow): AuditEntry {
  let detail: Detail = {};
  try {
    detail = row.message_sent ? (JSON.parse(row.message_sent) as Detail) : {};
  } catch {
    detail = {};
  }
  return {
    id: row.id,
    at: new Date(detail.at ?? row.created_at),
    origin: row.status,
    changes: detail.changes ?? [],
    changedFields: detail.changed_fields ?? [],
    previous: detail.previous_values ?? {},
    next: detail.new_values ?? {},
  };
}

function fmt(v: unknown) {
  if (typeof v === "boolean") return v ? "ACTIVE" : "OFF";
  if (v === null || v === undefined || v === "") return "—";
  return String(v).toUpperCase();
}

/**
 * Audit trail for every ACTIVE automation status change: what changed, the
 * before/after values, where the change came from (this device, another signed-in
 * device, or the backend) and the exact timestamp. Append-only — rows come from
 * the activity log and cannot be edited or deleted from the app.
 */
export function ActiveChangeAuditPanel() {
  const [filter, setFilter] = useState<(typeof FILTERS)[number]["id"]>("all");
  const [openId, setOpenId] = useState<string | null>(null);

  const query = useQuery({
    queryKey: ["active-change-audit"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("logs")
        .select("id, created_at, status, message_sent")
        .eq("action_type", "automation_status_change")
        .order("created_at", { ascending: false })
        .limit(100);
      if (error) throw error;
      return (data ?? []).map((r) => parse(r as LogRow));
    },
    refetchInterval: 60_000,
  });

  // Stream new audit rows in as they land so the trail matches the live badge.
  useEffect(() => {
    const channel = supabase
      .channel("active-change-audit-stream")
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "logs" },
        () => void query.refetch(),
      )
      .subscribe();
    return () => {
      void supabase.removeChannel(channel);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const rows = useMemo(() => {
    const all = query.data ?? [];
    return filter === "all" ? all : all.filter((r) => r.origin === filter);
  }, [query.data, filter]);

  const exportCsv = () => {
    const header = ["timestamp_iso", "timestamp_local", "source", "changed_fields", "change", "before", "after"];
    const lines = rows.map((r) =>
      [
        r.at.toISOString(),
        r.at.toLocaleString(),
        ORIGIN_LABEL[r.origin] ?? r.origin,
        r.changedFields.join(" "),
        r.changes.join(" · "),
        r.changedFields.map((f) => `${FIELD_LABEL[f] ?? f}=${fmt(r.previous[f])}`).join(" "),
        r.changedFields.map((f) => `${FIELD_LABEL[f] ?? f}=${fmt(r.next[f])}`).join(" "),
      ]
        .map((c) => `"${String(c).replace(/"/g, '""')}"`)
        .join(","),
    );
    const blob = new Blob([[header.join(","), ...lines].join("\n")], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `temaro-active-change-audit-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
    toast.success(`Exported ${rows.length} audit ${rows.length === 1 ? "entry" : "entries"}.`);
  };

  return (
    <div className="panel p-6 md:col-span-2">
      <div className="label-eyebrow">Audit</div>
      <h2 className="mt-1 text-xl">ACTIVE change audit log</h2>
      <p className="mt-2 text-xs text-muted-foreground">
        Append-only record of every automation status change — what flipped, the values before and
        after, the source of the change, and the exact time it landed.
      </p>

      <div className="mt-4 flex flex-wrap items-center gap-2">
        {FILTERS.map((f) => (
          <button
            key={f.id}
            type="button"
            onClick={() => setFilter(f.id)}
            aria-pressed={filter === f.id}
            className={`mono rounded-sm border px-2 py-1 text-[10px] uppercase tracking-widest kb-focus ${
              filter === f.id
                ? "border-primary text-primary"
                : "border-border text-muted-foreground hover:text-foreground"
            }`}
          >
            {f.label}
          </button>
        ))}
        <button
          type="button"
          onClick={exportCsv}
          disabled={rows.length === 0}
          className="mono ml-auto rounded-sm border border-border px-2 py-1 text-[10px] uppercase tracking-widest text-muted-foreground hover:text-foreground disabled:opacity-40 kb-focus"
        >
          Export CSV
        </button>
      </div>

      <div className="mono mt-4 divide-y divide-border border-t border-border text-xs" aria-live="polite">
        {query.isLoading && <div className="py-3 text-muted-foreground">Loading audit trail…</div>}
        {!query.isLoading && rows.length === 0 && (
          <div className="py-3 text-muted-foreground">
            No ACTIVE changes recorded{filter === "all" ? " yet" : " for this source"}.
          </div>
        )}
        {rows.map((r) => {
          const open = openId === r.id;
          return (
            <div key={r.id} className="py-3">
              <button
                type="button"
                onClick={() => setOpenId(open ? null : r.id)}
                aria-expanded={open}
                className="flex w-full flex-wrap items-center gap-x-3 gap-y-1 text-left kb-focus"
              >
                <span className="tabular-nums text-muted-foreground">
                  {r.at.toLocaleString([], {
                    year: "numeric",
                    month: "2-digit",
                    day: "2-digit",
                    hour: "2-digit",
                    minute: "2-digit",
                    second: "2-digit",
                  })}
                </span>
                <span
                  className={`rounded-sm border px-1.5 py-0.5 text-[10px] uppercase tracking-widest ${
                    ORIGIN_CLASS[r.origin] ?? ORIGIN_CLASS["backend"]
                  }`}
                >
                  {ORIGIN_LABEL[r.origin] ?? r.origin}
                </span>
                <span className="text-foreground">{r.changes.join(" · ") || "Status change"}</span>
              </button>

              {open && (
                <dl className="mt-2 grid gap-1 border-l border-border pl-3 text-[11px] text-muted-foreground">
                  {r.changedFields.map((f) => (
                    <div key={f} className="flex flex-wrap gap-x-2">
                      <dt className="text-foreground">{FIELD_LABEL[f] ?? f}</dt>
                      <dd>
                        {fmt(r.previous[f])} → {fmt(r.next[f])}
                      </dd>
                    </div>
                  ))}
                  <div className="flex flex-wrap gap-x-2">
                    <dt className="text-foreground">Recorded</dt>
                    <dd className="tabular-nums">{r.at.toISOString()}</dd>
                  </div>
                </dl>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
