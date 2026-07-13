import { createFileRoute } from "@tanstack/react-router";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Fragment, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { PageHeader } from "@/components/AppShell";
import { CustomerHistory } from "@/components/CustomerHistory";
import { toast } from "sonner";
import { sendReactivation } from "@/lib/sms.functions";

export const Route = createFileRoute("/_authenticated/dashboard/dead-leads")({
  component: DeadLeadsPage,
});

function DeadLeadsPage() {
  const qc = useQueryClient();
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const toggle = (id: string) => setExpanded((prev) => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

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

  const sendFn = useServerFn(sendReactivation);
  const send = useMutation({
    mutationFn: (id: string) => sendFn({ data: { customerId: id } }),
    onSuccess: () => { toast.success("Reactivation text sent."); qc.invalidateQueries(); },
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
                <Th> </Th><Th>Customer</Th><Th>Phone</Th><Th>Last service</Th><Th>Consent</Th><Th> </Th>
              </tr>
            </thead>
            <tbody className="mono divide-y divide-border">
              {data?.length === 0 && (
                <tr><td colSpan={6} className="p-5 text-muted-foreground">No stale customers. Nice.</td></tr>
              )}
              {data?.map((c) => {
                const isOpen = expanded.has(c.id);
                return (
                  <Fragment key={c.id}>
                    <tr className="cursor-pointer hover:bg-accent/30" onClick={() => toggle(c.id)}>
                      <Td>
                        <span className="mono text-xs text-muted-foreground select-none">{isOpen ? "▾" : "▸"}</span>
                      </Td>
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
                          onClick={(e) => { e.stopPropagation(); send.mutate(c.id); }}
                          disabled={send.isPending}
                          className="rounded-sm bg-orange px-3 py-1.5 text-xs uppercase tracking-wider text-orange-foreground hover:opacity-90 disabled:opacity-50"
                        >Send now</button>
                      </Td>
                    </tr>
                    {isOpen && (
                      <tr className="bg-background/40">
                        <td></td>
                        <td colSpan={5} className="px-4 py-4">
                          <CustomerHistory customerId={c.id} />
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
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
