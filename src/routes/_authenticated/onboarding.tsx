import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { PageHeader } from "@/components/AppShell";
import { useEffect, useRef, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import { provisionTenantNumber } from "@/lib/twilio-provision.functions";

export const Route = createFileRoute("/_authenticated/onboarding")({
  component: OnboardingPage,
});

type ProvisionState =
  | { status: "idle" }
  | { status: "working" }
  | { status: "ready"; phoneNumber: string }
  | { status: "error"; message: string };

function OnboardingPage() {
  const navigate = useNavigate();
  const [reviewUrl, setReviewUrl] = useState("");
  const [saving, setSaving] = useState(false);
  const [prov, setProv] = useState<ProvisionState>({ status: "idle" });
  const started = useRef(false);

  const provisionFn = useServerFn(provisionTenantNumber);

  // Auto-provision on mount — no user input required.
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    (async () => {
      const { data: u } = await supabase.auth.getUser();
      if (!u.user) return;
      const { data } = await supabase.from("integrations").select("*").eq("user_id", u.user.id).maybeSingle();
      if (data) setReviewUrl(data.google_review_url ?? "");

      setProv({ status: "working" });
      try {
        const res = await provisionFn({ data: {} });
        if (!res.ok) {
          setProv({ status: "error", message: res.message });
          return;
        }
        setProv({ status: "ready", phoneNumber: res.phoneNumber });
      } catch (e) {
        setProv({ status: "error", message: (e as Error).message });
      }
    })();
  }, [provisionFn]);

  async function retry() {
    setProv({ status: "working" });
    try {
      const res = await provisionFn({ data: {} });
      if (!res.ok) {
        setProv({ status: "error", message: res.message });
        return;
      }
      setProv({ status: "ready", phoneNumber: res.phoneNumber });
    } catch (e) {
      setProv({ status: "error", message: (e as Error).message });
    }
  }

  async function save() {
    setSaving(true);
    try {
      const { data: u } = await supabase.auth.getUser();
      if (!u.user) throw new Error("Not signed in");
      const { error } = await supabase.from("integrations").upsert(
        { user_id: u.user.id, google_review_url: reviewUrl || null },
        { onConflict: "user_id" },
      );
      if (error) throw error;
      toast.success("You're all set.");
      navigate({ to: "/dashboard" });
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div>
      <PageHeader eyebrow="Setup" title="Welcome to Temora" />
      <div className="mx-auto max-w-2xl space-y-5 p-5 md:p-8">
        <div className="panel p-6">
          <div className="label-eyebrow">Step 1 · Dedicated number</div>
          <h2 className="mt-1 text-xl">Your Temora line</h2>
          <p className="mt-2 text-sm text-muted-foreground">
            We automatically buy a local Twilio number under Temora's master account and wire it up
            for missed-call auto-texts, review requests, and STOP/START compliance.
          </p>

          {prov.status === "working" && (
            <div className="mono mt-4 flex items-center gap-3 rounded-sm border border-border bg-background p-4 text-xs uppercase tracking-wider text-muted-foreground">
              <span className="h-2 w-2 animate-pulse rounded-full bg-orange" />
              Provisioning your number…
            </div>
          )}

          {prov.status === "ready" && (
            <div className="mt-4 rounded-sm border border-moss/40 bg-moss/10 p-4">
              <div className="label-eyebrow text-moss">Provisioned</div>
              <div className="mono mt-1 text-lg">{prov.phoneNumber}</div>
              <p className="mt-2 text-xs text-muted-foreground">
                Forward missed calls from your business line to this number in your carrier settings.
              </p>
            </div>
          )}

          {prov.status === "error" && (
            <div className="mt-4 rounded-sm border border-orange/40 bg-orange/10 p-4">
              <div className="label-eyebrow text-orange">Provisioning failed</div>
              <p className="mono mt-2 text-xs text-muted-foreground">{prov.message}</p>
              <button
                onClick={retry}
                className="mt-3 rounded-sm border border-border bg-card px-3 py-2 text-xs uppercase tracking-wider hover:bg-accent"
              >Retry</button>
            </div>
          )}
        </div>

        <div className="panel p-6">
          <div className="label-eyebrow">Step 2 · Review link</div>
          <h2 className="mt-1 text-xl">Where should we send reviewers?</h2>
          <label className="mt-4 block">
            <span className="label-eyebrow">Google Review URL</span>
            <input
              value={reviewUrl}
              onChange={(e) => setReviewUrl(e.target.value)}
              placeholder="https://g.page/r/…"
              className="mono mt-1 block w-full rounded-sm border border-border bg-background px-3 py-2 text-sm"
            />
          </label>
          <div className="mt-6 flex gap-3">
            <button
              onClick={() => navigate({ to: "/dashboard" })}
              className="rounded-sm border border-border bg-card px-4 py-3 text-sm uppercase tracking-wider text-muted-foreground hover:bg-accent"
            >Skip for now</button>
            <button
              onClick={save}
              disabled={saving}
              className="flex-1 rounded-sm bg-orange px-4 py-3 text-sm font-medium uppercase tracking-wider text-orange-foreground hover:opacity-90 disabled:opacity-50"
            >{saving ? "Saving…" : "Save & continue"}</button>
          </div>
        </div>
      </div>
    </div>
  );
}
