import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useState } from "react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { PageHeader } from "@/components/AppShell";
import { getDepositRecoveryStats, type RecoveryAction } from "@/lib/deposit-jump-analytics.functions";
import { Shield, Timer, MousePointerClick } from "lucide-react";

export const Route = createFileRoute("/_authenticated/dashboard/admin/deposit-recovery")({
  component: AdminDepositRecoveryPage,
  head: () => ({
    meta: [
      { title: "Deposit recovery analytics · Temaro operator" },
      {
        name: "description",
        content:
          "Operator view of deposit deep-link recovery actions and how long readers hesitate before recovering from a missed link.",
      },
      { property: "og:title", content: "Deposit recovery analytics · Temaro operator" },
      {
        property: "og:description",
        content: "Recovery action counts and hesitation-time distribution for deposit deep links.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
});

const ACTION_LABEL: Record<RecoveryAction, string> = {
  return_to_top: "Return to top",
  show_latest: "Show latest",
  clear_filters: "Clear filters",
  dismiss: "Dismiss",
  retry_jump: "Retry jump",
};

const ACTION_COLOR: Record<RecoveryAction, string> = {
  return_to_top: "hsl(var(--orange))",
  show_latest: "hsl(var(--primary))",
  clear_filters: "hsl(var(--steel))",
  dismiss: "hsl(var(--moss))",
  retry_jump: "hsl(var(--violet))",
};


const fmtMs = (ms: number | null) =>
  ms == null ? "—" : ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`;

const WINDOWS = [7, 30, 90] as const;

function AdminDepositRecoveryPage() {
  const [days, setDays] = useState<number>(30);
  const statsFn = useServerFn(getDepositRecoveryStats);
  const { data, isLoading, error } = useQuery({
    queryKey: ["admin", "deposit-recovery", days],
    queryFn: () => statsFn({ data: { days } }),
    retry: false,
  });

  if (error) {
    const msg = (error as Error).message;
    const forbidden = /forbidden/i.test(msg);
    return (
      <div>
        <PageHeader eyebrow="Operator · Restricted" title="Deposit recovery" />
        <div className="p-5 md:p-8">
          <div className="panel border-orange/40 bg-orange/5 p-6">
            <div className="label-eyebrow text-orange">{forbidden ? "Access denied" : "Error"}</div>
            <p className="mt-2 text-sm text-muted-foreground">
              {forbidden ? "This page is restricted to Temaro operators." : msg}
            </p>
          </div>
        </div>
      </div>
    );
  }

  const maxAction = Math.max(1, ...(data?.byAction.map((a) => a.count) ?? [1]));

  return (
    <div>
      <PageHeader
        eyebrow="Operator · Analytics"
        title="Deposit recovery"
        actions={
          <div className="flex items-center gap-1">
            {WINDOWS.map((w) => (
              <button
                key={w}
                type="button"
                onClick={() => setDays(w)}
                aria-pressed={days === w}
                className={`rounded-sm border px-3 py-2 text-xs uppercase tracking-wider ${
                  days === w
                    ? "border-primary bg-primary/15 text-foreground"
                    : "border-border bg-card text-muted-foreground hover:bg-accent"
                }`}
              >
                {w}d
              </button>
            ))}
          </div>
        }
      />

      <div className="space-y-5 p-5 md:p-8">
        <p className="flex items-center gap-2 text-xs uppercase tracking-wider text-muted-foreground">
          <Shield size={13} className="text-orange" />
          deposit_jump_recovery · last {data?.days ?? days} days
        </p>

        {isLoading ? (
          <div className="panel p-6 text-sm text-muted-foreground">Loading dispatch analytics…</div>
        ) : !data ? null : (
          <>
            {/* Summary */}
            <div className="grid gap-3 sm:grid-cols-4">
              <SummaryTile
                icon={<MousePointerClick size={14} />}
                label="Recovery actions"
                value={String(data.total)}
              />
              <SummaryTile
                icon={<Timer size={14} />}
                label="Median hesitation"
                value={fmtMs(data.overall.medianMs)}
              />
              <SummaryTile icon={<Timer size={14} />} label="p90" value={fmtMs(data.overall.p90Ms)} />
              <SummaryTile
                icon={<Timer size={14} />}
                label="Average"
                value={fmtMs(data.overall.avgMs)}
              />
            </div>

            {/* Counts by action */}
            <section className="panel p-5">
              <h2 className="label-eyebrow">Counts by action</h2>
              {data.total === 0 ? (
                <p className="mt-3 text-sm text-muted-foreground">
                  No recovery actions recorded in this window.
                </p>
              ) : (
                <div className="mt-4 space-y-3">
                  {data.byAction.map((a) => (
                    <div key={a.action}>
                      <div className="flex items-baseline justify-between text-sm">
                        <span className="uppercase tracking-wider">{ACTION_LABEL[a.action]}</span>
                        <span className="font-mono text-xs text-muted-foreground">
                          {a.count} · median {fmtMs(a.medianMs)} · p90 {fmtMs(a.p90Ms)}
                        </span>
                      </div>
                      <div className="mt-1 h-2 w-full rounded-sm bg-muted">
                        <div
                          className="h-2 rounded-sm"
                          style={{
                            width: `${(a.count / maxAction) * 100}%`,
                            background: ACTION_COLOR[a.action],
                          }}
                        />
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </section>

            {/* Histogram */}
            <section className="panel p-5">
              <h2 className="label-eyebrow">ms_since_miss distribution</h2>
              <div className="mt-4 h-64 w-full">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={data.histogram}>
                    <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" vertical={false} />
                    <XAxis
                      dataKey="label"
                      tick={{ fontSize: 11 }}
                      stroke="hsl(var(--muted-foreground))"
                    />
                    <YAxis allowDecimals={false} tick={{ fontSize: 11 }} stroke="hsl(var(--muted-foreground))" />
                    <Tooltip
                      contentStyle={{
                        background: "hsl(var(--card))",
                        border: "1px solid hsl(var(--border))",
                        fontSize: 12,
                      }}
                    />
                    <Bar dataKey="count" name="events" radius={[2, 2, 0, 0]}>
                      {data.histogram.map((b) => (
                        <Cell key={b.label} fill="hsl(var(--primary))" />
                      ))}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </section>

            {/* Recent log */}
            <section className="panel p-5">
              <h2 className="label-eyebrow">Recent entries</h2>
              <div className="mt-3 overflow-x-auto">
                <table className="w-full text-left text-xs">
                  <thead className="text-muted-foreground">
                    <tr className="uppercase tracking-wider">
                      <th className="py-2 pr-4">When</th>
                      <th className="py-2 pr-4">Action</th>
                      <th className="py-2 pr-4">ms since miss</th>
                      <th className="py-2 pr-4">Requested id</th>
                      <th className="py-2">Reason</th>
                    </tr>
                  </thead>
                  <tbody className="font-mono">
                    {data.recent.length === 0 ? (
                      <tr>
                        <td colSpan={5} className="py-3 text-muted-foreground">
                          No entries.
                        </td>
                      </tr>
                    ) : (
                      data.recent.map((r) => (
                        <tr key={r.id} className="border-t border-border/60">
                          <td className="py-2 pr-4">{new Date(r.occurredAt).toLocaleString()}</td>
                          <td className="py-2 pr-4" style={{ color: ACTION_COLOR[r.action] }}>
                            {r.action}
                          </td>
                          <td className="py-2 pr-4">{r.msSinceMiss ?? "—"}</td>
                          <td className="py-2 pr-4 break-all">{r.eventId ?? "—"}</td>
                          <td className="py-2">{r.reason ?? "—"}</td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            </section>
          </>
        )}
      </div>
    </div>
  );
}

function SummaryTile({
  icon,
  label,
  value,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
}) {
  return (
    <div className="panel p-4">
      <div className="flex items-center gap-2 text-[11px] uppercase tracking-wider text-muted-foreground">
        {icon} {label}
      </div>
      <div className="mt-1 font-mono text-xl">{value}</div>
    </div>
  );
}
