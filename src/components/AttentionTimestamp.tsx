import { useState } from "react";
import { exactTime, relativeTime } from "@/lib/relative-time";

/**
 * Shows a relative time ("3 days ago") with the exact timestamp on hover,
 * and toggles to the exact timestamp on click/Enter. Safe to render inside a
 * link: it stops propagation so it never triggers navigation.
 */
export function AttentionTimestamp({ iso, label = "Submitted" }: { iso: string | null | undefined; label?: string }) {
  const [showExact, setShowExact] = useState(false);
  const exact = exactTime(iso);
  const relative = relativeTime(iso);

  return (
    <span
      role="button"
      tabIndex={0}
      aria-label={`${label} ${exact}`}
      title={`${label} ${exact}`}
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        setShowExact((v) => !v);
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          e.stopPropagation();
          setShowExact((v) => !v);
        }
      }}
      className="mono kb-focus cursor-help border-b border-dotted border-moss/50 text-[10px] uppercase tracking-widest text-moss"
    >
      {showExact ? exact : relative}
    </span>
  );
}
