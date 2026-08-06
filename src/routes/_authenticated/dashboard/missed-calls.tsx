import { createFileRoute } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { PageHeader } from "@/components/AppShell";
import { getVoicemailProxyUrl } from "@/lib/voicemail.functions";
import { sendOptInPrompt, sendOptInPromptBatch } from "@/lib/opt-in-prompt.functions";
import { OPT_IN_PROMPT_ACTION } from "@/lib/opt-in-prompt";
import {
  OPT_IN_PROMPT_ENGAGEMENT_RULE,
  OPT_IN_PROMPT_HOLD_REASON,
  OPT_IN_PROMPT_REAL_SENDS_ENABLED,
} from "@/lib/opt-in-prompt-gate";

import { MissedCallDetailSheet, type MissedCallDetail } from "@/components/MissedCallDetailSheet";
import { useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { buildMissedCallsCsv, downloadCsv, type MissedCallCsvRow } from "@/lib/missed-calls-csv";

type StatusFilter = "all" | "sent" | "failed" | "unconfirmed" | "skipped";

const STATUS_OPTIONS: StatusFilter[] = ["all", "sent", "failed", "unconfirmed", "skipped"];

function asString(v: unknown, fallback = ""): string {
  return typeof v === "string" ? v : fallback;
}

export const Route = createFileRoute("/_authenticated/dashboard/missed-calls")({
  validateSearch: (search: Record<string, unknown>) => ({
    q: asString(search.q),
    status: asString(search.status, "all"),
    from: asString(search.from),
    to: asString(search.to),
  }),
  component: MissedCallsPage,
  head: () => ({
    meta: [
      { title: "Missed calls — Temaro dispatch" },
      {
        name: "description",
        content:
          "Every missed call with its auto-reply status, voicemail, and one-tap re-send of the compliant SMS opt-in prompt.",
      },
      { property: "og:title", content: "Missed calls — Temaro dispatch" },
      {
        property: "og:description",
        content: "Track missed-call auto-replies and re-send the compliant opt-in prompt.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
});

type Row = {
  id: string;
  created_at: string;
  action_type: string;
  status: string;
  message_sent: string | null;
  twilio_message_sid: string | null;
  voicemail_url: string | null;
  call_sid: string | null;
  recording_sid: string | null;
  customer_id: string | null;
  customers: { phone_number: string; first_name: string | null; opt_in_consent: boolean } | null;
};

/** The badge/filter status derived from the log row. */
function rowStatus(row: Row): Exclude<StatusFilter, "all"> {
  if (row.action_type === "missed_call_excluded") return "skipped";
  if (row.status === "failed") return "failed";
  if (!row.twilio_message_sid) return "unconfirmed";
  return "sent";
}

function MissedCallsPage() {
  const queryClient = useQueryClient();
  const navigate = useNavigate({ from: Route.fullPath });
  const { q, status, from, to } = Route.useSearch();
  const setFilter = (patch: Partial<{ q: string; status: string; from: string; to: string }>) =>
    navigate({
      search: (prev: { q: string; status: string; from: string; to: string }) => ({
        ...prev,
        ...patch,
      }),
    });
  const [selected, setSelected] = useState<MissedCallDetail | null>(null);
  const { data, isLoading } = useQuery({
    queryKey: ["missed-calls", from, to],
    queryFn: async () => {
      let query = supabase
        .from("logs")
        .select(
          "id, message_sent, created_at, twilio_message_sid, customer_id, voicemail_url, call_sid, recording_sid, action_type, status, customers(phone_number, first_name, opt_in_consent)",
        )
        .in("action_type", ["missed_call_text", "missed_call_autotext", "missed_call_excluded"]);
      if (from) query = query.gte("created_at", new Date(`${from}T00:00:00`).toISOString());
      if (to) query = query.lte("created_at", new Date(`${to}T23:59:59.999`).toISOString());
      const { data } = await query.order("created_at", { ascending: false }).limit(200);
      return (data ?? []) as unknown as Row[];
    },
  });

  // Most recent opt-in prompt per customer, so the table can show whether one
  // has already gone out and when.
  const { data: prompts } = useQuery({
    queryKey: ["opt-in-prompts"],
    queryFn: async () => {
      const { data } = await supabase
        .from("logs")
        .select("customer_id, created_at, status")
        .eq("action_type", OPT_IN_PROMPT_ACTION)
        .order("created_at", { ascending: false })
        .limit(200);
      const map = new Map<string, { created_at: string; status: string }>();
      for (const row of data ?? []) {
        if (row.customer_id && !map.has(row.customer_id)) {
          map.set(row.customer_id, { created_at: row.created_at, status: row.status });
        }
      }
      return map;
    },
  });

  const send = useServerFn(sendOptInPrompt);
  const mutation = useMutation({
    mutationFn: (customerId: string) => send({ data: { customerId } }),
    onSuccess: () => {
      toast.success("Opt-in prompt sent");
      queryClient.invalidateQueries({ queryKey: ["opt-in-prompts"] });
      queryClient.invalidateQueries({ queryKey: ["missed-calls"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  // --- Bulk mode ---------------------------------------------------------
  const [bulkMode, setBulkMode] = useState(false);
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [summary, setSummary] = useState<BatchSummary | null>(null);
  const sendBatch = useServerFn(sendOptInPromptBatch);
  const batch = useMutation({
    mutationFn: (customerIds: string[]) => sendBatch({ data: { customerIds } }),
    onSuccess: (res) => {
      setSummary(res as BatchSummary);
      setChecked(new Set());
      if (res.sent > 0) toast.success(`${res.sent} prompt${res.sent === 1 ? "" : "s"} sent`);
      if (res.failed > 0) toast.error(`${res.failed} skipped or failed`);
      queryClient.invalidateQueries({ queryKey: ["opt-in-prompts"] });
      queryClient.invalidateQueries({ queryKey: ["missed-calls"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const allRows = data ?? [];
  const needle = q.trim().toLowerCase();
  const digits = needle.replace(/\D+/g, "");
  const rows = allRows.filter((r) => {
    if (status !== "all" && rowStatus(r) !== status) return false;
    if (!needle) return true;
    const name = (r.customers?.first_name ?? "").toLowerCase();
    const phone = r.customers?.phone_number ?? "";
    return (
      name.includes(needle) ||
      phone.toLowerCase().includes(needle) ||
      (digits.length > 0 && phone.replace(/\D+/g, "").includes(digits))
    );
  });
  const needsConsent = rows.filter((r) => r.customers && !r.customers.opt_in_consent).length;

  // One row per contact: bulk selection is per customer, not per call event.
  const eligibleIds = Array.from(
    new Set(
      rows
        .filter((r) => r.customer_id && r.customers?.opt_in_consent === false)
        .map((r) => r.customer_id!),
    ),
  );
  // --- CSV export --------------------------------------------------------
  const [exporting, setExporting] = useState(false);
  const exportCsv = async () => {
    if (rows.length === 0) {
      toast.error("Nothing to export with the current filters");
      return;
    }
    setExporting(true);
    try {
      const customerIds = Array.from(
        new Set(rows.map((r) => r.customer_id).filter((id): id is string => !!id)),
      );
      // Every opt-in prompt attempt (not just the latest) for the visible contacts.
      const attempts = new Map<
        string,
        {
          created_at: string;
          status: string;
          twilio_message_sid: string | null;
          prompt_template: string | null;
          prompt_template_hash: string | null;
          prompt_cooldown_minutes: number | null;
        }[]
      >();
      if (customerIds.length > 0) {
        const { data: promptLogs } = await supabase
          .from("logs")
          .select(
            "customer_id, created_at, status, twilio_message_sid, prompt_template, prompt_template_hash, prompt_cooldown_minutes",
          )
          .eq("action_type", OPT_IN_PROMPT_ACTION)
          .in("customer_id", customerIds)
          .order("created_at", { ascending: true });
        for (const log of promptLogs ?? []) {
          if (!log.customer_id) continue;
          const list = attempts.get(log.customer_id) ?? [];
          list.push({
            created_at: log.created_at,
            status: log.status,
            twilio_message_sid: log.twilio_message_sid,
            prompt_template: log.prompt_template,
            prompt_template_hash: log.prompt_template_hash,
            prompt_cooldown_minutes: log.prompt_cooldown_minutes,
          });
          attempts.set(log.customer_id, list);
        }
      }

      const { data: profile } = await supabase
        .from("profiles")
        .select("twilio_phone_number")
        .maybeSingle();
      const businessNumber = profile?.twilio_phone_number ?? "";

      const csvRows: MissedCallCsvRow[] = rows.map((r) => ({
        created_at: r.created_at,
        from_number: r.customers?.phone_number ?? "",
        to_number: businessNumber,
        customer_name: r.customers?.first_name ?? "",
        auto_reply_status: rowStatus(r),
        auto_reply_sid: r.twilio_message_sid ?? "",
        call_sid: r.call_sid ?? "",
        voicemail_url: r.voicemail_url ?? "",
        recording_sid: r.recording_sid ?? "",
        opt_in_consent: r.customers ? String(r.customers.opt_in_consent) : "",
        prompt_attempts: r.customer_id ? (attempts.get(r.customer_id) ?? []) : [],
      }));

      const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
      downloadCsv(`missed-calls-${stamp}.csv`, buildMissedCallsCsv(csvRows));
      toast.success(`Exported ${csvRows.length} call${csvRows.length === 1 ? "" : "s"}`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Export failed");
    } finally {
      setExporting(false);
    }
  };

  const allSelected = eligibleIds.length > 0 && eligibleIds.every((id) => checked.has(id));
  const toggle = (id: string) =>
    setChecked((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });

  return (
    <div>
      <PageHeader eyebrow="Feature 01" title="Missed calls" />
      <div className="space-y-5 p-5 md:p-8">
        <div className="grid grid-cols-2 gap-3 md:max-w-md">
          <Stat label="Calls logged" value={rows.length} />
          <Stat label="Awaiting consent" value={needsConsent} />
        </div>

        <div className="panel flex flex-wrap items-end gap-3 p-4">
          <label className="flex flex-col gap-1">
            <span className="label-eyebrow">Search name / phone</span>
            <input
              type="search"
              value={q}
              onChange={(e) => setFilter({ q: e.target.value })}
              placeholder="e.g. Dana or 501365"
              className="mono w-52 rounded-sm border border-border bg-background/60 px-2 py-1.5 text-xs text-paper placeholder:text-muted-foreground"
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="label-eyebrow">Auto-reply status</span>
            <select
              value={STATUS_OPTIONS.includes(status as StatusFilter) ? status : "all"}
              onChange={(e) => setFilter({ status: e.target.value })}
              className="mono rounded-sm border border-border bg-background/60 px-2 py-1.5 text-xs uppercase tracking-wider text-paper"
            >
              {STATUS_OPTIONS.map((s) => (
                <option key={s} value={s}>
                  {s === "all" ? "All" : s}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1">
            <span className="label-eyebrow">From</span>
            <input
              type="date"
              value={from}
              onChange={(e) => setFilter({ from: e.target.value })}
              className="mono rounded-sm border border-border bg-background/60 px-2 py-1.5 text-xs text-paper"
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="label-eyebrow">To</span>
            <input
              type="date"
              value={to}
              onChange={(e) => setFilter({ to: e.target.value })}
              className="mono rounded-sm border border-border bg-background/60 px-2 py-1.5 text-xs text-paper"
            />
          </label>
          {(q || from || to || status !== "all") && (
            <button
              type="button"
              onClick={() => setFilter({ q: "", status: "all", from: "", to: "" })}
              className="rounded-sm border border-border px-3 py-1.5 text-[10px] uppercase tracking-widest text-muted-foreground transition-colors hover:text-paper"
            >
              Clear filters
            </button>
          )}
          <span className="mono ml-auto text-[10px] uppercase tracking-widest text-muted-foreground">
            {rows.length} of {allRows.length} shown
          </span>
        </div>

        {!OPT_IN_PROMPT_REAL_SENDS_ENABLED && (
          <div className="rounded-sm border border-violet/50 bg-violet/10 p-3">
            <div className="text-[10px] uppercase tracking-widest text-violet">
              Opt-in prompt on hold
            </div>
            <p className="mt-1 text-xs text-muted-foreground">{OPT_IN_PROMPT_HOLD_REASON}</p>
            <p className="mt-1 text-xs text-muted-foreground">{OPT_IN_PROMPT_ENGAGEMENT_RULE}</p>
          </div>
        )}

        <div className="flex flex-wrap items-center gap-3">

          <button
            type="button"
            onClick={exportCsv}
            disabled={exporting}
            className="rounded-sm border border-border px-3 py-1.5 text-[10px] uppercase tracking-widest text-paper transition-colors hover:bg-muted disabled:opacity-50"
          >
            {exporting ? "Exporting…" : "Export CSV"}
          </button>
          <button
            type="button"
            onClick={() => {
              setBulkMode((v) => !v);
              setChecked(new Set());
              setSummary(null);
            }}
            className="rounded-sm border border-border px-3 py-1.5 text-[10px] uppercase tracking-widest text-paper transition-colors hover:bg-muted"
          >
            {bulkMode ? "Exit bulk mode" : "Bulk opt-in prompts"}
          </button>
          {bulkMode && (
            <>
              <button
                type="button"
                disabled={eligibleIds.length === 0}
                onClick={() => setChecked(allSelected ? new Set() : new Set(eligibleIds))}
                className="rounded-sm border border-border px-3 py-1.5 text-[10px] uppercase tracking-widest text-muted-foreground transition-colors hover:text-paper disabled:opacity-40"
              >
                {allSelected ? "Clear all" : `Select all (${eligibleIds.length})`}
              </button>
              <button
                type="button"
                disabled={
                  checked.size === 0 || batch.isPending || !OPT_IN_PROMPT_REAL_SENDS_ENABLED
                }
                title={OPT_IN_PROMPT_REAL_SENDS_ENABLED ? undefined : OPT_IN_PROMPT_HOLD_REASON}
                onClick={() => batch.mutate(Array.from(checked))}
                className="rounded-sm border border-violet/60 bg-violet/10 px-3 py-1.5 text-[10px] uppercase tracking-widest text-violet transition-colors hover:bg-violet/20 disabled:opacity-40"
              >
                {!OPT_IN_PROMPT_REAL_SENDS_ENABLED
                  ? "On hold"
                  : batch.isPending
                    ? "Sending…"
                    : `Send to ${checked.size} selected`}
              </button>

            </>
          )}
        </div>

        {summary && (
          <div className="panel p-4">
            <div className="label-eyebrow mb-2">Batch summary</div>
            <div className="mono mb-3 text-xs">
              <span className="text-moss">{summary.sent} sent</span>
              {" · "}
              <span className={summary.failed ? "text-destructive" : "text-muted-foreground"}>
                {summary.failed} skipped/failed
              </span>
            </div>
            <ul className="mono space-y-1 text-[11px]">
              {summary.results.map((r) => (
                <li key={r.customerId} className="flex flex-wrap gap-2">
                  <span className={r.ok ? "text-moss" : "text-destructive"}>
                    {r.ok ? "OK" : "ERR"}
                  </span>
                  <span className="text-muted-foreground">{r.phone ?? r.customerId}</span>
                  <span className="text-paper">
                    {r.ok ? `sid ${r.sid ?? "unconfirmed"}` : r.error}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}

        <div className="panel overflow-x-auto">
          <table className="w-full min-w-[860px] text-sm">
            <thead className="border-b border-border bg-muted/40">
              <tr className="text-left">
                {bulkMode && <Th>Sel</Th>}
                <Th>Time</Th>
                <Th>Caller</Th>
                <Th>Auto-reply</Th>
                <Th>Voicemail</Th>
                <Th>Status</Th>
                <Th>Opt-in prompt</Th>
                <Th>Detail</Th>
              </tr>
            </thead>
            <tbody className="mono divide-y divide-border">
              {isLoading && (
                <tr>
                  <td colSpan={bulkMode ? 8 : 7} className="p-5 text-muted-foreground">
                    Loading…
                  </td>
                </tr>
              )}
              {!isLoading && rows.length === 0 && (
                <tr>
                  <td colSpan={bulkMode ? 8 : 7} className="p-5 text-muted-foreground">
                    {allRows.length === 0 ? "No missed calls yet." : "No calls match these filters."}
                  </td>
                </tr>
              )}
              {rows.map((row) => {
                const prompt = row.customer_id ? prompts?.get(row.customer_id) : undefined;
                const canPrompt = !!row.customer_id && row.customers?.opt_in_consent === false;
                return (
                  <tr key={row.id}>
                    {bulkMode && (
                      <Td>
                        {canPrompt ? (
                          <input
                            type="checkbox"
                            aria-label={`Select ${row.customers?.phone_number ?? "contact"}`}
                            checked={checked.has(row.customer_id!)}
                            onChange={() => toggle(row.customer_id!)}
                            className="h-4 w-4 accent-violet"
                          />
                        ) : (
                          <span className="text-xs text-muted-foreground">—</span>
                        )}
                      </Td>
                    )}
                    <Td>{new Date(row.created_at).toLocaleString()}</Td>
                    <Td>
                      <div>{row.customers?.first_name || "Unknown"}</div>
                      <div className="text-xs text-muted-foreground">
                        {row.customers?.phone_number ?? "—"}
                      </div>
                    </Td>
                    <Td className="max-w-md truncate">{row.message_sent}</Td>
                    <Td>
                      {row.voicemail_url ? (
                        <VoicemailPlayer logId={row.id} />
                      ) : (
                        <span className="text-xs text-muted-foreground">—</span>
                      )}
                    </Td>
                    <Td>
                      {rowStatus(row) === "skipped" ? (
                        <Badge tone="muted">Skipped</Badge>
                      ) : rowStatus(row) === "failed" ? (
                        <Badge tone="bad">Failed</Badge>
                      ) : rowStatus(row) === "unconfirmed" ? (
                        <Badge tone="bad">Unconfirmed</Badge>
                      ) : row.customers?.opt_in_consent === false ? (
                        <Badge tone="bad">Needs consent</Badge>
                      ) : (
                        <Badge tone="good">Sent</Badge>
                      )}
                    </Td>
                    <Td>
                      {prompt && (
                        <div className="mb-1 text-[10px] uppercase tracking-widest text-muted-foreground">
                          {prompt.status === "failed" ? "Failed" : "Sent"}{" "}
                          {new Date(prompt.created_at).toLocaleString()}
                        </div>
                      )}
                      {canPrompt ? (
                        <button
                          type="button"
                          disabled={mutation.isPending || !OPT_IN_PROMPT_REAL_SENDS_ENABLED}
                          title={
                            OPT_IN_PROMPT_REAL_SENDS_ENABLED ? undefined : OPT_IN_PROMPT_HOLD_REASON
                          }
                          onClick={() => mutation.mutate(row.customer_id!)}
                          className="rounded-sm border border-violet/50 px-2 py-1 text-[10px] uppercase tracking-widest text-violet transition-colors hover:bg-violet/10 disabled:opacity-50"
                        >
                          {!OPT_IN_PROMPT_REAL_SENDS_ENABLED
                            ? "On hold"
                            : prompt
                              ? "Re-send opt-in prompt"
                              : "Send opt-in prompt"}
                        </button>
                      ) : row.customers?.opt_in_consent ? (

                        <span className="text-xs text-moss">Opted in</span>
                      ) : (
                        <span className="text-xs text-muted-foreground">—</span>
                      )}
                    </Td>
                    <Td>
                      <button
                        type="button"
                        onClick={() => setSelected(row as MissedCallDetail)}
                        className="rounded-sm border border-border px-2 py-1 text-[10px] uppercase tracking-widest text-muted-foreground transition-colors hover:text-paper"
                      >
                        View
                      </button>
                    </Td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
      <MissedCallDetailSheet log={selected} onClose={() => setSelected(null)} />
    </div>
  );
}

type BatchSummary = {
  sent: number;
  failed: number;
  results: Array<{
    customerId: string;
    ok: boolean;
    sid?: string | null;
    error?: string;
    phone: string | null;
  }>;
};

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="panel p-4">
      <div className="label-eyebrow">{label}</div>
      <div className="mono text-2xl">{value}</div>
    </div>
  );
}

function Badge({ tone, children }: { tone: "good" | "bad" | "muted"; children: React.ReactNode }) {
  const cls =
    tone === "good"
      ? "bg-moss/10 text-moss"
      : tone === "bad"
        ? "bg-destructive/10 text-destructive"
        : "bg-muted text-muted-foreground";
  return (
    <span className={`rounded-sm px-2 py-0.5 text-xs uppercase tracking-wider ${cls}`}>
      {children}
    </span>
  );
}

function VoicemailPlayer({ logId }: { logId: string }) {
  const getUrl = useServerFn(getVoicemailProxyUrl);
  const { data, isLoading, error } = useQuery({
    queryKey: ["voicemail-proxy", logId],
    queryFn: () => getUrl({ data: { logId } }),
    staleTime: 4 * 60 * 1000, // refresh before the 5-min signed URL expires
  });
  if (isLoading) return <span className="text-xs text-muted-foreground">Loading…</span>;
  if (error || !data?.url) return <span className="text-xs text-destructive">Unavailable</span>;
  return (
    <div className="flex flex-col gap-1">
      <audio controls preload="none" src={data.url} className="h-8 w-56" />
      <a
        href={data.url}
        target="_blank"
        rel="noreferrer"
        className="text-[10px] uppercase tracking-widest text-violet underline"
      >
        Open recording ↗
      </a>
    </div>
  );
}

function Th({ children }: { children: React.ReactNode }) {
  return <th className="px-4 py-2 label-eyebrow text-left">{children}</th>;
}
function Td({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return <td className={`px-4 py-3 align-top ${className}`}>{children}</td>;
}
