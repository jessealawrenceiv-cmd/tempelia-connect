import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { supabase } from "@/integrations/supabase/client";
import { useEffect, useState } from "react";

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

  const finishedAt = data?.last_finished_at ? new Date(data.last_finished_at) : null;
  const running = Boolean(data?.locked_at && !data?.released_at);

  return (
    <Link
      to="/dashboard/settings"
      title={finishedAt ? `Automation statuses last re-checked ${finishedAt.toLocaleString()}` : "Statuses have not been re-checked yet"}
      className={`mono text-[10px] uppercase tracking-widest text-muted-foreground hover:text-foreground ${className}`}
      aria-live="polite"
    >
      {running
        ? "Refreshing statuses…"
        : finishedAt
          ? `Last refreshed ${relative(finishedAt, now)} · ${finishedAt.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`
          : "Not yet refreshed"}
    </Link>
  );
}
