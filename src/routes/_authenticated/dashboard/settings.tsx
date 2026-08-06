import { createFileRoute } from "@tanstack/react-router";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { PageHeader } from "@/components/AppShell";
import { ExcludedNumbersPanel } from "@/components/ExcludedNumbersPanel";
import { TeamMembersPanel } from "@/components/TeamMembersPanel";
import { OptInPromptSettingsPanel } from "@/components/OptInPromptSettingsPanel";
import { WebhookCheckPanel } from "@/components/WebhookCheckPanel";
import { WebhookEventLogPanel } from "@/components/WebhookEventLogPanel";
import { DepositDefaultsPanel } from "@/components/DepositDefaultsPanel";
import { OnlinePaymentsPanel } from "@/components/OnlinePaymentsPanel";

import { useTeamRole } from "@/hooks/useTeamRole";
import { OPT_IN_PROMPT_REAL_SENDS_ENABLED } from "@/lib/opt-in-prompt-gate";

import { useEffect, useId, useRef, useState } from "react";
import { toast } from "sonner";

export const Route = createFileRoute("/_authenticated/dashboard/settings")({
  component: SettingsPage,
});

function SettingsPage() {
  const qc = useQueryClient();
  const { isStaff } = useTeamRole();
  const [tab, setTab] = useState<"settings" | "advanced">("settings");
  const [reviewUrl, setReviewUrl] = useState("");
  const [ownerPhone, setOwnerPhone] = useState("");

  const { data: profile, refetch: refetchProfile } = useQuery({
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

  useEffect(() => {
    if (profile) setOwnerPhone(profile.owner_phone ?? "");
  }, [profile]);

  const save = useMutation({
    mutationFn: async () => {
      const { data: u } = await supabase.auth.getUser();
      if (!u.user) throw new Error("Not signed in");
      const { error } = await supabase.from("integrations").upsert(
        { user_id: u.user.id, google_review_url: reviewUrl || null },
        { onConflict: "user_id" },
      );
      if (error) throw error;
      const { error: e2 } = await supabase.from("profiles")
        .update({ owner_phone: ownerPhone.trim() || null }).eq("id", u.user.id);
      if (e2) throw e2;
    },
    onSuccess: () => {
      toast.success("Settings saved.");
      qc.invalidateQueries({ queryKey: ["integrations"] });
      qc.invalidateQueries({ queryKey: ["profile"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const toggleVoicemail = useMutation({
    mutationFn: async (enabled: boolean) => {
      const { data: u } = await supabase.auth.getUser();
      if (!u.user) throw new Error("Not signed in");
      const { error } = await supabase.from("profiles")
        .update({ voicemail_enabled: enabled }).eq("id", u.user.id);
      if (error) throw error;
    },
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["profile"] }); },
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
  const setDeclineMode = useMutation({
    mutationFn: async (mode: "off" | "manual" | "auto") => {
      const { data: u } = await supabase.auth.getUser();
      if (!u.user) throw new Error("Not signed in");
      const { error } = await supabase.from("profiles")
        .update({ decline_followup_mode: mode }).eq("id", u.user.id);
      if (error) throw error;
    },
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["profile"] }); },
    onError: (e: Error) => toast.error(e.message),
  });

  const declineMode = (profile?.decline_followup_mode ?? "off") as "off" | "manual" | "auto";
  const optInPromptActive = OPT_IN_PROMPT_REAL_SENDS_ENABLED;
  const advancedActiveCount = [optInPromptActive].filter(Boolean).length;

  const [evaluatedAt, setEvaluatedAt] = useState<Date | null>(null);
  const [now, setNow] = useState<Date | null>(null);
  useEffect(() => {
    if (profile !== undefined) setEvaluatedAt(new Date());
  }, [profile]);
  useEffect(() => {
    setNow(new Date());
    const id = window.setInterval(() => setNow(new Date()), 60_000);
    return () => window.clearInterval(id);
  }, []);
  const evaluatedLabel = evaluatedAt
    ? evaluatedAt.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })
    : "—";
  const relativeLabel = evaluatedAt && now ? formatRelativeTime(evaluatedAt, now) : "—";

  const [isRefreshingStatuses, setIsRefreshingStatuses] = useState(false);
  const refreshStatuses = async () => {
    setIsRefreshingStatuses(true);
    try {
      await refetchProfile();
      const nowDate = new Date();
      setNow(nowDate);
      setEvaluatedAt(nowDate);
      toast.success("Automation statuses refreshed.");
    } catch (e) {
      toast.error((e as Error).message ?? "Refresh failed.");
    } finally {
      setIsRefreshingStatuses(false);
    }
  };

  const jumpToAdvanced = (anchorId: string) => {
    setTab("advanced");
    window.setTimeout(() => {
      const el = document.getElementById(anchorId);
      if (!el) return;
      el.scrollIntoView({ behavior: "smooth", block: "start" });
      el.classList.add("ring-1", "ring-orange");
      window.setTimeout(() => el.classList.remove("ring-1", "ring-orange"), 1800);
    }, 60);
  };

  const advancedAutomations: { name: string; mode: string; anchorId: string }[] = [
    { name: "Opt-in prompt & cooldown", mode: optInPromptActive ? "ACTIVE" : "ON HOLD", anchorId: "adv-opt-in-prompt" },
    { name: "Inbound webhook diagnostics", mode: "MANUAL TOOL", anchorId: "adv-webhook-diagnostics" },
  ];

  const advancedTooltip = (
    <div className="space-y-1">
      <div className="text-foreground">Advanced automations</div>
      {advancedAutomations.map((a) => (
        <button
          key={a.name}
          type="button"
          onClick={() => jumpToAdvanced(a.anchorId)}
          className="flex w-full items-center justify-between gap-3 rounded-sm px-1 py-0.5 text-left uppercase tracking-widest hover:bg-muted/30 hover:text-foreground"
        >
          <span className="underline decoration-dotted underline-offset-2">{a.name}</span>
          <span className="text-foreground">{a.mode}</span>
        </button>
      ))}
      <div className="border-t border-border pt-1">
        Last evaluated {relativeLabel} <span className="text-muted-foreground normal-case no-underline">({evaluatedLabel})</span>
      </div>
    </div>
  );



  if (isStaff) {
    return (
      <div>
        <PageHeader eyebrow="Config" title="Settings" />
        <div className="p-5 md:p-8">
          <div className="panel p-6">
            <div className="label-eyebrow">Restricted</div>
            <p className="mt-2 text-sm text-muted-foreground">
              Settings, billing and excluded numbers are available to the business owner only.
            </p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div>
      <PageHeader eyebrow="Config" title="Settings" />

      <div className="mono flex items-center gap-2 border-b border-border px-5 pt-5 text-[10px] uppercase tracking-widest md:px-8">
        {(["settings", "advanced"] as const).map((t) => (
          <button
            key={t}
            type="button"
            onClick={() => setTab(t)}
            className={`-mb-px rounded-t-sm border-b-2 px-3 py-2 ${
              tab === t
                ? "border-orange text-orange"
                : "border-transparent text-muted-foreground hover:text-foreground"
            }`}
          >
            {t === "settings" ? "Settings" : "Advanced"}
            {t === "advanced" && advancedActiveCount > 0 && (
              <span
                className="ml-2 inline-block h-1.5 w-1.5 rounded-full bg-moss align-middle"
                title={`${advancedActiveCount} automation(s) active`}
              />
            )}
          </button>
        ))}
      </div>

      {tab === "settings" && (
      <div className="grid gap-5 p-5 md:grid-cols-2 md:p-8">
        <div className="panel p-6">
          <div className="label-eyebrow">Integrations</div>
          <h2 className="mt-1 text-xl">Google review link & Temaro number</h2>
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

            <div className="mt-6 flex items-center justify-between border-t border-border pt-4">
              <div>
                <div className="label-eyebrow">Auto review requests</div>
                <p className="mt-1 text-xs text-muted-foreground">
                  When off, completed jobs are still recorded for revenue, but no review text is sent.
                </p>
              </div>
              <label className="mono flex cursor-pointer items-center gap-2 text-xs uppercase tracking-wider">
                <input
                  type="checkbox"
                  className="h-4 w-4 accent-primary"
                  checked={profile?.review_requests_enabled ?? true}
                  disabled={toggleReviews.isPending}
                  onChange={(e) => toggleReviews.mutate(e.target.checked)}
                />
                {profile?.review_requests_enabled === false ? "Off" : "On"}
              </label>
            </div>


            <div className="mt-6 border-t border-border pt-4">
              <div className="flex items-center justify-between">
                <div>
                  <div className="label-eyebrow">Voicemail on missed calls</div>
                  <p className="mt-1 text-xs text-muted-foreground">
                    When on, missed callers hear a short prompt and can leave a voicemail. Auto-text still fires either way.
                  </p>
                </div>
                <label className="mono flex cursor-pointer items-center gap-2 text-xs uppercase tracking-wider">
                  <input
                    type="checkbox"
                    className="h-4 w-4 accent-primary"
                    checked={profile?.voicemail_enabled ?? false}
                    disabled={toggleVoicemail.isPending}
                    onChange={(e) => toggleVoicemail.mutate(e.target.checked)}
                  />
                  {profile?.voicemail_enabled ? "On" : "Off"}
                </label>
              </div>
              <label className="mt-3 block">
                <span className="label-eyebrow">Owner mobile (voicemail alerts)</span>
                <input
                  value={ownerPhone}
                  onChange={(e) => setOwnerPhone(e.target.value)}
                  placeholder="+15551234567"
                  className="mono mt-1 block w-full rounded-sm border border-border bg-background px-3 py-2 text-sm"
                />
                {profile?.voicemail_enabled && !profile?.owner_phone && (
                  <p className="mt-1 text-xs text-orange">
                    ⚠ Voicemail is on but no owner phone is set — recordings are saved, but you won't get a text alert until you add a number and save.
                  </p>
                )}
                <p className="mt-1 text-[10px] uppercase tracking-widest text-muted-foreground mono">
                  Used only to text you when a voicemail lands. Press Save to store.
                </p>
              </label>
            </div>
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

        <OnlinePaymentsPanel
          stripe_connect_account_id={profile?.stripe_connect_account_id}
          stripe_connect_status={profile?.stripe_connect_status}
          platform_fee_percent={profile?.platform_fee_percent}
          stripe_connect_connected_at={profile?.stripe_connect_connected_at}
        />

        <DepositDefaultsPanel
          defaultType={profile?.default_deposit_type}
          defaultFixedAmount={profile?.default_deposit_fixed_amount}
          allowOverride={profile?.allow_deposit_override_per_quote}
        />

        <div className="panel p-6">
          <div className="flex items-start justify-between gap-3">
            <div>
              <div className="label-eyebrow">Automation</div>
              <h2 className="mt-1 text-xl">Declined-quote follow-up</h2>
            </div>
            <AutomationBadge
              state={declineMode === "auto" ? "active" : declineMode === "manual" ? "manual" : "off"}
            />

          </div>
          <div className="mt-4 flex items-center justify-between gap-4">
            <p className="text-xs text-muted-foreground">
              When a customer declines a quote: <span className="mono">off</span> = do nothing;
              <span className="mono"> manual</span> = show an "Ask why" button in the dashboard;
              <span className="mono"> auto</span> = text them automatically asking for a reason.
              Their reply is captured on the quote.
            </p>
            <select
              value={profile?.decline_followup_mode ?? "off"}
              disabled={setDeclineMode.isPending}
              onChange={(e) => setDeclineMode.mutate(e.target.value as "off" | "manual" | "auto")}
              className="mono rounded-sm border border-border bg-background px-3 py-2 text-xs uppercase tracking-wider"
            >
              <option value="off">Off</option>
              <option value="manual">Manual</option>
              <option value="auto">Auto</option>
            </select>
          </div>
        </div>

        <div className="panel p-6">
          <div className="flex items-start justify-between gap-3">
            <div>
              <div className="label-eyebrow">Advanced</div>
              <h2 className="mt-1 text-xl">Automations in Advanced</h2>
            </div>
            <div className="flex flex-col items-end gap-1">
              <AutomationBadge
                state={advancedActiveCount > 0 ? "active" : "off"}
                activeCount={advancedActiveCount}
                tooltip={advancedTooltip}
              />
              <button
                type="button"
                onClick={refreshStatuses}
                disabled={isRefreshingStatuses}
                className="mono text-[10px] uppercase tracking-widest text-muted-foreground underline decoration-dotted underline-offset-2 hover:text-foreground disabled:opacity-50"
              >
                {isRefreshingStatuses ? "Checking…" : "Refresh statuses"}
              </button>
            </div>
          </div>
          <div className="mt-4 space-y-2">
            <div className="flex items-center justify-between gap-3 border-b border-border pb-2">
              <span className="text-xs text-muted-foreground">Opt-in prompt & cooldown</span>
              <AutomationBadge state={optInPromptActive ? "active" : "hold"} />
            </div>
            <div className="flex items-center justify-between gap-3">
              <span className="text-xs text-muted-foreground">Inbound webhook diagnostics</span>
              <AutomationBadge state="off" label="Manual tool" />
            </div>
          </div>
          <button
            type="button"
            onClick={() => setTab("advanced")}
            className="mono mt-4 rounded-sm border border-border px-3 py-2 text-[10px] uppercase tracking-widest text-muted-foreground hover:text-foreground"
          >
            Open advanced
          </button>
        </div>

        <ExcludedNumbersPanel />

        <TeamMembersPanel tier={profile?.subscription_tier} />

      </div>
      )}

      {tab === "advanced" && (
      <div className="grid gap-5 p-5 md:grid-cols-2 md:p-8">
        <div id="adv-opt-in-prompt" className="scroll-mt-24 rounded-sm transition md:col-span-2">
          <OptInPromptSettingsPanel
            businessName={profile?.business_name}
            template={profile?.opt_in_prompt_template}
            cooldownMinutes={profile?.opt_in_prompt_cooldown_minutes}
            ownerPhone={profile?.owner_phone}
            fromNumber={profile?.twilio_phone_number}
            lastTestPhone={profile?.last_test_phone}
          />
        </div>

        {!isStaff && (
          <div id="adv-webhook-diagnostics" className="scroll-mt-24 space-y-5 rounded-sm transition md:col-span-2">
            <WebhookCheckPanel />
            <WebhookEventLogPanel />
          </div>
        )}


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
      )}
    </div>
  );
}


function AutomationBadge({
  state,
  label,
  activeCount,
  tooltip,
}: {
  state: "active" | "manual" | "hold" | "off";
  label?: string;
  activeCount?: number;
  tooltip?: React.ReactNode;
}) {
  const styles: Record<string, string> = {
    active: "border-moss/60 bg-moss/15 text-moss",
    manual: "border-steel/60 bg-steel/15 text-steel",
    hold: "border-orange/60 bg-orange/15 text-orange",
    off: "border-border bg-muted/20 text-muted-foreground",
  };
  const defaults: Record<string, string> = {
    active: activeCount ? `${activeCount} active` : "Active",

    manual: "Manual",
    hold: "On hold",
    off: "Off",
  };
  const tooltipId = useId();
  const triggerId = useId();
  const containerRef = useRef<HTMLSpanElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!open) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
        triggerRef.current?.focus();
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [open]);

  const text = label ?? defaults[state];
  const badge = (
    <span
      className={`mono shrink-0 rounded-sm border px-2 py-1 text-[10px] uppercase tracking-widest ${styles[state]}`}
    >
      {state === "active" && (
        <span
          aria-hidden="true"
          className="mr-1.5 inline-block h-1.5 w-1.5 rounded-full bg-moss align-middle"
        />
      )}
      {text}
    </span>
  );

  if (!tooltip) return badge;

  const show = () => setOpen(true);
  const hide = (e?: React.SyntheticEvent) => {
    const next = "relatedTarget" in (e ?? {}) ? ((e as React.FocusEvent).relatedTarget as Node | null) : null;
    if (!next || !containerRef.current?.contains(next)) {
      setOpen(false);
    }
  };

  return (
    <span ref={containerRef} className="relative shrink-0">
      <button
        id={triggerId}
        ref={triggerRef}
        type="button"
        aria-expanded={open}
        aria-controls={tooltipId}
        aria-haspopup="true"
        aria-label={`Automation status: ${text}. Show details`}
        className="cursor-help rounded-sm outline-none focus-visible:ring-1 focus-visible:ring-orange focus-visible:ring-offset-1"
        onMouseEnter={show}
        onMouseLeave={hide}
        onFocus={show}
        onBlur={hide}
        onClick={() => setOpen((o) => !o)}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            setOpen((o) => !o);
          }
          if (e.key === "ArrowDown") {
            e.preventDefault();
            setOpen(true);
            window.setTimeout(() => {
              containerRef.current
                ?.querySelector<HTMLButtonElement>(`#${CSS.escape(tooltipId)} button`)
                ?.focus();
            }, 0);
          }
        }}
      >
        {badge}
      </button>
      <span
        id={tooltipId}
        role="group"
        hidden={!open}
        aria-labelledby={triggerId}
        aria-label="Advanced automation details"
        className={`mono absolute right-0 top-full z-20 mt-2 w-64 rounded-sm border border-border bg-card p-3 text-left text-[10px] uppercase tracking-widest text-muted-foreground shadow-lg ${open ? "block" : "hidden"}`}
        onMouseEnter={show}
        onMouseLeave={hide}
        onBlur={hide}
      >
        {tooltip}
      </span>
    </span>
  );
}



function formatRelativeTime(past: Date, current: Date): string {
  const seconds = Math.floor((current.getTime() - past.getTime()) / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function Row({ k, v }: { k: string; v: React.ReactNode }) {

  return (
    <div className="flex items-center justify-between border-b border-border pb-2">
      <span className="label-eyebrow">{k}</span>
      <span>{v}</span>
    </div>
  );
}
