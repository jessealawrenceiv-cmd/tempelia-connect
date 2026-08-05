/**
 * Product-analytics wrapper.
 *
 * Uses PostHog when the workspace has linked a PostHog connection
 * (VITE_LOVABLE_CONNECTOR_POSTHOG_API_KEY). When the key is absent the
 * capture helpers no-op, so the app keeps working without a configured
 * connector.
 */

import posthog from "posthog-js";

const PROJECT_TOKEN = import.meta.env.VITE_LOVABLE_CONNECTOR_POSTHOG_API_KEY;
const REGION = import.meta.env.VITE_LOVABLE_CONNECTOR_POSTHOG_REGION || "us";
const API_HOST = REGION === "us" ? "https://us.i.posthog.com" : "https://eu.i.posthog.com";

let initialized = false;

function init() {
  if (initialized) return;
  if (!PROJECT_TOKEN) return;
  if (typeof window === "undefined") return;
  posthog.init(PROJECT_TOKEN, {
    api_host: API_HOST,
    capture_pageview: false,
    autocapture: false,
  });
  initialized = true;
}

export function capture(event: string, properties?: Record<string, unknown>) {
  init();
  if (!initialized) return;
  posthog.capture(event, properties ?? {});
}

export function identify(userId: string, properties?: Record<string, unknown>) {
  init();
  if (!initialized) return;
  posthog.identify(userId, properties ?? {});
}

export function reset() {
  init();
  if (!initialized) return;
  posthog.reset();
}

export type DepositJumpResult =
  | { kind: "success"; quoteId: string; eventId: string; source: string | null }
  | { kind: "miss"; quoteId: string; eventId: string; reason: string; source: string | null };

export function trackDepositJump(result: DepositJumpResult) {
  if (result.kind === "success") {
    capture("deposit_jump_success", {
      quote_id: result.quoteId,
      event_id: result.eventId,
      source: result.source,
    });
  } else {
    capture("deposit_jump_miss", {
      quote_id: result.quoteId,
      event_id: result.eventId,
      reason: result.reason,
      source: result.source,
    });
  }
}
