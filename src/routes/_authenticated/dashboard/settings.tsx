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

  const { data: profile, refetch: refetchProfile, dataUpdatedAt: profileUpdatedAt } = useQuery({
    queryKey: ["profile"],
    queryFn: async () => {
      const { data: u } = await supabase.auth.getUser();
      if (!u.user) return null;
      const { data } = await supabase.from("profiles").select("*").eq("id", u.user.id).maybeSingle();
      return data;
    },
    refetchInterval: 60_000,
    refetchOnWindowFocus: true,
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

  // Live status: refresh the ACTIVE badge/tooltip the moment the profile row changes.
  useEffect(() => {
    let channel: ReturnType<typeof supabase.channel> | null = null;
    let cancelled = false;
    (async () => {
      const { data: u } = await supabase.auth.getUser();
      if (cancelled || !u.user) return;
      channel = supabase
        .channel(`settings-profile-${u.user.id}`)
        .on(
          "postgres_changes",
          { event: "UPDATE", schema: "public", table: "profiles", filter: `id=eq.${u.user.id}` },
          () => {
            void qc.invalidateQueries({ queryKey: ["profile"] });
          },
        )
        .subscribe();
    })();
    return () => {
      cancelled = true;
      if (channel) void supabase.removeChannel(channel);
    };
  }, [qc]);


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
    if (profileUpdatedAt) setEvaluatedAt(new Date(profileUpdatedAt));
  }, [profileUpdatedAt]);
  useEffect(() => {
    setNow(new Date());
    const id = window.setInterval(() => setNow(new Date()), 15_000);
    const onVisible = () => {
      if (document.visibilityState === "visible") {
        setNow(new Date());
        void refetchProfile();
      }
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.clearInterval(id);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [refetchProfile]);
  const evaluatedLabel = evaluatedAt
    ? evaluatedAt.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })
    : "—";
  const relativeLabel = evaluatedAt && now ? formatRelativeTime(evaluatedAt, now) : "—";

  const [isRefreshingStatuses, setIsRefreshingStatuses] = useState(false);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const [refreshAttempts, setRefreshAttempts] = useState(0);

  // Snapshot of the fields that drive the automation status badges, so the
  // refresh toast can say whether anything actually changed.
  const statusSnapshot = (p: typeof profile) =>
    JSON.stringify({
      decline_followup_mode: p?.decline_followup_mode ?? "off",
      voicemail_enabled: p?.voicemail_enabled ?? null,
      review_auto_enabled: (p as Record<string, unknown> | null | undefined)?.["review_auto_enabled"] ?? null,
      opt_in_prompt_template: p?.opt_in_prompt_template ?? null,
      opt_in_prompt_cooldown_minutes: p?.opt_in_prompt_cooldown_minutes ?? null,
      optInPromptActive,
    });
  // Dispatch-style activity entry for each manual status re-check.
  const logStatusRefresh = async (
    status: "already_current" | "updated" | "failed",
    detail: Record<string, unknown>,
  ) => {
    try {
      const { data: u } = await supabase.auth.getUser();
      if (!u.user) return;
      await supabase.from("logs").insert({
        user_id: u.user.id,
        action_type: "status_refresh",
        status,
        message_sent: JSON.stringify({ source: "settings_active_badge", at: new Date().toISOString(), ...detail }),
      });
      void queryClient.invalidateQueries({ queryKey: ["logs"] });
    } catch {
      // logging must never block the refresh itself
    }
  };

  const refreshStatuses = async () => {
    setIsRefreshingStatuses(true);
    setRefreshError(null);
    const before = statusSnapshot(profile);
    const startedAt = Date.now();
    try {
      const result = await refetchProfile();
      // TanStack Query surfaces fetch failures on the result rather than throwing.
      if (result?.error) throw result.error as Error;
      const nowDate = new Date();
      setNow(nowDate);
      setEvaluatedAt(nowDate);
      setRefreshAttempts(0);
      const after = statusSnapshot(result?.data ?? profile);
      const checkedAt = nowDate.toLocaleTimeString([], {
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      });
      const changed = before !== after;
      void logStatusRefresh(changed ? "updated" : "already_current", {
        outcome: changed ? "Statuses updated" : "Statuses already current",
        duration_ms: Date.now() - startedAt,
        checked_at_local: checkedAt,
      });
      if (!changed) {
        toast.success("Statuses already current", {
          description: `No changes since the last check · re-checked at ${checkedAt}.`,
        });
      } else {
        toast.success("Statuses updated", {
          description: `Automation statuses changed and have been refreshed · ${checkedAt}.`,
        });
      }
    } catch (e) {
      const message = (e as Error)?.message || "Could not re-check automation statuses.";
      setRefreshError(message);
      setRefreshAttempts((n) => n + 1);
      void logStatusRefresh("failed", {
        outcome: "Refresh failed",
        error: message,
        duration_ms: Date.now() - startedAt,
      });
      toast.error("Refresh failed", { description: message });
    } finally {
      setIsRefreshingStatuses(false);
    }
  };




  const highlightTimersRef = useRef<Map<HTMLElement, number[]>>(new Map());
  useEffect(() => {
    const timers = highlightTimersRef.current;
    return () => {
      timers.forEach((ids) => ids.forEach((id) => window.clearTimeout(id)));
      timers.clear();
    };
  }, []);

  const jumpToAdvanced = (anchorId: string) => {
    setTab("advanced");
    window.setTimeout(() => {
      const el = document.getElementById(anchorId);
      if (!el) return;
      el.scrollIntoView({ behavior: "smooth", block: "start" });
      el.setAttribute("tabindex", "-1");
      (el as HTMLElement).focus({ preventScroll: true });

      // clear any pending highlight timers (repeat clicks restart the window)
      const pending = highlightTimersRef.current.get(el);
      if (pending) pending.forEach((id) => window.clearTimeout(id));

      el.classList.add("transition-shadow", "duration-500");
      el.classList.add("ring-2", "ring-orange", "ring-offset-2", "ring-offset-charcoal");

      // hold the highlight visible, then fade it out and clean up
      const fadeId = window.setTimeout(() => {
        el.classList.remove("ring-2", "ring-orange", "ring-offset-2", "ring-offset-charcoal");
      }, 3200);
      const cleanupId = window.setTimeout(() => {
        el.classList.remove("transition-shadow", "duration-500");
        el.removeAttribute("tabindex");
        highlightTimersRef.current.delete(el);
      }, 3800);

      highlightTimersRef.current.set(el, [fadeId, cleanupId]);
    }, 60);
  };


  const advancedAutomations: { name: string; mode: string; anchorId: string }[] = [
    { name: "Opt-in prompt & cooldown", mode: optInPromptActive ? "ACTIVE" : "ON HOLD", anchorId: "adv-opt-in-prompt" },
    { name: "Inbound webhook diagnostics", mode: "MANUAL TOOL", anchorId: "adv-webhook-diagnostics" },
  ];

  const advancedTooltip = (
    <div className="space-y-1">
      <div className="text-foreground" id="adv-automations-heading">Advanced automations</div>
      <ul className="space-y-1" aria-labelledby="adv-automations-heading">
        {advancedAutomations.map((a) => (
          <li key={a.name}>
            <button
              type="button"
              onClick={() => {
                jumpToAdvanced(a.anchorId);
                toast.success(`Opened ${a.name} in Advanced.`);
              }}
              aria-label={`${a.name}, mode ${a.mode}. Open in Advanced tab`}
              className="flex w-full items-center justify-between gap-3 rounded-sm px-1 py-0.5 text-left uppercase tracking-widest hover:bg-muted/30 hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-orange"
            >
              <span className="underline decoration-dotted underline-offset-2">{a.name}</span>
              <span className="text-foreground">{a.mode}</span>
            </button>
          </li>
        ))}
      </ul>
      <div className="border-t border-border pt-1">
        <div aria-live="polite" aria-atomic="true">
          Last evaluated {relativeLabel} <span className="text-muted-foreground normal-case no-underline">({evaluatedLabel})</span>
        </div>
        <button
          type="button"
          onClick={refreshStatuses}
          disabled={isRefreshingStatuses}
          aria-label={isRefreshingStatuses ? "Refreshing automation statuses" : "Refresh automation statuses now"}
          className="mt-1 flex w-full items-center justify-between rounded-sm border border-border bg-muted/20 px-2 py-1 text-left uppercase tracking-widest text-foreground hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-orange disabled:opacity-50"
        >
          <span className="flex items-center gap-1.5">
            <span aria-hidden="true" className={isRefreshingStatuses ? "animate-spin" : ""}>↻</span>
            <span className="underline decoration-dotted underline-offset-2">Refresh now</span>
          </span>
          <span className="text-foreground">{isRefreshingStatuses ? "Checking…" : "↻"}</span>
        </button>
        {refreshError ? (
          <div
            role="alert"
            aria-live="assertive"
            className="mt-1 space-y-1 rounded-sm border border-orange/60 bg-orange/10 px-2 py-1 normal-case tracking-normal"
          >
            <div className="text-foreground">Couldn’t refresh statuses</div>
            <div className="text-muted-foreground break-words">{refreshError}</div>
            <div className="flex items-center justify-between gap-2">
              <button
                type="button"
                onClick={refreshStatuses}
                disabled={isRefreshingStatuses}
                aria-label="Retry refreshing automation statuses"
                className="rounded-sm border border-orange/70 px-2 py-0.5 uppercase tracking-widest text-foreground hover:bg-orange/20 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-orange disabled:opacity-50"
              >
                {isRefreshingStatuses ? "Retrying…" : "Retry"}
              </button>
              <button
                type="button"
                onClick={() => {
                  setRefreshError(null);
                  setRefreshAttempts(0);
                }}
                aria-label="Dismiss refresh error"
                className="rounded-sm px-2 py-0.5 uppercase tracking-widest text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-orange"
              >
                Dismiss
              </button>
            </div>
            {refreshAttempts > 1 ? (
              <div className="text-muted-foreground">{refreshAttempts} failed attempts in a row.</div>
            ) : null}
          </div>
        ) : null}
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
  // set while focus is handed back programmatically, so the trigger's onFocus doesn't reopen
  const suppressReopenRef = useRef(false);
  const returnFocusToTrigger = () => {
    suppressReopenRef.current = true;
    window.setTimeout(() => {
      triggerRef.current?.focus();
      window.setTimeout(() => {
        suppressReopenRef.current = false;
      }, 0);
    }, 0);
  };

  useEffect(() => {
    if (!open) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
        returnFocusToTrigger();
      }
    };
    const handlePointerDown = (e: PointerEvent | MouseEvent) => {
      const target = e.target as Node | null;
      if (target && containerRef.current?.contains(target)) return;
      const hadFocusInside =
        document.activeElement instanceof Node &&
        !!containerRef.current?.contains(document.activeElement);
      setOpen(false);
      if (hadFocusInside) returnFocusToTrigger();
    };
    document.addEventListener("keydown", handleKeyDown);
    document.addEventListener("pointerdown", handlePointerDown, true);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      document.removeEventListener("pointerdown", handlePointerDown, true);
    };
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

  const show = () => {
    if (suppressReopenRef.current) return;
    setOpen(true);
  };
  const hide = (e?: React.SyntheticEvent) => {
    const next = "relatedTarget" in (e ?? {}) ? ((e as React.FocusEvent).relatedTarget as Node | null) : null;
    if (!next || !containerRef.current?.contains(next)) {
      const blurredFromContent =
        !!e && e.target instanceof Node && e.target !== triggerRef.current;
      setOpen(false);
      if (blurredFromContent && !next) {
        // outside click / focus loss from tooltip content: hand focus back to the badge
        returnFocusToTrigger();
      }
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
        onKeyDown={(e) => {
          const navKeys = ["Tab", "ArrowDown", "ArrowUp", "Home", "End"];
          if (!navKeys.includes(e.key)) return;
          const tooltipEl = containerRef.current?.querySelector<HTMLElement>(`#${CSS.escape(tooltipId)}`);
          const focusables = Array.from(
            tooltipEl?.querySelectorAll<HTMLElement>(
              "button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex='-1'])"
            ) ?? []
          );
          if (focusables.length === 0) return;
          const first = focusables[0];
          const last = focusables[focusables.length - 1];
          const index = focusables.indexOf(document.activeElement as HTMLElement);

          if (e.key === "Tab") {
            if (e.shiftKey && document.activeElement === first) {
              e.preventDefault();
              last.focus();
            } else if (!e.shiftKey && document.activeElement === last) {
              e.preventDefault();
              first.focus();
            }
            return;
          }

          e.preventDefault();
          if (e.key === "Home") {
            first.focus();
          } else if (e.key === "End") {
            last.focus();
          } else if (e.key === "ArrowDown") {
            focusables[index < 0 ? 0 : (index + 1) % focusables.length].focus();
          } else if (e.key === "ArrowUp") {
            focusables[index < 0 ? focusables.length - 1 : (index - 1 + focusables.length) % focusables.length].focus();
          }
        }}

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
