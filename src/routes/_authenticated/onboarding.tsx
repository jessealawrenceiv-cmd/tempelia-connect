import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { PageHeader } from "@/components/AppShell";
import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";

export const Route = createFileRoute("/_authenticated/onboarding")({
  component: OnboardingPage,
});

function OnboardingPage() {
  const navigate = useNavigate();
  const [reviewUrl, setReviewUrl] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    (async () => {
      const { data: u } = await supabase.auth.getUser();
      if (!u.user) return;
      const { data } = await supabase.from("integrations").select("*").eq("user_id", u.user.id).maybeSingle();
      if (data) setReviewUrl(data.google_review_url ?? "");
    })();
  }, []);

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
      <PageHeader eyebrow="Setup · Step 1" title="Add your review link" />
      <div className="mx-auto max-w-2xl p-5 md:p-8">
        <div className="panel p-6">
          <p className="text-sm text-muted-foreground">
            Tempelia sends SMS from a shared, compliance-vetted number — no Twilio setup required.
            Paste your Google review link so the "review request" texts point customers to your listing.
          </p>
          <div className="mt-6 space-y-4">
            <label className="block">
              <span className="label-eyebrow">Google Review URL</span>
              <input
                value={reviewUrl}
                onChange={(e) => setReviewUrl(e.target.value)}
                placeholder="https://g.page/r/…"
                className="mono mt-1 block w-full rounded-sm border border-border bg-background px-3 py-2 text-sm"
              />
            </label>
          </div>
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
