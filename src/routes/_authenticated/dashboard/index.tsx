import { createFileRoute } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { PageHeader } from "@/components/AppShell";
import { PhoneMissed, Star, ThumbsUp, Snowflake } from "lucide-react";
import { DispatchLog } from "@/components/DispatchLog";

export const Route = createFileRoute("/_authenticated/dashboard/")({
  component: OverviewPage,
});

function OverviewPage() {
  const qc = useQueryClient();
  const { data: stats } = useQuery({
    queryKey: ["stats"],
    queryFn: async () => {
      const start = new Date(); start.setDate(1); start.setHours(0, 0, 0, 0);
      const iso = start.toISOString();
      const { data } = await supabase
        .from("logs")
        .select("action_type")
        .gte("created_at", iso);
      const rows = data ?? [];
      return {
        calls: rows.filter((r) => r.action_type === "missed_call_text").length,
        reviews: rows.filter((r) => r.action_type === "review_request").length,
        reactivations: rows.filter((r) => r.action_type === "reactivation_text").length,
      };
    },
  });

  void qc;

  return (
    <div>
      <PageHeader eyebrow="Ops · This month" title="Overview" />

      <div className="grid gap-4 p-5 md:grid-cols-4 md:p-8">
        <StatCard tone="orange" icon={<PhoneMissed size={18} />} label="Calls captured" value={stats?.calls ?? 0} />
        <StatCard tone="steel" icon={<Star size={18} />} label="Reviews sent" value={stats?.reviews ?? 0} />
        <StatCard tone="moss" icon={<ThumbsUp size={18} />} label="5-star reviews" value={0} note="Live count coming with Google integration" />
        <StatCard tone="charcoal" icon={<Snowflake size={18} />} label="Leads reactivated" value={stats?.reactivations ?? 0} />
      </div>

      <div className="px-5 pb-10 md:px-8">
        <DispatchLog />
      </div>
    </div>
  );
}

function StatCard({ tone, icon, label, value, note }: { tone: "orange" | "steel" | "moss" | "charcoal"; icon: React.ReactNode; label: string; value: number; note?: string }) {
  const bar = { orange: "bg-orange", steel: "bg-steel", moss: "bg-moss", charcoal: "bg-charcoal" }[tone];
  return (
    <div className="panel relative overflow-hidden p-5">
      <div className={`absolute inset-x-0 top-0 h-1 ${bar}`} />
      <div className="flex items-center justify-between">
        <div className="label-eyebrow">{label}</div>
        <span className="text-muted-foreground">{icon}</span>
      </div>
      <div className="stat-num mt-3 text-foreground">{value}</div>
      {note ? <div className="mono mt-2 text-[10px] uppercase tracking-widest text-muted-foreground">{note}</div> : null}
    </div>
  );
}
