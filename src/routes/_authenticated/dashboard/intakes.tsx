import { createFileRoute, Link } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { PageHeader } from "@/components/AppShell";
import { signIntakePhotos } from "@/lib/intake.functions";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";

export const Route = createFileRoute("/_authenticated/dashboard/intakes")({
  component: IntakesPage,
});

const STATUSES = ["new", "contacted", "quoted", "closed"] as const;

function IntakesPage() {
  const qc = useQueryClient();
  const sign = useServerFn(signIntakePhotos);
  const [publicUrl, setPublicUrl] = useState("");

  const { data: user } = useQuery({
    queryKey: ["me-id"],
    queryFn: async () => (await supabase.auth.getUser()).data.user,
  });

  useEffect(() => {
    if (user) setPublicUrl(`${window.location.origin}/intake/${user.id}`);
  }, [user]);

  const { data: rows, isLoading } = useQuery({
    queryKey: ["intake-submissions"],
    refetchOnWindowFocus: true,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("intake_submissions")
        .select("*")
        .order("submitted_at", { ascending: false });
      if (error) throw error;
      return data ?? [];
    },
  });

  // Live updates: push new/changed intake rows into the list without a reload.
  useEffect(() => {
    if (!user) return;
    const channel = supabase
      .channel("intake_submissions:dashboard")
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "intake_submissions", filter: `user_id=eq.${user.id}` },
        () => qc.invalidateQueries({ queryKey: ["intake-submissions"] }),
      )
      .subscribe();
    return () => { supabase.removeChannel(channel); };
  }, [user, qc]);

  const allPaths = useMemo(
    () => (rows ?? []).flatMap((r) => r.photo_urls ?? []),
    [rows],
  );

  const { data: signed } = useQuery({
    queryKey: ["intake-photo-urls", allPaths],
    enabled: allPaths.length > 0,
    queryFn: async () => (await sign({ data: { paths: allPaths } })).urls,
  });

  const updateStatus = useMutation({
    mutationFn: async ({ id, status }: { id: string; status: string }) => {
      const { error } = await supabase.from("intake_submissions").update({ status }).eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Status updated");
      qc.invalidateQueries({ queryKey: ["intake-submissions"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <div>
      <PageHeader eyebrow="Feature 04" title="Project intakes" />
      <div className="p-5 md:p-8 space-y-5">
        <div className="panel p-4">
          <div className="flex items-center justify-between gap-3">
            <div className="mono text-[10px] uppercase tracking-widest text-muted-foreground">// public intake URL</div>
            <IntakeEnabledToggle />
          </div>
          <div className="mt-2 flex items-center gap-2">
            <input readOnly value={publicUrl} className="flex-1 rounded-sm border border-border bg-background px-3 py-2 text-sm mono" />
            <button
              onClick={() => { navigator.clipboard.writeText(publicUrl); toast.success("Copied"); }}
              className="rounded-sm bg-violet px-3 py-2 text-xs font-display uppercase tracking-wider text-paper"
            >Copy</button>
          </div>
          <p className="mt-2 text-xs text-muted-foreground">Share this link with prospects. Submissions land here.</p>
        </div>

        {isLoading && <div className="text-muted-foreground">Loading…</div>}
        {!isLoading && rows?.length === 0 && (
          <div className="panel p-6 text-muted-foreground text-sm">No submissions yet. Share your intake URL above.</div>
        )}

        <div className="space-y-4">
          {rows?.map((r) => {
            const resp = (r.responses ?? {}) as Record<string, string>;
            return (
              <div key={r.id} className="panel p-5">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <div className="mono text-[10px] uppercase tracking-widest text-muted-foreground">
                      {new Date(r.submitted_at).toLocaleString()}
                    </div>
                    <h3 className="font-display text-xl uppercase mt-1">
                      {r.customer_first_name} {r.customer_last_name}
                    </h3>
                    <div className="mono text-xs text-muted-foreground mt-1">
                      {r.customer_phone}{r.customer_email && ` · ${r.customer_email}`}
                      {r.customer_business_name && ` · ${r.customer_business_name}`}
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <Link
                      to="/dashboard/schedule"
                      search={{
                        intakeId: r.id,
                        customerId: r.customer_id ?? undefined,
                        firstName: r.customer_first_name,
                        lastName: r.customer_last_name,
                        phone: r.customer_phone,
                        title: `Site visit — ${r.customer_first_name} ${r.customer_last_name}`.trim(),
                      }}
                      className="mono rounded-sm border border-moss/60 px-2 py-1 text-[10px] uppercase tracking-wider text-moss hover:bg-moss hover:text-charcoal"
                    >
                      schedule visit
                    </Link>
                    <select
                      value={r.status}
                      onChange={(e) => updateStatus.mutate({ id: r.id, status: e.target.value })}
                      className="rounded-sm border border-border bg-background px-2 py-1 text-xs uppercase tracking-wider mono"
                    >
                      {STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
                    </select>
                  </div>
                </div>

                <dl className="mt-4 grid gap-x-4 gap-y-2 text-sm md:grid-cols-2">
                  {Object.entries(resp).map(([k, v]) => (
                    <div key={k}>
                      <dt className="label-eyebrow text-[10px] uppercase tracking-wider text-muted-foreground">{k.replace(/_/g, " ")}</dt>
                      <dd className="mono text-xs whitespace-pre-wrap">{String(v) || "—"}</dd>
                    </div>
                  ))}
                </dl>

                {(r.photo_urls?.length ?? 0) > 0 && (
                  <div className="mt-4 flex flex-wrap gap-2">
                    {r.photo_urls.map((p: string) => (
                      <a key={p} href={signed?.[p]} target="_blank" rel="noreferrer" className="block">
                        {signed?.[p] ? (
                          <img src={signed[p]} alt="" className="h-24 w-24 rounded-sm border border-border object-cover" />
                        ) : (
                          <div className="h-24 w-24 rounded-sm border border-border bg-muted" />
                        )}
                      </a>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function IntakeEnabledToggle() {
  const qc = useQueryClient();
  const { data: enabled } = useQuery({
    queryKey: ["intake-enabled"],
    queryFn: async () => {
      const { data: u } = await supabase.auth.getUser();
      if (!u.user) return true;
      const { data } = await supabase.from("profiles").select("intake_enabled").eq("id", u.user.id).maybeSingle();
      return data?.intake_enabled ?? true;
    },
  });
  const mut = useMutation({
    mutationFn: async (next: boolean) => {
      const { data: u } = await supabase.auth.getUser();
      if (!u.user) throw new Error("Not signed in");
      const { error } = await supabase.from("profiles").update({ intake_enabled: next }).eq("id", u.user.id);
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Updated");
      qc.invalidateQueries({ queryKey: ["intake-enabled"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });
  return (
    <label className="flex items-center gap-2 text-xs mono uppercase tracking-wider cursor-pointer">
      <span className={enabled ? "text-moss" : "text-muted-foreground"}>{enabled ? "accepting" : "paused"}</span>
      <input
        type="checkbox"
        checked={!!enabled}
        onChange={(e) => mut.mutate(e.target.checked)}
        className="h-4 w-4 accent-violet"
      />
    </label>
  );
}
