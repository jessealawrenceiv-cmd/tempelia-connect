import { createFileRoute } from "@tanstack/react-router";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { PageHeader } from "@/components/AppShell";
import { toast } from "sonner";

export const Route = createFileRoute("/_authenticated/dashboard/dead-leads")({
  component: DeadLeadsPage,
});

function DeadLeadsPage() {
  const qc = useQueryClient();

  const { data } = useQuery({
    queryKey: ["dead-leads"],
    queryFn: async () => {
      const sixMoAgo = new Date(); sixMoAgo.setMonth(sixMoAgo.getMonth() - 6);
      const thirtyDaysAgo = new Date(); thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
      const { data } = await supabase
        .from("customers")
        .select("*")
        .lte("last_service_date", sixMoAgo.toISOString().slice(0, 10))
        .or(`last_reactivation_at.is.null,last_reactivation_at.lt.${thirtyDaysAgo.toISOString()}`)
        .order("last_service_date", { ascending: true });
      return data ?? [];
    },
  });

  const send = useMutation({
    mutationFn: async (id: string) => {
      const { data: u } = await supabase.auth.getUser();
      if (!u.user) throw new Error("Not signed in");
      const { data: cust } = await supabase.from("customers").select("*").eq("id", id).maybeSingle();
      if (!cust) throw new Error("Not found");
      const msg = `Hi ${cust.first_name || "there"}, it's been a while! Want us to swing by for a seasonal check-up?\n\nReply STOP to unsubscribe.`;

      if (!cust.opt_in_consent) {
        await supabase.from("logs").insert({
          user_id: u.user.id, customer_id: id, action_type: "reactivation_text",
          message_sent: msg, status: "needs_consent",
        });
        throw new Error(`${cust.first_name || "Customer"} needs consent — flagged.`);
      }

      await supabase.from("customers").update({ last_reactivation_at: new Date().toISOString() }).eq("id", id);
      await supabase.from("logs").insert({
        user_id: u.user.id, customer_id: id, action_type: "reactivation_text",
        message_sent: msg, status: "queued",
      });
    },
    onSuccess: () => { toast.success("Reactivation text queued."); qc.invalidateQueries(); },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <div>
      <PageHeader eyebrow="Feature 03" title="Dead leads" />
      <div className="p-5 md:p-8">
        <div className="panel overflow-hidden">
          <div className="flex items-center justify-between border-b border-border px-5 py-3">
            <div className="label-eyebrow">Stale ≥ 6 months · not reactivated in 30 days</div>
            <div className="mono text-xs text-muted-foreground">{data?.length ?? 0} customer(s)</div>
          </div>
          <table className="w-full text-sm">
            <thead className="bg-muted/40">
              <tr className="text-left">
                <Th>Customer</Th><Th>Phone</Th><Th>Last service</Th><Th>Consent</Th><Th> </Th>
              </tr>
            </thead>
            <tbody className="mono divide-y divide-border">
              {data?.length === 0 && (
                <tr><td colSpan={5} className="p-5 text-muted-foreground">No stale customers. Nice.</td></tr>
              )}
              {data?.map((c) => (
                <tr key={c.id}>
                  <Td>{c.first_name || "Unnamed"}</Td>
                  <Td>{c.phone_number}</Td>
                  <Td>{c.last_service_date ?? "—"}</Td>
                  <Td>
                    {c.opt_in_consent ? (
                      <span className="rounded-sm bg-moss/10 px-2 py-0.5 text-xs uppercase tracking-wider text-moss">Opted in</span>
                    ) : (
                      <span className="rounded-sm bg-destructive/10 px-2 py-0.5 text-xs uppercase tracking-wider text-destructive">Needs consent</span>
                    )}
                  </Td>
                  <Td>
                    <button
                      onClick={() => send.mutate(c.id)}
                      disabled={send.isPending}
                      className="rounded-sm bg-orange px-3 py-1.5 text-xs uppercase tracking-wider text-orange-foreground hover:opacity-90 disabled:opacity-50"
                    >Send now</button>
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
function Td({ children }: { children: React.ReactNode }) {
  return <td className="px-4 py-3">{children}</td>;
}
