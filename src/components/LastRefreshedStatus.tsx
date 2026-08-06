import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { supabase } from "@/integrations/supabase/client";
import { useEffect, useRef, useState } from "react";

function relative(from: Date, now: Date) {
  const secs = Math.max(0, Math.round((now.getTime() - from.getTime()) / 1000));
  if (secs < 45) return "just now";
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

/**
 * Compact "Last refreshed" readout for the automation statuses, sourced from
 * the same server-side refresh lock that Settings uses, so Home and Settings
 * can never disagree.
 *
 * Also owns the Home dashboard's screen-reader live region: after every
 * refresh it announces the current automation statuses plus the last
 * refreshed time.
 */
export function LastRefreshedStatus({ className = "" }: { className?: string }) {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = window.setInterval(() => setNow(new Date()), 30_000);
    return () => window.clearInterval(id);
  }, []);

  const { data } = useQuery({
    queryKey: ["status-refresh", "last-finished"],
    queryFn: async () => {
      const { data: u } = await supabase.auth.getUser();
      if (!u.user) return null;
      const { data: row } = await supabase
        .from("status_refresh_locks")
        .select("last_finished_at, last_result, locked_at, released_at")
        .eq("user_id", u.user.id)
        .maybeSingle();
      return row ?? null;
    },
    refetchInterval: 60_000,
  });

  const { data: automations } = useQuery({
    queryKey: ["home-automation-status"],
    queryFn: async () => {
      const { data: u } = await supabase.auth.getUser();
      if (!u.user) return null;
      const { data: row } = await supabase
        .from("profiles")
        .select("review_requests_enabled, intake_enabled, voicemail_enabled")
        .eq("id", u.user.id)
        .maybeSingle();
      return row ?? null;
    },
    refetchInterval: 60_000,
  });

  const finishedAt = data?.last_finished_at ? new Date(data.last_finished_at) : null;
  const running = Boolean(data?.locked_at && !data?.released_at);

  const label = running
    ? "Refreshing statuses…"
    : finishedAt
      ? `Last refreshed ${relative(finishedAt, now)} · ${finishedAt.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`
      : "Not yet refreshed";

  // ---- Screen-reader announcement, re-fired on each completed refresh ----
  const [announcement, setAnnouncement] = useState("");
  const lastKeyRef = useRef<string | null>(null);

  useEffect(() => {
    if (running) {
      if (lastKeyRef.current !== "running") {
        lastKeyRef.current = "running";
        setAnnouncement("Refreshing automation statuses.");
      }
      return;
    }
    const key = `${data?.last_finished_at ?? "none"}|${data?.last_result ?? ""}|${automations?.review_requests_enabled}|${automations?.intake_enabled}|${automations?.voicemail_enabled}`;
    if (lastKeyRef.current === key) return;
    const hadPrevious = lastKeyRef.current !== null;
    lastKeyRef.current = key;

    const parts: string[] = [];
    if (automations) {
      parts.push(
        `Automation status: review requests ${automations.review_requests_enabled ? "on" : "off"}, ` +
          `intake form ${automations.intake_enabled ? "on" : "off"}, ` +
          `voicemail ${automations.voicemail_enabled ? "on" : "off"}.`,
      );
    }
    parts.push(
      finishedAt
        ? `Statuses last refreshed at ${finishedAt.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}${
            data?.last_result ? `, result ${data.last_result}` : ""
          }.`
        : "Statuses have not been refreshed yet.",
    );
    // Reset first so identical repeat text is still announced.
    if (hadPrevious) setAnnouncement("");
    const id = window.setTimeout(() => setAnnouncement(parts.join(" ")), hadPrevious ? 60 : 0);
    return () => window.clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [running, data?.last_finished_at, data?.last_result, automations?.review_requests_enabled, automations?.intake_enabled, automations?.voicemail_enabled]);

  return (
    <>
      <Link
        to="/dashboard/settings"
        title={finishedAt ? `Automation statuses last re-checked ${finishedAt.toLocaleString()}` : "Statuses have not been re-checked yet"}
        className={`mono text-[10px] uppercase tracking-widest text-muted-foreground hover:text-foreground ${className}`}
      >
        {label}
      </Link>
      <span role="status" aria-live="polite" aria-atomic="true" className="sr-only">
        {announcement}
      </span>
    </>
  );
}
