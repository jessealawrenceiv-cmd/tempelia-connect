import { createFileRoute } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { PageHeader } from "@/components/AppShell";
import { getVoicemailProxyUrl } from "@/lib/voicemail.functions";
import { sendOptInPrompt } from "@/lib/opt-in-prompt.functions";
import { OPT_IN_PROMPT_ACTION } from "@/lib/opt-in-prompt";

export const Route = createFileRoute("/_authenticated/dashboard/missed-calls")({
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
  customer_id: string | null;
  customers: { phone_number: string; first_name: string | null; opt_in_consent: boolean } | null;
};

function MissedCallsPage() {
  const queryClient = useQueryClient();
  const { data, isLoading } = useQuery({
    queryKey: ["missed-calls"],
    queryFn: async () => {
      const { data } = await supabase
        .from("logs")
        .select(
          "id, message_sent, created_at, twilio_message_sid, customer_id, voicemail_url, action_type, status, customers(phone_number, first_name, opt_in_consent)",
        )
        .in("action_type", ["missed_call_text", "missed_call_autotext", "missed_call_excluded"])
        .order("created_at", { ascending: false })
        .limit(100);
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

  const rows = data ?? [];
  const needsConsent = rows.filter((r) => r.customers && !r.customers.opt_in_consent).length;

  return (
    <div>
      <PageHeader eyebrow="Feature 01" title="Missed calls" />
      <div className="space-y-5 p-5 md:p-8">
        <div className="grid grid-cols-2 gap-3 md:max-w-md">
          <Stat label="Calls logged" value={rows.length} />
          <Stat label="Awaiting consent" value={needsConsent} />
        </div>

        <div className="panel overflow-x-auto">
          <table className="w-full min-w-[860px] text-sm">
            <thead className="border-b border-border bg-muted/40">
              <tr className="text-left">
                <Th>Time</Th>
                <Th>Caller</Th>
                <Th>Auto-reply</Th>
                <Th>Voicemail</Th>
                <Th>Status</Th>
                <Th>Opt-in prompt</Th>
              </tr>
            </thead>
            <tbody className="mono divide-y divide-border">
              {isLoading && (
                <tr>
                  <td colSpan={6} className="p-5 text-muted-foreground">
                    Loading…
                  </td>
                </tr>
              )}
              {!isLoading && rows.length === 0 && (
                <tr>
                  <td colSpan={6} className="p-5 text-muted-foreground">
                    No missed calls yet.
                  </td>
                </tr>
              )}
              {rows.map((row) => {
                const prompt = row.customer_id ? prompts?.get(row.customer_id) : undefined;
                const canPrompt = !!row.customer_id && row.customers?.opt_in_consent === false;
                return (
                  <tr key={row.id}>
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
                      {row.action_type === "missed_call_excluded" ? (
                        <Badge tone="muted">Skipped</Badge>
                      ) : row.status === "failed" ? (
                        <Badge tone="bad">Failed</Badge>
                      ) : !row.twilio_message_sid ? (
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
                          disabled={mutation.isPending}
                          onClick={() => mutation.mutate(row.customer_id!)}
                          className="rounded-sm border border-violet/50 px-2 py-1 text-[10px] uppercase tracking-widest text-violet transition-colors hover:bg-violet/10 disabled:opacity-50"
                        >
                          {prompt ? "Re-send opt-in prompt" : "Send opt-in prompt"}
                        </button>
                      ) : row.customers?.opt_in_consent ? (
                        <span className="text-xs text-moss">Opted in</span>
                      ) : (
                        <span className="text-xs text-muted-foreground">—</span>
                      )}
                    </Td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

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
