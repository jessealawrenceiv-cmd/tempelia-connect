import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { PageHeader } from "@/components/AppShell";
import { useEffect, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import { provisionTenantNumber, getTenantNumber } from "@/lib/twilio-provision.functions";

export const Route = createFileRoute("/_authenticated/onboarding")({
  component: OnboardingPage,
});

function OnboardingPage() {
  const navigate = useNavigate();
  const [reviewUrl, setReviewUrl] = useState("");
  const [areaCode, setAreaCode] = useState("");
  const [saving, setSaving] = useState(false);
  const [provisioning, setProvisioning] = useState(false);
  const [tenantNumber, setTenantNumber] = useState<string | null>(null);

  const provisionFn = useServerFn(provisionTenantNumber);
  const getNumberFn = useServerFn(getTenantNumber);

  useEffect(() => {
    (async () => {
      const { data: u } = await supabase.auth.getUser();
      if (!u.user) return;
      const { data } = await supabase.from("integrations").select("*").eq("user_id", u.user.id).maybeSingle();
      if (data) setReviewUrl(data.google_review_url ?? "");
      try {
        const info = await getNumberFn();
        setTenantNumber(info.phoneNumber);
      } catch {
        /* noop */
      }
    })();
  }, [getNumberFn]);

  async function provision() {
    setProvisioning(true);
    try {
      const res = await provisionFn({ data: { areaCode } });
      setTenantNumber(res.phoneNumber);
      toast.success(res.alreadyProvisioned ? "Number already provisioned." : `Your number: ${res.phoneNumber}`);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setProvisioning(false);
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
      toast.success("Onboarding complete.");
      navigate({ to: "/dashboard" });
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div>
      <PageHeader eyebrow="Setup" title="Get your Tempelia number" />
      <div className="mx-auto max-w-2xl space-y-5 p-5 md:p-8">
        <div className="panel p-6">
          <div className="label-eyebrow">Step 1 · Dedicated number</div>
          <h2 className="mt-1 text-xl">Provision your business line</h2>
          <p className="mt-2 text-sm text-muted-foreground">
            We'll buy a local Twilio number under Tempelia's master account and wire it up for
            missed-call auto-texts, review requests, and STOP/START compliance. One number per business.
          </p>
          {tenantNumber ? (
            <div className="mt-4 rounded-sm border border-moss/40 bg-moss/10 p-4">
              <div className="label-eyebrow text-moss">Provisioned</div>
              <div className="mono mt-1 text-lg">{tenantNumber}</div>
              <p className="mt-2 text-xs text-muted-foreground">
                Forward missed calls from your business line to this number in your carrier settings.
              </p>
            </div>
          ) : (
            <div className="mt-4 space-y-3">
              <label className="block">
                <span className="label-eyebrow">Preferred area code</span>
                <input
                  value={areaCode}
                  onChange={(e) => setAreaCode(e.target.value.replace(/\D/g, "").slice(0, 3))}
                  placeholder="415"
                  inputMode="numeric"
                  className="mono mt-1 block w-full rounded-sm border border-border bg-background px-3 py-2 text-sm"
                />
              </label>
              <button
                onClick={provision}
                disabled={provisioning || areaCode.length !== 3}
                className="w-full rounded-sm bg-orange px-4 py-3 text-sm font-medium uppercase tracking-wider text-orange-foreground hover:opacity-90 disabled:opacity-50"
              >
                {provisioning ? "Searching Twilio…" : "Provision number"}
              </button>
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
