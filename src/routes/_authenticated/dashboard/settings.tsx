import { createFileRoute } from "@tanstack/react-router";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { PageHeader } from "@/components/AppShell";
import { ExcludedNumbersPanel } from "@/components/ExcludedNumbersPanel";
import { TeamMembersPanel } from "@/components/TeamMembersPanel";
import { OptInPromptSettingsPanel } from "@/components/OptInPromptSettingsPanel";
import { WebhookCheckPanel } from "@/components/WebhookCheckPanel";
import { WebhookEventLogPanel } from "@/components/WebhookEventLogPanel";
import { ActiveChangeAuditPanel } from "@/components/ActiveChangeAuditPanel";
import { DepositDefaultsPanel } from "@/components/DepositDefaultsPanel";
import { OnlinePaymentsPanel } from "@/components/OnlinePaymentsPanel";

import { useTeamRole } from "@/hooks/useTeamRole";
import { OPT_IN_PROMPT_REAL_SENDS_ENABLED } from "@/lib/opt-in-prompt-gate";
import { runStatusRefresh } from "@/lib/status-refresh.functions";
import { useServerFn } from "@tanstack/react-start";


import { createContext, forwardRef, memo, useCallback, useContext, useEffect, useId, useImperativeHandle, useMemo, useRef, useState } from "react";
import { toast } from "sonner";

const UPDATE_ORIGIN_LABEL: Record<"this-device" | "other-device" | "backend", string> = {
  "this-device": "from this device",
  "other-device": "from another device",
  backend: "from the backend",
};

const TooltipCloseContext = createContext<() => void>(() => {});

function TooltipCloseButton({ children = "Close" }: { children?: React.ReactNode }) {
  const close = useContext(TooltipCloseContext);
  return (
    <button
      type="button"
      onClick={close}
      className="mt-2 rounded-sm border border-border px-2 py-1 uppercase tracking-widest text-muted-foreground hover:text-foreground kb-focus"
    >
      {children}
    </button>
  );
}

export const Route = createFileRoute("/_authenticated/dashboard/settings")({
  component: SettingsPage,
});

function SettingsPage() {
  const qc = useQueryClient();
  const runStatusRefreshFn = useServerFn(runStatusRefresh);

  const { isStaff } = useTeamRole();
  const [tab, setTab] = useState<"settings" | "advanced">("settings");
  const [reviewUrl, setReviewUrl] = useState("");
  const [ownerPhone, setOwnerPhone] = useState("");
  const [autoRefreshEnabled, setAutoRefreshEnabled] = useState(false);
  const [autoRefreshInterval, setAutoRefreshInterval] = useState(15);


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

  // Attribution for the most recent live status change.
  const localEditsRef = useRef<Map<string, number>>(new Map());
  const markLocalEdit = (field: string) => {
    localEditsRef.current.set(field, Date.now());
  };
  const hasPendingLocalEdit = (field: string) => {
    const at = localEditsRef.current.get(field);
    return at !== undefined && Date.now() - at < 15_000;
  };

  // Snapshot of the status-relevant profile fields, so realtime updates can be described.
  const statusSnapshotRef = useRef<{
    voicemail: boolean;
    decline: string;
    review: boolean;
    intake: boolean;
  } | null>(null);
  useEffect(() => {
    if (!profile) return;
    const prev = statusSnapshotRef.current;
    // A refetch triggered by our own edit must not overwrite the snapshot before
    // the realtime payload arrives — otherwise the change looks like a no-op and
    // the "from this device" attribution is silently dropped.
    statusSnapshotRef.current = {
      voicemail:
        prev && hasPendingLocalEdit("voicemail_enabled") ? prev.voicemail : !!profile.voicemail_enabled,
      decline:
        prev && hasPendingLocalEdit("decline_followup_mode")
          ? prev.decline
          : profile.decline_followup_mode ?? "off",
      review:
        prev && hasPendingLocalEdit("review_requests_enabled")
          ? prev.review
          : profile.review_requests_enabled !== false,
      intake:
        prev && hasPendingLocalEdit("intake_enabled") ? prev.intake : !!profile.intake_enabled,
    };
  }, [profile]);
  const [lastUpdate, setLastUpdate] = useState<
    { origin: "this-device" | "other-device" | "backend"; at: Date } | null
  >(null);

  // Live status: refresh the ACTIVE badge/tooltip the moment the profile row changes.
  // Auto-reconnects with backoff and surfaces a live/reconnecting/disconnected indicator.
  const [realtimeState, setRealtimeState] = useState<
    "connecting" | "live" | "reconnecting" | "disconnected"
  >("connecting");
  const [realtimeAttempt, setRealtimeAttempt] = useState(0);
  // Timestamp of the last successful subscribe / live payload, shown under the ACTIVE indicator.
  const [lastSyncAt, setLastSyncAt] = useState<Date | null>(null);
  const [statusAnnouncement, setStatusAnnouncement] = useState("");
  const [realtimeToasts, setRealtimeToasts] = useState(true);
  const realtimeToastsRef = useRef(true);
  const [reconnectSignal, setReconnectSignal] = useState(0);

  // Toast preference persists per browser; the aria-live announcement always fires.
  useEffect(() => {
    const saved = window.localStorage.getItem("temaro:realtime-toasts");
    if (saved !== null) {
      const on = saved === "1";
      setRealtimeToasts(on);
      realtimeToastsRef.current = on;
    }
  }, []);

  const setRealtimeToastPref = useCallback((on: boolean) => {
    setRealtimeToasts(on);
    realtimeToastsRef.current = on;
    window.localStorage.setItem("temaro:realtime-toasts", on ? "1" : "0");
  }, []);

  const manualReconnect = useCallback(() => {
    setRealtimeState("connecting");
    setStatusAnnouncement("Reconnecting manually…");
    if (realtimeToastsRef.current) {
      toast.info("Reconnecting now", { description: "Forcing a fresh Realtime connection." });
    }
    setReconnectSignal((n) => n + 1);
  }, []);

  // Announce (and optionally toast) every connection-state transition.
  const prevRealtimeStateRef = useRef<typeof realtimeState | null>(null);
  useEffect(() => {
    const prev = prevRealtimeStateRef.current;
    prevRealtimeStateRef.current = realtimeState;
    if (prev === null || prev === realtimeState) return;

    const time = new Date().toLocaleTimeString();
    if (realtimeState === "live") {
      const message =
        prev === "connecting"
          ? "Live updates connected."
          : "Live updates reconnected. Settings are back in sync.";
      setStatusAnnouncement(`${message} ${time}`);
      if (realtimeToastsRef.current) {
        toast.success("Live updates reconnected", { description: `Back in sync at ${time}.` });
      }
      return;
    }

    if (realtimeState === "reconnecting") {
      const message = `Live updates interrupted. Reconnecting${realtimeAttempt > 1 ? `, attempt ${realtimeAttempt}` : ""}.`;
      setStatusAnnouncement(`${message} ${time}`);
      if (realtimeToastsRef.current && prev !== "disconnected") {
        toast.warning("Live updates interrupted", {
          description: `Reconnecting automatically — started at ${time}.`,
        });
      }
      return;
    }

    if (realtimeState === "disconnected") {
      setStatusAnnouncement(
        `Live updates disconnected after ${realtimeAttempt} attempts. Statuses may be out of date. ${time}`,
      );
      if (realtimeToastsRef.current) {
        toast.error("Live updates disconnected", {
          description: `Still retrying, but statuses may be stale. Last attempt ${time}.`,
        });
      }
      return;
    }

    setStatusAnnouncement(`Connecting to live updates. ${time}`);
  }, [realtimeState, realtimeAttempt]);


  useEffect(() => {
    let channel: ReturnType<typeof supabase.channel> | null = null;
    let cancelled = false;
    let retryTimer: number | null = null;
    let attempt = 0;

    const handlePayload = (payload: { new: unknown }) => {
      setLastSyncAt(new Date());
      void qc.invalidateQueries({ queryKey: ["profile"] });

      const next = payload.new as Record<string, unknown> | null;
      const prev = statusSnapshotRef.current;
      if (!next || !prev) return;

      const nextVoicemail = !!next["voicemail_enabled"];
      const nextDecline = (next["decline_followup_mode"] as string) ?? "off";
      const nextReview = next["review_requests_enabled"] !== false;
      const nextIntake = !!next["intake_enabled"];
      const changes: string[] = [];
      const changedFields: string[] = [];
      if (nextVoicemail !== prev.voicemail) {
        changes.push(`Voicemail ${nextVoicemail ? "ACTIVE" : "OFF"}`);
        changedFields.push("voicemail_enabled");
      }
      if (nextDecline !== prev.decline) {
        changes.push(`Declined-quote follow-up ${nextDecline.toUpperCase()}`);
        changedFields.push("decline_followup_mode");
      }
      if (nextReview !== prev.review) {
        changes.push(`Reviews ${nextReview ? "ACTIVE" : "OFF"}`);
        changedFields.push("review_requests_enabled");
      }
      if (nextIntake !== prev.intake) {
        changes.push(`Intake form ${nextIntake ? "ACTIVE" : "OFF"}`);
        changedFields.push("intake_enabled");
      }
      if (changes.length === 0) return;

      // Attribute the change: a matching edit from this tab within the last 15s
      // means we made it; otherwise it came from another signed-in device, or
      // from server-side automation for fields the UI never writes.
      const now = Date.now();
      const isLocal = changedFields.some((f) => {
        const at = localEditsRef.current.get(f);
        return at !== undefined && now - at < 15_000;
      });
      const uiWritable = changedFields.every((f) =>
        f === "voicemail_enabled" || f === "decline_followup_mode" || f === "review_requests_enabled",
      );
      const origin = isLocal ? "this-device" : uiWritable ? "other-device" : "backend";
      changedFields.forEach((f) => localEditsRef.current.delete(f));
      setLastUpdate({ origin, at: new Date() });

      statusSnapshotRef.current = {
        voicemail: nextVoicemail,
        decline: nextDecline,
        review: nextReview,
        intake: nextIntake,
      };
      toast.success("Automation status updated", {
        description: `${changes.join(" · ")} — ${UPDATE_ORIGIN_LABEL[origin]} at ${new Date().toLocaleTimeString()}`,
      });
      void logStatusChange({
        changes,
        changedFields,
        origin,
        previous: {
          voicemail_enabled: prev.voicemail,
          decline_followup_mode: prev.decline,
          review_requests_enabled: prev.review,
          intake_enabled: prev.intake,
        },
        next: {
          voicemail_enabled: nextVoicemail,
          decline_followup_mode: nextDecline,
          review_requests_enabled: nextReview,
          intake_enabled: nextIntake,
        },
      });
    };

    // Dispatch-style activity entry for every ACTIVE status change, with the
    // time and what triggered it. De-duplicated across open tabs so one change
    // does not produce one row per tab.
    const logStatusChange = async (entry: {
      changes: string[];
      changedFields: string[];
      origin: "this-device" | "other-device" | "backend";
      previous: Record<string, unknown>;
      next: Record<string, unknown>;
    }) => {
      try {
        const signature = `${entry.changedFields.join(",")}|${JSON.stringify(entry.next)}`;
        const guardKey = "temaro:status-change-log";
        const nowMs = Date.now();
        const raw = window.localStorage.getItem(guardKey);
        if (raw) {
          const prevGuard = JSON.parse(raw) as { signature: string; at: number };
          if (prevGuard.signature === signature && nowMs - prevGuard.at < 10_000) return;
        }
        window.localStorage.setItem(guardKey, JSON.stringify({ signature, at: nowMs }));

        const { data: u } = await supabase.auth.getUser();
        if (!u.user) return;
        await supabase.from("logs").insert({
          user_id: u.user.id,
          action_type: "automation_status_change",
          status: entry.origin,
          message_sent: JSON.stringify({
            source: "settings_active_badge",
            at: new Date().toISOString(),
            trigger: UPDATE_ORIGIN_LABEL[entry.origin],
            changes: entry.changes,
            changed_fields: entry.changedFields,
            previous_values: entry.previous,
            new_values: entry.next,
          }),
        });
        void qc.invalidateQueries({ queryKey: ["logs"] });
      } catch {
        // logging must never break the live status handling
      }
    };



    const scheduleReconnect = () => {
      if (cancelled || retryTimer !== null) return;
      attempt += 1;
      setRealtimeAttempt(attempt);
      // After a few failed attempts the outage is no longer a blip — say so.
      setRealtimeState(attempt >= 4 ? "disconnected" : "reconnecting");
      const delay = Math.min(30_000, 1000 * 2 ** (attempt - 1));
      retryTimer = window.setTimeout(() => {
        retryTimer = null;
        void connect();
      }, delay);
    };

    const connect = async () => {
      if (cancelled) return;
      const { data: u } = await supabase.auth.getUser();
      if (cancelled || !u.user) return;

      if (channel) {
        const stale = channel;
        channel = null;
        await supabase.removeChannel(stale);
      }
      if (cancelled) return;

      channel = supabase
        .channel(`settings-profile-${u.user.id}-${Date.now()}`)
        .on(
          "postgres_changes",
          { event: "UPDATE", schema: "public", table: "profiles", filter: `id=eq.${u.user.id}` },
          handlePayload,
        )
        .subscribe((status) => {
          if (cancelled) return;
          if (status === "SUBSCRIBED") {
            attempt = 0;
            setRealtimeAttempt(0);
            setRealtimeState("live");
            setLastSyncAt(new Date());
            // A gap in the stream may have hidden a change — resync on reconnect.
            void qc.invalidateQueries({ queryKey: ["profile"] });
          } else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT" || status === "CLOSED") {
            scheduleReconnect();
          }
        });
    };

    void connect();

    const onOnline = () => {
      if (retryTimer !== null) {
        window.clearTimeout(retryTimer);
        retryTimer = null;
      }
      void connect();
    };
    window.addEventListener("online", onOnline);

    return () => {
      cancelled = true;
      window.removeEventListener("online", onOnline);
      if (retryTimer !== null) window.clearTimeout(retryTimer);
      if (channel) void supabase.removeChannel(channel);
    };
  }, [qc, reconnectSignal]);




  useEffect(() => {
    if (profile) {
      setOwnerPhone(profile.owner_phone ?? "");
      setAutoRefreshEnabled(profile.auto_refresh_enabled ?? false);
      setAutoRefreshInterval(profile.auto_refresh_interval_minutes ?? 15);
    }
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
      markLocalEdit("voicemail_enabled");
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
      markLocalEdit("review_requests_enabled");
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
      markLocalEdit("decline_followup_mode");
      const { error } = await supabase.from("profiles")
        .update({ decline_followup_mode: mode }).eq("id", u.user.id);
      if (error) throw error;
    },
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["profile"] }); },
    onError: (e: Error) => toast.error(e.message),
  });

  const updateAutoRefresh = useMutation({
    mutationFn: async (values: { enabled: boolean; intervalMinutes: number }) => {
      const { data: u } = await supabase.auth.getUser();
      if (!u.user) throw new Error("Not signed in");
      const { error } = await supabase.from("profiles")
        .update({
          auto_refresh_enabled: values.enabled,
          auto_refresh_interval_minutes: values.intervalMinutes,
        })
        .eq("id", u.user.id);
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Auto-refresh settings saved.");
      qc.invalidateQueries({ queryKey: ["profile"] });
    },
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
  // Which kind of refresh is currently running, so the in-progress banner can
  // distinguish "you clicked this" from a background auto re-check.
  const [refreshTrigger, setRefreshTrigger] = useState<"manual" | "auto">("manual");
  // Tooltip-local live region text: announces the automation status outcome of
  // every completed refresh (including repeats) without moving focus.
  const [tooltipStatusMessage, setTooltipStatusMessage] = useState("");
  const tooltipAnnounceCountRef = useRef(0);
  const announceTooltipStatus = useCallback((text: string) => {
    tooltipAnnounceCountRef.current += 1;
    // The counter guarantees a text change, so identical back-to-back outcomes
    // are still re-announced by screen readers.
    setTooltipStatusMessage(`${text} (update ${tooltipAnnounceCountRef.current})`);
  }, []);
  const [refreshError, setRefreshError] = useState<{
    message: string;
    code?: string;
    at: Date;
  } | null>(null);
  const [refreshAttempts, setRefreshAttempts] = useState(0);
  // Cooldown after repeated failures to prevent hammering the status endpoint.
  const COOLDOWN_BASE_MS = 30_000; // 30s after the 3rd consecutive failure
  const COOLDOWN_MAX_MS = 300_000; // cap at 5 minutes
  const [cooldownMs, setCooldownMs] = useState(0);
  const isInCooldown = cooldownMs > 0;
  useEffect(() => {
    if (cooldownMs <= 0) return;
    const id = window.setInterval(() => setCooldownMs((ms) => Math.max(0, ms - 1000)), 1000);
    return () => window.clearInterval(id);
  }, [cooldownMs > 0]);
  const formatCooldown = (ms: number) => {
    const totalSeconds = Math.ceil(ms / 1000);
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`;
  };
  // When a manual refresh fails, pull focus straight to Retry so recovery is one keypress away.
  const retryButtonRef = useRef<HTMLButtonElement | null>(null);
  // Ref to the ACTIVE badge so refresh can restore focus to the exact element
  // that was focused inside the tooltip before the button became disabled.
  const advancedBadgeRef = useRef<{ contains: (el: Node | null) => boolean; restoreFocus: (el: HTMLElement | null) => void } | null>(null);


  useEffect(() => {
    if (!refreshError || isRefreshingStatuses || isInCooldown) return;
    const id = window.requestAnimationFrame(() => {
      const el = retryButtonRef.current;
      if (el && el.isConnected) el.focus();
    });
    return () => window.cancelAnimationFrame(id);
  }, [refreshError, isRefreshingStatuses, isInCooldown]);


  // Snapshot of the fields that drive the automation status badges, so the
  // refresh toast can say whether anything actually changed.
  const statusSnapshot = useCallback(
    (p: typeof profile) =>
      JSON.stringify({
        decline_followup_mode: p?.decline_followup_mode ?? "off",
        voicemail_enabled: p?.voicemail_enabled ?? null,
        review_auto_enabled: (p as Record<string, unknown> | null | undefined)?.["review_auto_enabled"] ?? null,
        opt_in_prompt_template: p?.opt_in_prompt_template ?? null,
        opt_in_prompt_cooldown_minutes: p?.opt_in_prompt_cooldown_minutes ?? null,
        optInPromptActive,
      }),
    [optInPromptActive],
  );
  // Contacts / submissions that saw activity in the window covered by this
  // re-check, so the Activity entry can link straight to what changed.
  const collectAffected = useCallback(async (sinceIso: string) => {
    const affected: Array<{ type: "customer" | "intake"; id: string; label: string }> = [];
    try {
      const [{ data: logRows }, { data: intakeRows }] = await Promise.all([
        supabase
          .from("logs")
          .select("customer_id, created_at")
          .not("customer_id", "is", null)
          .neq("action_type", "status_refresh")
          .gte("created_at", sinceIso)
          .order("created_at", { ascending: false })
          .limit(100),
        supabase
          .from("intake_submissions")
          .select("id, customer_first_name, customer_last_name, updated_at")
          .gte("updated_at", sinceIso)
          .order("updated_at", { ascending: false })
          .limit(8),
      ]);

      const customerIds = Array.from(
        new Set((logRows ?? []).map((r) => r.customer_id).filter((v): v is string => Boolean(v))),
      ).slice(0, 8);
      if (customerIds.length > 0) {
        const { data: people } = await supabase
          .from("customers")
          .select("id, first_name, last_name, phone_number")
          .in("id", customerIds);
        (people ?? []).forEach((p) => {
          affected.push({
            type: "customer",
            id: p.id,
            label: [p.first_name, p.last_name].filter(Boolean).join(" ") || p.phone_number || "Contact",
          });
        });
      }
      (intakeRows ?? []).forEach((r) => {
        affected.push({
          type: "intake",
          id: r.id,
          label:
            [r.customer_first_name, r.customer_last_name].filter(Boolean).join(" ") || "Submission",
        });
      });
    } catch {
      // linking is best-effort; never block the refresh audit
    }
    return affected;
  }, []);

  // Start of the window this refresh covers (previous re-check, else last 24h).
  const lastRefreshAtRef = useRef<string>(new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString());

  // Dispatch-style activity entry for each status re-check.
  const logStatusRefresh = useCallback(async (
    status: "already_current" | "updated" | "failed",
    detail: Record<string, unknown>,
  ) => {
    try {
      const { data: u } = await supabase.auth.getUser();
      if (!u.user) return;
      const windowStart = lastRefreshAtRef.current;
      const affected = status === "failed" ? [] : await collectAffected(windowStart);
      const { error } = await supabase.from("logs").insert({
        user_id: u.user.id,
        action_type: "status_refresh",
        status,
        message_sent: JSON.stringify({
          source: "settings_active_badge",
          at: new Date().toISOString(),
          window_start: windowStart,
          affected,
          ...detail,
        }),
      });
      if (error) throw error;
      if (status !== "failed") lastRefreshAtRef.current = new Date().toISOString();
      void qc.invalidateQueries({ queryKey: ["logs"] });
      void qc.invalidateQueries({ queryKey: ["status-refresh"] });

    } catch {
      // logging must never block the refresh itself
    }
  }, [collectAffected, qc]);

  const refreshStatuses = useCallback(async (trigger: "manual" | "auto" = "manual") => {
    // Remember the exact element that had focus inside the ACTIVE tooltip so we
    // can hand focus back to it after the refresh button flips from disabled.
    const focusBefore = document.activeElement as HTMLElement | null;
    const focusWasInTooltip = focusBefore ? advancedBadgeRef.current?.contains(focusBefore) ?? false : false;

    setRefreshTrigger(trigger);
    setIsRefreshingStatuses(true);
    setRefreshError(null);
    setStatusAnnouncement("Refreshing automation statuses. Please wait.");
    const before = statusSnapshot(profile);
    const startedAt = Date.now();
    try {
      // Server-side single-run lock: only one re-evaluation may execute at a
      // time per business, no matter how many requests arrive.
      const lock = await runStatusRefreshFn({ data: { trigger } });
      if (!lock.ran) {
        setStatusAnnouncement("A refresh is already running. Waiting for it to finish.");
        if (trigger === "manual") {
          toast.info("Refresh already running", {
            description: "Another re-check is in progress — only one can run at a time.",
          });
        }
        void logStatusRefresh("already_current", {
          trigger,
          outcome: "Skipped — another refresh was already running",
          lock: "in_progress",
          duration_ms: Date.now() - startedAt,
        });
        return;
      }
      const result = await refetchProfile();

      // TanStack Query surfaces fetch failures on the result rather than throwing.
      if (result?.error) throw result.error as Error;
      const nowDate = new Date();
      setNow(nowDate);
      setEvaluatedAt(nowDate);
      setRefreshAttempts(0);
      setCooldownMs(0);
      const after = statusSnapshot(result?.data ?? profile);
      const checkedAt = nowDate.toLocaleTimeString([], {
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      });
      const changed = before !== after;
      announceTooltipStatus(
        `Opt-in prompt & cooldown ${optInPromptActive ? "ACTIVE" : "ON HOLD"}. ` +
          `${changed ? "Statuses updated" : "Statuses already current"} — re-checked at ${checkedAt}.`,
      );
      void logStatusRefresh(changed ? "updated" : "already_current", {
        trigger,
        outcome: changed ? "Statuses updated" : "Statuses already current",
        duration_ms: Date.now() - startedAt,
        checked_at_local: checkedAt,
      });
      if (trigger === "manual") {
        if (!changed) {
          setStatusAnnouncement(`Statuses already current. Re-checked at ${checkedAt}.`);
          toast.success("Statuses already current", {
            description: `No changes since the last check · re-checked at ${checkedAt}.`,
          });
        } else {
          setStatusAnnouncement(`Statuses updated. Automation statuses changed and refreshed at ${checkedAt}.`);
          toast.success("Statuses updated", {
            description: `Automation statuses changed and have been refreshed · ${checkedAt}.`,
          });
        }
      } else if (changed) {
        setStatusAnnouncement(`Statuses updated automatically at ${checkedAt}.`);
        toast.success("Statuses updated", {
          description: `Automation statuses changed and have been refreshed · ${checkedAt}.`,
        });
      } else {
        setStatusAnnouncement(`Automation statuses re-checked at ${checkedAt}. No changes.`);
      }
    } catch (e) {
      const message = (e as Error)?.message || "Could not re-check automation statuses.";
      const code = (e as { code?: string })?.code || (e as { error_code?: string })?.error_code;
      const at = new Date();
      setRefreshError({ message, code, at });
      const nextAttempt = refreshAttempts + 1;
      setRefreshAttempts(nextAttempt);
      if (nextAttempt >= 3) {
        const duration = Math.min(COOLDOWN_BASE_MS * Math.pow(2, nextAttempt - 3), COOLDOWN_MAX_MS);
        setCooldownMs(duration);
      }
      void logStatusRefresh("failed", {
        trigger,
        outcome: "Refresh failed",
        error: message,
        error_code: code,
        duration_ms: Date.now() - startedAt,
      });
      setStatusAnnouncement(`Refresh failed. ${message}`);
      announceTooltipStatus(`Refresh failed — statuses unchanged. ${message}`);
      toast.error("Refresh failed", { description: message });
    } finally {
      setIsRefreshingStatuses(false);
      if (focusWasInTooltip && focusBefore) {
        advancedBadgeRef.current?.restoreFocus(focusBefore);
      }
    }
  }, [profile, refetchProfile, statusSnapshot, logStatusRefresh, refreshAttempts, runStatusRefreshFn, announceTooltipStatus, optInPromptActive]);

  // Optional auto-refresh: re-evaluate statuses on a configurable interval while
  // this Settings page is visible. Skips ticks when hidden, already refreshing,
  // or in a failure cooldown.
  const autoRefreshTickRef = useRef<(() => void) | null>(null);
  useEffect(() => {
    autoRefreshTickRef.current = () => {
      if (isRefreshingStatuses || isInCooldown) return;
      if (document.visibilityState !== "visible") return;
      void refreshStatuses("auto");
    };
  }, [isRefreshingStatuses, isInCooldown, refreshStatuses]);

  useEffect(() => {
    const enabled = profile?.auto_refresh_enabled ?? false;
    if (!enabled) return;
    const intervalMs = Math.max(60_000, (profile?.auto_refresh_interval_minutes ?? 15) * 60_000);

    const id = window.setInterval(() => {
      autoRefreshTickRef.current?.();
    }, intervalMs);

    const onVisible = () => {
      if (document.visibilityState === "visible") {
        autoRefreshTickRef.current?.();
      }
    };
    document.addEventListener("visibilitychange", onVisible);

    return () => {
      window.clearInterval(id);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [profile?.auto_refresh_enabled, profile?.auto_refresh_interval_minutes]);


  const highlightTimersRef = useRef<Map<HTMLElement, number[]>>(new Map());

  useEffect(() => {
    const timers = highlightTimersRef.current;
    return () => {
      timers.forEach((ids) => ids.forEach((id) => window.clearTimeout(id)));
      timers.clear();
    };
  }, []);

  const jumpToAdvanced = useCallback((anchorId: string) => {
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
  }, []);


  const advancedAutomations = useMemo(
    () => [
      { name: "Opt-in prompt & cooldown", mode: optInPromptActive ? "ACTIVE" : "ON HOLD", anchorId: "adv-opt-in-prompt" },
      { name: "Inbound webhook diagnostics", mode: "MANUAL TOOL", anchorId: "adv-webhook-diagnostics" },
    ],
    [optInPromptActive],
  );

  const advancedTooltip = useMemo(
    () => (
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
                className="flex w-full items-center justify-between gap-3 rounded-sm px-1 py-0.5 text-left uppercase tracking-widest hover:bg-muted/30 hover:text-foreground kb-focus"
              >
                <span className="underline decoration-dotted underline-offset-2">{a.name}</span>
                <span className="text-foreground">{a.mode}</span>
              </button>
            </li>
          ))}
        </ul>
        <div className="border-t border-border pt-1">
          {refreshError ? (
            <div
              key="refresh-error-summary"
              role="alert"
              aria-live="assertive"
              className="mb-1 space-y-0.5 rounded-sm border border-orange/60 bg-orange/10 px-1.5 py-1 normal-case tracking-normal"
            >
              <div className="text-foreground">Refresh failed</div>
              <div className="break-words text-muted-foreground">
                {refreshError.code ? `${refreshError.code}: ` : null}
                {refreshError.message}
              </div>
              <div className="text-muted-foreground">
                {refreshError.at.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}
              </div>
            </div>
          ) : null}
          <div aria-live="polite" aria-atomic="true">
            Last evaluated {relativeLabel} <span className="text-muted-foreground normal-case no-underline">({evaluatedLabel})</span>
          </div>
          <div aria-live="polite" aria-atomic="true" className="text-muted-foreground">
            {lastUpdate
              ? `Last live update ${UPDATE_ORIGIN_LABEL[lastUpdate.origin]} · ${lastUpdate.at.toLocaleTimeString()}`
              : "No live update since this page opened"}
          </div>

          <button
            key="refresh-now-btn"
            type="button"
            aria-disabled={isRefreshingStatuses || isInCooldown}
            aria-busy={isRefreshingStatuses}
            aria-label={isRefreshingStatuses ? "Refreshing automation statuses" : isInCooldown ? `Refresh on cooldown, ${formatCooldown(cooldownMs)} remaining` : "Refresh automation statuses now"}
            onClick={() => {
              if (isRefreshingStatuses || isInCooldown) return;
              refreshStatuses("manual");
            }}
            onKeyDown={(e) => {
              if ((e.key === "Enter" || e.key === " ") && (isRefreshingStatuses || isInCooldown)) {
                e.preventDefault();
              }
            }}
            className={`mt-1 flex w-full items-center justify-between rounded-sm border border-border bg-muted/20 px-2 py-1 text-left uppercase tracking-widest text-foreground kb-focus ${isRefreshingStatuses || isInCooldown ? "pointer-events-none cursor-not-allowed opacity-40" : "hover:bg-muted/40"}`}
          >
            <span className="flex items-center gap-1.5">
              {isRefreshingStatuses ? <Spinner size={12} /> : <span aria-hidden="true">↻</span>}
              <span className="underline decoration-dotted underline-offset-2">Refresh now</span>
            </span>
            <span className="text-foreground">
              {isRefreshingStatuses
                ? "Checking…"
                : isInCooldown
                  ? `${formatCooldown(cooldownMs)}`
                  : evaluatedAt
                    ? `Last refreshed ${evaluatedLabel}`
                    : "Not yet refreshed"}
            </span>
          </button>
          {refreshError ? (
            <div
              key="refresh-error-detail"
              role="alert"
              aria-live="assertive"
              className="mt-1 space-y-1 rounded-sm border border-orange/60 bg-orange/10 px-2 py-1 normal-case tracking-normal"
            >
              <div className="text-foreground">Couldn’t refresh statuses</div>
              <div className="text-muted-foreground break-words">{refreshError.message}</div>
              <div className="flex items-center justify-between gap-2">
                <button
                  key="refresh-retry-btn"
                  ref={retryButtonRef}
                  type="button"
                  aria-disabled={isRefreshingStatuses || isInCooldown}
                  aria-busy={isRefreshingStatuses}
                  aria-label={isRefreshingStatuses ? "Retrying refresh" : isInCooldown ? `Retry on cooldown, ${formatCooldown(cooldownMs)} remaining` : "Retry refreshing automation statuses"}
                  onClick={() => {
                    if (isRefreshingStatuses || isInCooldown) return;
                    refreshStatuses("manual");
                  }}
                  onKeyDown={(e) => {
                    if ((e.key === "Enter" || e.key === " ") && (isRefreshingStatuses || isInCooldown)) {
                      e.preventDefault();
                    }
                  }}
                  className={`flex items-center gap-1.5 rounded-sm border border-orange/70 px-2 py-0.5 uppercase tracking-widest text-foreground kb-focus ${isRefreshingStatuses || isInCooldown ? "pointer-events-none cursor-not-allowed opacity-40" : "hover:bg-orange/20"}`}
                >
                  {isRefreshingStatuses ? <Spinner size={10} /> : null}
                  {isRefreshingStatuses ? "Retrying…" : isInCooldown ? `Retry in ${formatCooldown(cooldownMs)}` : "Retry"}
                </button>
                <button
                  key="refresh-dismiss-btn"
                  type="button"
                  onClick={() => {
                    setRefreshError(null);
                    setRefreshAttempts(0);
                    setCooldownMs(0);
                  }}
                  aria-label="Dismiss refresh error"
                  className="rounded-sm px-2 py-0.5 uppercase tracking-widest text-muted-foreground hover:text-foreground kb-focus"
                >
                  Dismiss
                </button>
              </div>
              {refreshAttempts > 1 ? (
                <div className="text-muted-foreground">
                  {refreshAttempts} failed attempts in a row.
                  {isInCooldown ? ` Retry disabled for ${formatCooldown(cooldownMs)}.` : null}
                </div>
              ) : null}
            </div>
          ) : null}
        </div>

      </div>
    ),
    [
      advancedAutomations,
      refreshError,
      relativeLabel,
      evaluatedLabel,
      isRefreshingStatuses,
      isInCooldown,
      cooldownMs,
      evaluatedAt,
      lastUpdate,
      refreshAttempts,
      jumpToAdvanced,
      refreshStatuses,
    ],
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

      <div
        aria-live="polite"
        aria-atomic="true"
        className="sr-only"
      >
        {statusAnnouncement}
      </div>

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

      {/* Page-level confirmation that a refresh click was handled. Visible on
          both tabs so the feedback is not hidden inside the ACTIVE tooltip. */}
      {isRefreshingStatuses && (
        <div
          data-testid="refresh-in-progress-banner"
          role="status"
          aria-live="polite"
          aria-atomic="true"
          className="mono mx-5 mt-4 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-sm border border-steel/60 bg-steel/10 px-3 py-2 text-[11px] text-paper md:mx-8"
        >
          <span className="flex items-center gap-2">
            <Spinner size={12} />
            <span className="uppercase tracking-widest">Refresh in progress</span>
          </span>
          <span className="text-muted-foreground">
            {refreshTrigger === "auto"
              ? "// automatic re-check running"
              : "// your click was handled — re-checking automation statuses"}
          </span>
          <span className="text-muted-foreground">
            {evaluatedAt ? `last refresh ${evaluatedLabel} (${relativeLabel})` : "no refresh yet"}
          </span>
        </div>
      )}

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
              tooltip={
                <div className="space-y-2 normal-case tracking-normal">
                  <div className="text-foreground">Declined-quote follow-up</div>
                  <p className="text-muted-foreground">
                    {declineMode === "auto"
                      ? "Automatically texts the customer asking why they declined, then captures their reply on the quote."
                      : declineMode === "manual"
                        ? "Shows an Ask why button in the dashboard so you can request feedback manually."
                        : "No follow-up is sent when a quote is declined."}
                  </p>
                  <TooltipCloseButton />
                </div>
              }
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
              aria-label="Declined-quote follow-up mode"
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
                ref={advancedBadgeRef}
                state={advancedActiveCount > 0 ? "active" : "off"}
                activeCount={advancedActiveCount}
                tooltip={advancedTooltip}
              />
              <button
                type="button"
                onClick={() => {
                  if (isRefreshingStatuses || isInCooldown) return;
                  refreshStatuses("manual");
                }}

                aria-disabled={isRefreshingStatuses || isInCooldown}
                aria-busy={isRefreshingStatuses}
                aria-label={isRefreshingStatuses ? "Refreshing automation statuses" : isInCooldown ? `Refresh on cooldown, ${formatCooldown(cooldownMs)} remaining` : "Refresh automation statuses now"}
                className={`mono flex items-center gap-1.5 text-[10px] uppercase tracking-widest text-muted-foreground underline decoration-dotted underline-offset-2 ${isRefreshingStatuses || isInCooldown ? "cursor-not-allowed opacity-40" : "hover:text-foreground"}`}
              >
                {isRefreshingStatuses ? <Spinner size={10} /> : null}
                {isRefreshingStatuses ? "Checking…" : isInCooldown ? `Retry in ${formatCooldown(cooldownMs)}` : "Refresh statuses"}
              </button>
              <div
                role="status"
                aria-live="polite"
                aria-atomic="true"
                className="mono flex items-center gap-1.5 text-[10px] uppercase tracking-widest"
              >
                <span
                  aria-hidden="true"
                  className={`h-1.5 w-1.5 rounded-full ${
                    realtimeState === "live"
                      ? "bg-moss"
                      : realtimeState === "reconnecting"
                        ? "animate-pulse bg-orange"
                        : realtimeState === "disconnected"
                          ? "bg-orange"
                          : "animate-pulse bg-muted-foreground"
                  }`}
                />
                <span className={realtimeState === "live" ? "text-muted-foreground" : "text-orange"}>
                  {realtimeState === "live"
                    ? "Live"
                    : realtimeState === "reconnecting"
                      ? `Reconnecting${realtimeAttempt > 1 ? ` (try ${realtimeAttempt})` : ""}…`
                      : realtimeState === "disconnected"
                        ? `Disconnected (try ${realtimeAttempt})`
                        : "Connecting…"}
                </span>
                <span className="text-muted-foreground/70 normal-case tracking-normal">
                  {lastSyncAt
                    ? `· synced ${lastSyncAt.toLocaleTimeString()}`
                    : "· not yet synced"}
                </span>
              </div>

              <button
                type="button"
                onClick={manualReconnect}
                disabled={realtimeState === "connecting"}
                aria-busy={realtimeState === "connecting"}
                aria-label="Reconnect Realtime now"
                className="mono kb-focus flex items-center gap-1 rounded-sm border border-border px-1.5 py-0.5 text-[10px] uppercase tracking-widest text-muted-foreground hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
              >
                {realtimeState === "connecting" ? <Spinner size={10} /> : <span aria-hidden="true">↻</span>}
                {realtimeState === "connecting" ? "Reconnecting…" : "Reconnect now"}
              </button>

              <button
                type="button"
                role="switch"
                aria-checked={realtimeToasts}
                aria-label="Toast me when live updates connect or drop"
                onClick={() => setRealtimeToastPref(!realtimeToasts)}
                className={`mono kb-focus rounded-sm border px-1.5 py-0.5 text-[10px] uppercase tracking-widest ${
                  realtimeToasts
                    ? "border-orange/60 text-foreground"
                    : "border-border text-muted-foreground hover:text-foreground"
                }`}
              >
                {realtimeToasts ? "Toasts on" : "Toasts off"}
              </button>


            </div>
          </div>
          <div className="mt-4 space-y-2">
            <div className="flex items-center justify-between gap-3 border-b border-border pb-2">
              <span className="text-xs text-muted-foreground">Opt-in prompt & cooldown</span>
              <AutomationBadge
                state={optInPromptActive ? "active" : "hold"}
                tooltip={
                  <div className="space-y-2 normal-case tracking-normal">
                    <div className="text-foreground">Opt-in prompt & cooldown</div>
                    <p className="text-muted-foreground">
                      {optInPromptActive
                        ? "Prompts can be sent to contacts with a genuine prior inbound engagement. A cooldown prevents duplicate prompts."
                        : "Real sends to customer numbers are paused. You can still edit the template and send test messages to your own number."}
                    </p>
                    <TooltipCloseButton />
                  </div>
                }
              />
            </div>
            <div className="flex items-center justify-between gap-3">
              <span className="text-xs text-muted-foreground">Inbound webhook diagnostics</span>
              <AutomationBadge
                state="off"
                label="Manual tool"
                tooltip={
                  <div className="space-y-2 normal-case tracking-normal">
                    <div className="text-foreground">Inbound webhook diagnostics</div>
                    <p className="text-muted-foreground">
                      A manual diagnostic tool for checking Twilio webhook connectivity and recent payload history. It does not run automatically.
                    </p>
                    <TooltipCloseButton />
                  </div>
                }
              />
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
        <div className="panel p-6 md:col-span-2">
          <div className="flex items-start justify-between gap-3">
            <div>
              <div className="label-eyebrow">Automation</div>
              <h2 className="mt-1 text-xl">Auto-refresh statuses</h2>
            </div>
            <AutomationBadge
              state={profile?.auto_refresh_enabled ? "active" : "off"}
              tooltip={
                <div className="space-y-2 normal-case tracking-normal">
                  <div className="text-foreground">Auto-refresh statuses</div>
                  <p className="text-muted-foreground">
                    {profile?.auto_refresh_enabled
                      ? "Periodically refreshes automation status badges while this page is open."
                      : "Status badges only refresh when you open the page or click Refresh statuses."}
                  </p>
                  <TooltipCloseButton />
                </div>
              }
            />
          </div>
          <p className="mt-2 text-xs text-muted-foreground">
            Automatically re-check automation statuses while this Settings page is open. Manual refresh and failure cooldown always take precedence.
          </p>
          <div className="mt-4 flex flex-col gap-4 sm:flex-row sm:items-center">
            <label className="mono flex cursor-pointer items-center gap-2 text-xs uppercase tracking-wider">
              <input
                type="checkbox"
                className="h-4 w-4 accent-primary"
                checked={autoRefreshEnabled}
                disabled={updateAutoRefresh.isPending}
                onChange={(e) => {
                  const enabled = e.target.checked;
                  setAutoRefreshEnabled(enabled);
                  updateAutoRefresh.mutate({ enabled, intervalMinutes: autoRefreshInterval });
                }}
              />
              {autoRefreshEnabled ? "Enabled" : "Disabled"}
            </label>
            <label className="flex flex-1 items-center gap-2">
              <span className="label-eyebrow whitespace-nowrap">Every</span>
              <input
                type="number"
                min={1}
                max={120}
                value={autoRefreshInterval}
                disabled={updateAutoRefresh.isPending}
                onChange={(e) => {
                  const raw = parseInt(e.target.value, 10);
                  const intervalMinutes = Number.isNaN(raw) ? 1 : Math.max(1, Math.min(120, raw));
                  setAutoRefreshInterval(intervalMinutes);
                }}
                onBlur={() => {
                  if (profile?.auto_refresh_enabled) {
                    updateAutoRefresh.mutate({ enabled: autoRefreshEnabled, intervalMinutes: autoRefreshInterval });
                  }
                }}
                className="mono w-20 rounded-sm border border-border bg-background px-3 py-2 text-sm"
              />
              <span className="text-xs text-muted-foreground">minutes (1–120)</span>
            </label>
          </div>
          {profile?.auto_refresh_enabled ? (
            <p className="mono mt-3 text-[10px] uppercase tracking-widest text-moss">
              Active · next refresh in {profile.auto_refresh_interval_minutes ?? 15} minutes while this page is visible
            </p>
          ) : (
            <p className="mono mt-3 text-[10px] uppercase tracking-widest text-muted-foreground">
              Off · enable above to schedule automatic re-checks
            </p>
          )}
        </div>

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


        <div id="adv-active-audit" className="scroll-mt-24 md:col-span-2">
          <ActiveChangeAuditPanel />
        </div>

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

function Spinner({ size = 12, className = "" }: { size?: number; className?: string }) {
  return (
    <svg
      aria-hidden="true"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      className={`animate-spin ${className}`}
    >
      <circle
        cx="12"
        cy="12"
        r="10"
        fill="none"
        stroke="currentColor"
        strokeWidth="3"
        strokeOpacity="0.25"
      />
      <path
        fill="none"
        stroke="currentColor"
        strokeWidth="3"
        strokeLinecap="round"
        d="M22 12a10 10 0 0 1-10 10"
      />
    </svg>
  );
}


const AutomationBadge = memo(forwardRef<
  { contains: (el: Node | null) => boolean; restoreFocus: (el: HTMLElement | null) => void },
  {
    state: "active" | "manual" | "hold" | "off";
    label?: string;
    activeCount?: number;
    tooltip?: React.ReactNode;
  }
>(function AutomationBadge({ state, label, activeCount, tooltip }, ref) {
  const styles: Record<string, string> = {
    active: "border-moss/60 bg-moss/15 text-moss-ink",
    manual: "border-steel/60 bg-steel/15 text-steel-ink",
    hold: "border-orange/60 bg-orange/15 text-orange-ink",
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
  // true once focus has entered the tooltip during this open cycle. Used to decide
  // whether to return focus to the trigger when the tooltip closes (Escape, outside
  // click, or Tab cycling), without resetting when focus later leaves the tooltip.
  const focusStartedInsideRef = useRef(false);
  const returnFocusToTrigger = () => {
    const trigger = triggerRef.current;
    if (!trigger || !trigger.isConnected || document.activeElement === trigger) return;
    suppressReopenRef.current = true;
    window.setTimeout(() => {
      trigger.focus();
      window.setTimeout(() => {
        suppressReopenRef.current = false;
      }, 0);
    }, 0);
  };

  // Expose methods to the parent so the refresh flow can restore focus to the
  // exact element that was focused inside the tooltip before the button disabled.
  useImperativeHandle(ref, () => ({
    contains: (el: Node | null) => containerRef.current?.contains(el ?? null) ?? false,
    restoreFocus: (el: HTMLElement | null) => {
      if (!el || !el.isConnected) return;
      // If focus never left, don't force it back — avoids screen-reader re-announcement.
      if (document.activeElement === el) return;
      // Reopen the tooltip if it closed, then hand focus back to the element.
      // Wait a tick so any re-render that re-enables the control has finished.
      setOpen(true);
      window.setTimeout(() => {
        window.requestAnimationFrame(() => {
          if ((el as HTMLButtonElement | null)?.disabled) return;
          el.focus();
        });
      }, 100);
    },


  }));

  useEffect(() => {
    if (!open) return;
    // Start each open cycle assuming focus has not yet entered the tooltip.
    focusStartedInsideRef.current = false;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
      }
    };
    const handleFocusIn = (e: FocusEvent) => {
      // Record that focus entered the tooltip at least once. We intentionally do
      // NOT reset this when focus leaves, so the close handler can still return
      // focus to the trigger after Escape, outside click, or Tab cycling.
      if (containerRef.current?.contains(e.target as Node)) {
        focusStartedInsideRef.current = true;
      }
    };
    const handlePointerDown = (e: PointerEvent | MouseEvent) => {
      const target = e.target as Node | null;
      if (target && containerRef.current?.contains(target)) return;
      setOpen(false);
    };
    document.addEventListener("keydown", handleKeyDown);
    document.addEventListener("focusin", handleFocusIn, true);
    document.addEventListener("pointerdown", handlePointerDown, true);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      document.removeEventListener("focusin", handleFocusIn, true);
      document.removeEventListener("pointerdown", handlePointerDown, true);
    };
  }, [open]);

  // Whenever the tooltip closes, return focus to the trigger if focus originated inside it.
  useEffect(() => {
    if (!open && focusStartedInsideRef.current) {
      focusStartedInsideRef.current = false;
      returnFocusToTrigger();
    }
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
        aria-label={`Automation status: ${text}. ${open ? "Hide details" : "Show details"}`}
        className="cursor-help rounded-sm kb-focus"
        onMouseEnter={show}
        onMouseLeave={hide}
        onFocus={show}
        onBlur={hide}
        onClick={() => setOpen((o) => !o)}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            if (open) {
              // Tooltip already open (e.g. from focus) — move focus inside instead of closing.
              window.setTimeout(() => {
                containerRef.current
                  ?.querySelector<HTMLButtonElement>(`#${CSS.escape(tooltipId)} button`)
                  ?.focus();
              }, 0);
            } else {
              setOpen(true);
              window.setTimeout(() => {
                containerRef.current
                  ?.querySelector<HTMLButtonElement>(`#${CSS.escape(tooltipId)} button`)
                  ?.focus();
              }, 0);
            }
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
        <TooltipCloseContext.Provider value={() => setOpen(false)}>
          {tooltip}
        </TooltipCloseContext.Provider>
      </span>
    </span>
  );
}));



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
