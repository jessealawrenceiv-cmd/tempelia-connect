/**
 * Product-analytics wrapper.
 *
 * Uses PostHog when the workspace has linked a PostHog connection
 * (VITE_LOVABLE_CONNECTOR_POSTHOG_API_KEY). When the key is absent the
 * capture helpers no-op, so the app keeps working without a configured
 * connector.
 */

import posthog from "posthog-js";

function readEnv() {
  return {
    token: import.meta.env.VITE_LOVABLE_CONNECTOR_POSTHOG_API_KEY as string | undefined,
    region: (import.meta.env.VITE_LOVABLE_CONNECTOR_POSTHOG_REGION as string | undefined) || "us",
  };
}

export type DepositJumpResult =
  | {
      kind: "success";
      quoteId: string;
      eventId: string;
      source: string | null;
      durationMs?: number | null;
      correlationId?: string | null;
    }
  | {
      kind: "miss";
      quoteId: string;
      eventId: string;
      reason: string;
      source: string | null;
      durationMs?: number | null;
      correlationId?: string | null;
    };

/** Stable id for one deep-link/empty-state session, shared by every deposit_jump_* event. */
export function createDepositJumpCorrelationId(): string {
  const rand =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID().slice(0, 8)
      : Math.random().toString(36).slice(2, 10);
  return `djp-${Date.now().toString(36)}-${rand}`;
}

export function createAnalytics(posthogClient: typeof posthog = posthog) {
  let initialized = false;

  function init() {
    if (initialized) return;
    const { token, region } = readEnv();
    if (!token) return;
    if (typeof window === "undefined") return;
    const apiHost = region === "us" ? "https://us.i.posthog.com" : "https://eu.i.posthog.com";
    posthogClient.init(token, {
      api_host: apiHost,
      capture_pageview: false,
      autocapture: false,
    });
    initialized = true;
  }

  function capture(event: string, properties?: Record<string, unknown>) {
    init();
    if (!initialized) return;
    posthogClient.capture(event, properties ?? {});
  }

  function identify(userId: string, properties?: Record<string, unknown>) {
    init();
    if (!initialized) return;
    posthogClient.identify(userId, properties ?? {});
  }

  function reset() {
    init();
    if (!initialized) return;
    posthogClient.reset();
  }

  function trackDepositJump(result: DepositJumpResult) {
    // Only send duration when measured, so events without timing stay clean.
    const timing =
      typeof result.durationMs === "number" && Number.isFinite(result.durationMs)
        ? { duration_ms: Math.round(result.durationMs) }
        : {};
    const correlation = result.correlationId ? { correlation_id: result.correlationId } : {};
    if (result.kind === "success") {
      capture("deposit_jump_success", {
        quote_id: result.quoteId,
        event_id: result.eventId,
        source: result.source,
        ...correlation,
        ...timing,
      });
    } else {
      capture("deposit_jump_miss", {
        quote_id: result.quoteId,
        event_id: result.eventId,
        reason: result.reason,
        source: result.source,
        ...correlation,
        ...timing,
      });
    }
  }

  /**
   * Recovery action taken from the deep-link "not found" empty state — lets us
   * measure how often a miss ends in the reader bailing to the timeline top.
   */
  function trackDepositJumpRecovery(input: {
    action: "return_to_top" | "show_latest" | "clear_filters" | "dismiss";
    quoteId: string;
    eventId: string | null;
    reason: string | null;
    msSinceMiss?: number | null;
    correlationId?: string | null;
  }) {
    capture("deposit_jump_recovery", {
      action: input.action,
      quote_id: input.quoteId,
      event_id: input.eventId,
      reason: input.reason,
      ...(input.correlationId ? { correlation_id: input.correlationId } : {}),
      ...(typeof input.msSinceMiss === "number" && Number.isFinite(input.msSinceMiss)
        ? { ms_since_miss: Math.round(input.msSinceMiss) }
        : {}),
    });
  }

  return { capture, identify, reset, trackDepositJump, trackDepositJumpRecovery };
}

const defaultAnalytics = createAnalytics();
export const { capture, identify, reset, trackDepositJump, trackDepositJumpRecovery } =
  defaultAnalytics;
