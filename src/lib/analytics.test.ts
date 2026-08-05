import { beforeEach, describe, expect, it, vi } from "vitest";
import { capture, identify, reset, trackDepositJump } from "@/lib/analytics";

const captureMock = vi.fn();
const identifyMock = vi.fn();
const resetMock = vi.fn();
const initMock = vi.fn();

vi.mock("posthog-js", () => ({
  default: {
    init: (...args: unknown[]) => initMock(...args),
    capture: (...args: unknown[]) => captureMock(...args),
    identify: (...args: unknown[]) => identifyMock(...args),
    reset: (...args: unknown[]) => resetMock(...args),
  },
}));

function setEnv(token?: string, region?: string) {
  if (token != null) {
    import.meta.env.VITE_LOVABLE_CONNECTOR_POSTHOG_API_KEY = token;
  } else {
    delete import.meta.env.VITE_LOVABLE_CONNECTOR_POSTHOG_API_KEY;
  }
  if (region != null) {
    import.meta.env.VITE_LOVABLE_CONNECTOR_POSTHOG_REGION = region;
  } else {
    delete import.meta.env.VITE_LOVABLE_CONNECTOR_POSTHOG_REGION;
  }
}

describe("analytics", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setEnv("phc_test", "us");
    // Force re-initialization on the next capture by reloading the module state.
    // We do this by mutating the internal flag via a side-effect import helper.
    vi.resetModules();
  });

  it("initializes PostHog once and captures an event", async () => {
    const { capture: captureFresh } = await import("@/lib/analytics");
    captureFresh("deposit_jump_success", { quote_id: "q1" });
    expect(initMock).toHaveBeenCalledTimes(1);
    expect(initMock).toHaveBeenCalledWith("phc_test", {
      api_host: "https://us.i.posthog.com",
      capture_pageview: false,
      autocapture: false,
    });
    expect(captureMock).toHaveBeenCalledWith("deposit_jump_success", { quote_id: "q1" });

    captureFresh("deposit_jump_success", { quote_id: "q2" });
    expect(initMock).toHaveBeenCalledTimes(1);
    expect(captureMock).toHaveBeenCalledTimes(2);
  });

  it("uses the EU host when region is eu", async () => {
    setEnv("phc_test", "eu");
    const { capture: captureFresh } = await import("@/lib/analytics");
    captureFresh("test");
    expect(initMock).toHaveBeenCalledWith(
      "phc_test",
      expect.objectContaining({ api_host: "https://eu.i.posthog.com" }),
    );
  });

  it("no-ops when PostHog token is not configured", async () => {
    setEnv(undefined, undefined);
    const { capture: captureFresh } = await import("@/lib/analytics");
    captureFresh("test");
    expect(initMock).not.toHaveBeenCalled();
    expect(captureMock).not.toHaveBeenCalled();
  });

  it("tracks a successful deposit jump", async () => {
    const { trackDepositJump: trackFresh } = await import("@/lib/analytics");
    trackFresh({
      kind: "success",
      quoteId: "quote-1",
      eventId: "evt-1",
      source: "eventId",
    });
    expect(captureMock).toHaveBeenCalledWith("deposit_jump_success", {
      quote_id: "quote-1",
      event_id: "evt-1",
      source: "eventId",
    });
  });

  it("tracks a missed deposit jump with reason", async () => {
    const { trackDepositJump: trackFresh } = await import("@/lib/analytics");
    trackFresh({
      kind: "miss",
      quoteId: "quote-2",
      eventId: "evt-2",
      reason: "filtered",
      source: "hash",
    });
    expect(captureMock).toHaveBeenCalledWith("deposit_jump_miss", {
      quote_id: "quote-2",
      event_id: "evt-2",
      reason: "filtered",
      source: "hash",
    });
  });

  it("identifies and resets users", async () => {
    const { identify: identifyFresh, reset: resetFresh } = await import("@/lib/analytics");
    identifyFresh("user-1", { email: "a@temaro.io" });
    expect(identifyMock).toHaveBeenCalledWith("user-1", { email: "a@temaro.io" });
    resetFresh();
    expect(resetMock).toHaveBeenCalled();
  });
});
