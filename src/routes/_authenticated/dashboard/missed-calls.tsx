import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { PageHeader } from "@/components/AppShell";

export const Route = createFileRoute("/_authenticated/dashboard/missed-calls")({
  component: MissedCallsPage,
});

function MissedCallsPage() {
  const { data, isLoading } = useQuery({
    queryKey: ["missed-calls"],
    queryFn: async () => {
      const { data } = await supabase
        .from("logs")
        .select("id, message_sent, created_at, twilio_message_sid, customer_id, customers(phone_number, first_name, opt_in_consent)")
        .eq("action_type", "missed_call_text")
        .order("created_at", { ascending: false })
        .limit(100);
      return data ?? [];
    },
  });

  return (
    <div>
      <PageHeader eyebrow="Feature 01" title="Missed calls" />
      <div className="p-5 md:p-8">
        <div className="panel overflow-hidden">
          <table className="w-full text-sm">
            <thead className="border-b border-border bg-muted/40">
              <tr className="text-left">
                <Th>Time</Th><Th>Caller</Th><Th>Auto-reply</Th><Th>Status</Th>
              </tr>
            </thead>
            <tbody className="mono divide-y divide-border">
              {isLoading && <tr><td colSpan={4} className="p-5 text-muted-foreground">Loading…</td></tr>}
              {!isLoading && data?.length === 0 && (
                <tr><td colSpan={4} className="p-5 text-muted-foreground">No missed calls yet. Connect Twilio in Onboarding to start capturing.</td></tr>
              )}
              {data?.map((row: any) => (
                <tr key={row.id}>
                  <Td>{new Date(row.created_at).toLocaleString()}</Td>
                  <Td>
                    <div>{row.customers?.first_name || "Unknown"}</div>
                    <div className="text-xs text-muted-foreground">{row.customers?.phone_number}</div>
                  </Td>
                  <Td className="max-w-md truncate">{row.message_sent}</Td>
                  <Td>
                    {row.customers?.opt_in_consent === false ? (
                      <span className="rounded-sm bg-destructive/10 px-2 py-0.5 text-xs uppercase tracking-wider text-destructive">Needs consent</span>
                    ) : (
                      <span className="rounded-sm bg-moss/10 px-2 py-0.5 text-xs uppercase tracking-wider text-moss">Sent</span>
                    )}
                  </Td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

function Th({ children }: { children: React.ReactNode }) {
  return <th className="px-4 py-2 label-eyebrow text-left">{children}</th>;
}
function Td({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return <td className={`px-4 py-3 align-top ${className}`}>{children}</td>;
}
