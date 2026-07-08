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
  const [sid, setSid] = useState("");
  const [token, setToken] = useState("");
  const [phone, setPhone] = useState("");
  const [reviewUrl, setReviewUrl] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    (async () => {
      const { data: u } = await supabase.auth.getUser();
      if (!u.user) return;
      const { data } = await supabase.from("integrations").select("*").eq("user_id", u.user.id).maybeSingle();
      if (data) {
        setSid(data.twilio_account_sid ?? "");
        setPhone(data.twilio_phone_number ?? "");
        setReviewUrl(data.google_review_url ?? "");
      }
    })();
  }, []);

  async function save() {
    setSaving(true);
    try {
      const { data: u } = await supabase.auth.getUser();
      if (!u.user) throw new Error("Not signed in");
      const payload = {
        user_id: u.user.id,
        twilio_account_sid: sid || null,
        twilio_phone_number: phone || null,
        google_review_url: reviewUrl || null,
        ...(token ? { twilio_auth_token: token } : {}),
      };
      const { error } = await supabase.from("integrations").upsert(payload, { onConflict: "user_id" });
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
      <PageHeader eyebrow="Setup · Step 1" title="Connect your lines" />
      <div className="mx-auto max-w-2xl p-5 md:p-8">
        <div className="panel p-6">
          <p className="text-sm text-muted-foreground">
            Paste your Twilio credentials and Google review link. You can update these anytime
            in Settings.
          </p>
          <div className="mt-6 space-y-4">
            <Field label="Twilio Account SID" value={sid} onChange={setSid} placeholder="ACxxxx…" />
            <Field label="Twilio Auth Token" type="password" value={token} onChange={setToken} placeholder="your auth token" />
            <Field label="Twilio Phone Number (E.164)" value={phone} onChange={setPhone} placeholder="+15551234567" />
            <Field label="Google Review URL" value={reviewUrl} onChange={setReviewUrl} placeholder="https://g.page/r/…" />
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

function Field({ label, value, onChange, ...rest }: { label: string; value: string; onChange: (v: string) => void } & Omit<React.InputHTMLAttributes<HTMLInputElement>, "value" | "onChange">) {
  return (
    <label className="block">
      <span className="label-eyebrow">{label}</span>
      <input {...rest} value={value} onChange={(e) => onChange(e.target.value)} className="mono mt-1 block w-full rounded-sm border border-border bg-background px-3 py-2 text-sm" />
    </label>
  );
}
