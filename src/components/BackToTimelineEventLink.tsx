import { useLocation } from "@tanstack/react-router";

/**
 * Renders a "back to this timeline event" link when the current page was opened
 * from a deposit status timeline entry (depositEvent + returnTo search params).
 * The link returns to the originating page anchored at the exact event row.
 */
export function BackToTimelineEventLink({ className = "" }: { className?: string }) {
  const location = useLocation();
  const params = new URLSearchParams(location.searchStr ?? "");
  const eventId = params.get("eventId") ?? params.get("depositEvent");
  const returnTo = params.get("returnTo");
  if (!eventId || !returnTo || !returnTo.startsWith("/")) return null;

  const id = encodeURIComponent(eventId);
  const href = `${returnTo}${returnTo.includes("?") ? "&" : "?"}eventId=${id}&depositEvent=${id}#deposit-event-${id}`;

  return (
    <a
      href={href}
      className={`mono inline-flex items-center gap-1 text-[10px] uppercase tracking-widest text-violet underline decoration-dotted underline-offset-2 hover:text-violet/80 print:hidden ${className}`}
    >
      ← back to this timeline event
    </a>
  );
}
