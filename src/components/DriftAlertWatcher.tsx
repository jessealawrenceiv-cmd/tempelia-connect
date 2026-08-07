import { useEffect, useRef } from "react";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useNavigate } from "@tanstack/react-router";
import { toast } from "sonner";
import { getLogActionDiagnostics } from "@/lib/log-action-diagnostics.functions";

const POLL_MS = 10 * 60 * 1000;
const SEEN_KEY = "temaro.driftAlert.lastSignature";

/**
 * Operator-only watcher: polls the action_type drift diagnostics and raises a
 * persistent dashboard toast whenever the generated enum no longer matches the
 * logs_action_type_check constraint in the database.
 *
 * Rendered only for admins (see AppShell). Non-admin calls throw "Forbidden"
 * and are swallowed silently.
 */
export function DriftAlertWatcher() {
  const getFn = useServerFn(getLogActionDiagnostics);
  const navigate = useNavigate();
  const shownRef = useRef<string | null>(null);

  const { data } = useQuery({
    queryKey: ["admin", "log-action-drift-alert"],
    queryFn: () => getFn(),
    retry: false,
    refetchInterval: POLL_MS,
    refetchOnWindowFocus: true,
    staleTime: POLL_MS,
  });

  useEffect(() => {
    if (!data || data.matched) return;

    const detail = [
      data.missingInDb.length ? `in code but not in database: ${data.missingInDb.join(", ")}` : null,
      data.missingInGenerated.length
        ? `in database but not in code: ${data.missingInGenerated.join(", ")}`
        : null,
      data.orderDiffers ? "same values, different order" : null,
    ]
      .filter(Boolean)
      .join(" · ");

    const signature = `${data.constraintName}|${detail}`;
    if (shownRef.current === signature) return;

    let lastSeen: string | null = null;
    try {
      lastSeen = window.localStorage.getItem(SEEN_KEY);
    } catch {
      /* private mode — alert every session */
    }
    if (lastSeen === signature) {
      shownRef.current = signature;
      return;
    }

    shownRef.current = signature;
    try {
      window.localStorage.setItem(SEEN_KEY, signature);
    } catch {
      /* ignore */
    }

    toast.error(`Drift check failed · ${data.constraintName}`, {
      description: detail || "The activity-log action types no longer match the database constraint.",
      duration: Infinity,
      action: {
        label: "Review",
        onClick: () => navigate({ to: "/dashboard/admin/log-actions" }),
      },
    });
  }, [data, navigate]);

  return null;
}
