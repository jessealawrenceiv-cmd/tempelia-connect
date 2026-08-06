import { useEffect, useState } from "react";

/**
 * Tracks the user's `prefers-reduced-motion` setting.
 *
 * Returns false during SSR / first paint (matching the CSS default), then
 * syncs on mount and on every OS-level preference change. Consumers use this
 * to drop animation-length delays so focus handoff happens synchronously and
 * keyboard navigation is never blocked by an in-flight transition.
 */
export function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);

  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    setReduced(mq.matches);
    const onChange = (e: MediaQueryListEvent) => setReduced(e.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);

  return reduced;
}

/** Non-reactive read, for use inside event handlers and imperative code. */
export function prefersReducedMotion(): boolean {
  if (typeof window === "undefined" || !window.matchMedia) return false;
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}
