import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { PageHeader } from "@/components/AppShell";
import { listProvisionedNumbers } from "@/lib/admin.functions";
import { Shield, Phone, MessageSquare, DollarSign, ExternalLink, AlertTriangle } from "lucide-react";

export const Route = createFileRoute("/_authenticated/dashboard/admin/numbers")({
  component: AdminNumbersPage,
});

const fmtUsd = (n: number) =>
  n.toLocaleString(undefined, { style: "currency", currency: "USD", minimumFractionDigits: 2 });

const fmtDate = (iso: string | null) =>
  iso ? new Date(iso).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" }) : "—";

function AdminNumbersPage() {
  const listFn = useServerFn(listProvisionedNumbers);
  const { data, isLoading, error } = useQuery({
    queryKey: ["admin", "numbers"],
    queryFn: () => listFn(),
    retry: false,
  });

  if (error) {
    const msg = (error as Error).message;
    const forbidden = /forbidden/i.test(msg);
    return (
      <div>
        <PageHeader eyebrow="Operator · Restricted" title="Provisioned numbers" />
        <div className="p-5 md:p-8">
          <div className="panel border-orange/40 bg-orange/5 p-6">
            <div className="label-eyebrow text-orange">{forbidden ? "Access denied" : "Error"}</div>
            <p className="mt-2 text-sm text-muted-foreground">
              {forbidden
                ? "This page is restricted to Tempelia operators."
                : msg}
            </p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div>
      <PageHeader
        eyebrow="Operator · Fleet"
        title="Provisioned numbers"
        actions={
          <a
            href="https://console.twilio.com/us1/monitor/usage/summary"
            target="_blank"
            rel="noreferrer"
            className="flex items-center gap-1.5 rounded-sm border border-border bg-card px-3 py-2 text-xs uppercase tracking-wider hover:bg-accent"
          >
            Twilio billing <ExternalLink size={12} />
          </a>
        }
      />

      <div className="grid gap-4 p-5 md:grid-cols-4 md:p-8">
        <StatCard icon={<Phone size={18} />} label="Numbers" value={data?.numberCount ?? 0} sub={data ? `${data.activeCount} active` : "active tenants"} />
        <StatCard
          icon={<AlertTriangle size={18} />}
          label="Churned"
          value={data?.churnedCount ?? 0}
          sub={data ? `${fmtUsd(data.churnedMonthlyWasteUsd)}/mo waste` : ""}
          tone={data && data.churnedCount > 0 ? "warn" : undefined}
        />
        <StatCard
          icon={<DollarSign size={18} />}
          label="Est. monthly base"
          value={data ? fmtUsd(data.totalEstimatedMonthlyUsd) : "—"}
          sub={data ? `${fmtUsd(data.baseMonthlyUsd)} × numbers` : ""}
        />
        <StatCard
          icon={<MessageSquare size={18} />}
          label="Messages MTD"
          value={data?.totalMessagesThisMonth ?? 0}
          sub="outbound sent"
        />
      </div>

      <div className="px-5 pb-8 md:px-8">
        <div className="panel overflow-hidden">
          <div className="flex items-center gap-2 border-b border-border bg-card px-5 py-3">
            <Shield size={14} className="text-orange" />
            <div className="label-eyebrow">Tenant roster</div>
          </div>
          {isLoading ? (
            <div className="p-6 text-sm text-muted-foreground">Loading…</div>
          ) : (data?.rows.length ?? 0) === 0 ? (
            <div className="p-6 text-sm text-muted-foreground">No numbers provisioned yet.</div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border bg-background">
                    <Th>Business</Th>
                    <Th>Status</Th>
                    <Th>Number</Th>
                    <Th>Provisioned</Th>
                    <Th className="text-right">Msgs MTD</Th>
                    <Th className="text-right">Base cost</Th>
                  </tr>
                </thead>
                <tbody>
                  {data!.rows.map((r) => (
                    <tr
                      key={r.userId}
                      className={`border-b border-border/50 last:border-0 ${r.isChurned ? "bg-orange/5" : ""}`}
                    >
                      <Td>
                        <div className="font-display text-base uppercase">{r.businessName}</div>
                        <div className="mono text-[10px] uppercase tracking-widest text-muted-foreground">{r.email ?? "—"}</div>
                      </Td>
                      <Td><StatusBadge status={r.subscriptionStatus} churned={r.isChurned} /></Td>
                      <Td><span className="mono">{r.phoneNumber}</span></Td>
                      <Td><span className="mono text-xs">{fmtDate(r.provisionedAt)}</span></Td>
                      <Td className="text-right"><span className="mono">{r.messagesThisMonth}</span></Td>
                      <Td className="text-right"><span className="mono">{fmtUsd(r.estimatedMonthlyUsd)}</span></Td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
        <p className="mono mt-3 text-[10px] uppercase tracking-widest text-muted-foreground">
          Churned rows are still incurring Twilio rental until released. Base cost estimate ≈ $1.15/mo per US local number — Twilio console is the billing source of truth.
        </p>
      </div>
    </div>
  );
}

function StatusBadge({ status, churned }: { status: string; churned: boolean }) {
  const label = status.replace(/_/g, " ");
  const cls = churned
    ? "border-orange/50 bg-orange/10 text-orange"
    : status === "active"
    ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-400"
    : "border-border bg-card text-muted-foreground";
  return (
    <span className={`mono inline-block rounded-sm border px-2 py-0.5 text-[10px] uppercase tracking-widest ${cls}`}>
      {label}
    </span>
  );
}

function StatCard({
  icon, label, value, sub, tone,
}: { icon: React.ReactNode; label: string; value: React.ReactNode; sub?: string; tone?: "warn" }) {
  return (
    <div className={`panel p-5 ${tone === "warn" ? "border-orange/40 bg-orange/5" : ""}`}>
      <div className={`flex items-center gap-2 ${tone === "warn" ? "text-orange" : "text-muted-foreground"}`}>
        {icon}
        <span className="label-eyebrow">{label}</span>
      </div>
      <div className="mt-2 font-display text-3xl">{value}</div>
      {sub ? <div className="mono mt-1 text-[10px] uppercase tracking-widest text-muted-foreground">{sub}</div> : null}
    </div>
  );
}

function Th({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return <th className={`label-eyebrow px-5 py-3 text-left ${className}`}>{children}</th>;
}
function Td({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return <td className={`px-5 py-3 align-top ${className}`}>{children}</td>;
}
