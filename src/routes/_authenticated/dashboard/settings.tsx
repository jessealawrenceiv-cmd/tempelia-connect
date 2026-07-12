import { createFileRoute } from "@tanstack/react-router";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { PageHeader } from "@/components/AppShell";
import { ExcludedNumbersPanel } from "@/components/ExcludedNumbersPanel";

import { useEffect, useState } from "react";
import { toast } from "sonner";

export const Route = createFileRoute("/_authenticated/dashboard/settings")({
  component: SettingsPage,
});

function SettingsPage() {
  const qc = useQueryClient();
  const [reviewUrl, setReviewUrl] = useState("");

  const { data: profile } = useQuery({
    queryKey: ["profile"],
    queryFn: async () => {
      const { data: u } = await supabase.auth.getUser();
      if (!u.user) return null;
      const { data } = await supabase.from("profiles").select("*").eq("id", u.user.id).maybeSingle();
      return data;
    },
  });

  const { data: intg } = useQuery({
    queryKey: ["integrations"],
    queryFn: async () => {
      const { data: u } = await supabase.auth.getUser();
      if (!u.user) return null;
      const { data } = await supabase.from("integrations").select("*").eq("user_id", u.user.id).maybeSingle();
      return data;
    },
  });

  useEffect(() => {
    if (intg) setReviewUrl(intg.google_review_url ?? "");
  }, [intg]);

  const save = useMutation({
    mutationFn: async () => {
      const { data: u } = await supabase.auth.getUser();
      if (!u.user) throw new Error("Not signed in");
      const { error } = await supabase.from("integrations").upsert(
        { user_id: u.user.id, google_review_url: reviewUrl || null },
        { onConflict: "user_id" },
      );
      if (error) throw error;
    },
    onSuccess: () => { toast.success("Settings saved."); qc.invalidateQueries({ queryKey: ["integrations"] }); },
    onError: (e: Error) => toast.error(e.message),
  });

  const toggleReviews = useMutation({
    mutationFn: async (enabled: boolean) => {
      const { data: u } = await supabase.auth.getUser();
      if (!u.user) throw new Error("Not signed in");
      const { error } = await supabase.from("profiles")
        .update({ review_requests_enabled: enabled }).eq("id", u.user.id);
      if (error) throw error;
    },
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["profile"] }); },
    onError: (e: Error) => toast.error(e.message),
  });


  return (
    <div>
      <PageHeader eyebrow="Config" title="Settings" />
      <div className="grid gap-5 p-5 md:grid-cols-2 md:p-8">
        <div className="panel p-6">
          <div className="label-eyebrow">Integrations</div>
          <h2 className="mt-1 text-xl">Google review link & Tempelia number</h2>
          <p className="mt-2 text-xs text-muted-foreground">
            Your dedicated line:{" "}
            <span className="mono">{profile?.twilio_phone_number ?? "not provisioned yet — visit onboarding"}</span>
          </p>
          <div className="mt-4 space-y-3">
            <label className="block">
              <span className="label-eyebrow">Google Review URL</span>
              <input
                value={reviewUrl}
                onChange={(e) => setReviewUrl(e.target.value)}
                placeholder="https://g.page/r/…"
                className="mono mt-1 block w-full rounded-sm border border-border bg-background px-3 py-2 text-sm"
              />
            </label>
            <button
              onClick={() => save.mutate()}
              disabled={save.isPending}
              className="w-full rounded-sm bg-orange px-4 py-3 text-sm font-medium uppercase tracking-wider text-orange-foreground hover:opacity-90 disabled:opacity-50"
            >{save.isPending ? "Saving…" : "Save"}</button>
          </div>
        </div>

        <div className="panel p-6">
          <div className="label-eyebrow">Billing</div>
          <h2 className="mt-1 text-xl">Subscription</h2>
          <div className="mt-4 space-y-3 text-sm">
            <Row k="Tier" v={<span className="mono uppercase">{profile?.subscription_tier ?? "starter"}</span>} />
            <Row k="Status" v={<span className="mono uppercase">{profile?.subscription_status ?? "trialing"}</span>} />
          </div>
          <button
            disabled
            className="mt-6 w-full rounded-sm border border-border bg-card px-4 py-3 text-sm uppercase tracking-wider text-muted-foreground"
            title="Available once Stripe billing is enabled"
          >
            Open Stripe customer portal (coming)
          </button>
          <p className="mono mt-3 text-[10px] uppercase tracking-widest text-muted-foreground">
            Stripe checkout & portal wire up in Phase 2.
          </p>
        </div>

        <ExcludedNumbersPanel />

        <div className="panel p-6 md:col-span-2">

          <div className="label-eyebrow">Compliance</div>
          <ul className="mono mt-3 space-y-2 text-xs text-muted-foreground">
            <li>· Every outbound SMS ends with "Reply STOP to unsubscribe."</li>
            <li>· No text is sent unless opt_in_consent = true. Otherwise flagged as needs-consent.</li>
            <li>· ToS accepted on signup: {profile?.tos_accepted_at ? new Date(profile.tos_accepted_at).toLocaleString() : "—"}</li>
            <li>· No review gating — every completed job receives the same review request.</li>
          </ul>
        </div>
      </div>
    </div>
  );
}

function Row({ k, v }: { k: string; v: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between border-b border-border pb-2">
      <span className="label-eyebrow">{k}</span>
      <span>{v}</span>
    </div>
  );
}
