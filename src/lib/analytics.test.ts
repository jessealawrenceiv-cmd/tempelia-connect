// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createAnalytics } from "@/lib/analytics";

const captureMock = vi.fn();
const identifyMock = vi.fn();
const resetMock = vi.fn();
const initMock = vi.fn();

const fakePosthog = {
  init: (...args: unknown[]) => initMock(...args),
  capture: (...args: unknown[]) => captureMock(...args),
  identify: (...args: unknown[]) => identifyMock(...args),
  reset: (...args: unknown[]) => resetMock(...args),
} as unknown as typeof import("posthog-js").default;

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
  });

  it("initializes PostHog once and captures an event", () => {
    const { capture } = createAnalytics(fakePosthog);
    capture("deposit_jump_success", { quote_id: "q1" });
    expect(initMock).toHaveBeenCalledTimes(1);
    expect(initMock).toHaveBeenCalledWith("phc_test", {
      api_host: "https://us.i.posthog.com",
      capture_pageview: false,
      autocapture: false,
    });
    expect(captureMock).toHaveBeenCalledWith("deposit_jump_success", { quote_id: "q1" });

    capture("deposit_jump_success", { quote_id: "q2" });
    expect(initMock).toHaveBeenCalledTimes(1);
    expect(captureMock).toHaveBeenCalledTimes(2);
  });

  it("uses the EU host when region is eu", () => {
    setEnv("phc_test", "eu");
    const { capture } = createAnalytics(fakePosthog);
    capture("test");
    expect(initMock).toHaveBeenCalledWith(
      "phc_test",
      expect.objectContaining({ api_host: "https://eu.i.posthog.com" }),
    );
  });

  it("no-ops when PostHog token is not configured", () => {
    setEnv(undefined, undefined);
    const { capture } = createAnalytics(fakePosthog);
    capture("test");
    expect(initMock).not.toHaveBeenCalled();
    expect(captureMock).not.toHaveBeenCalled();
  });

  it("tracks a successful deposit jump", () => {
    const { trackDepositJump } = createAnalytics(fakePosthog);
    trackDepositJump({
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

  it("tracks a missed deposit jump with reason", () => {
    const { trackDepositJump } = createAnalytics(fakePosthog);
    trackDepositJump({
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

  it("identifies and resets users", () => {
    const { identify, reset } = createAnalytics(fakePosthog);
    identify("user-1", { email: "a@temaro.io" });
    expect(identifyMock).toHaveBeenCalledWith("user-1", { email: "a@temaro.io" });
    reset();
    expect(resetMock).toHaveBeenCalled();
  });
});

describe("deposit jump timing", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setEnv("phc_test", "us");
  });

  it("includes a rounded duration_ms when measured", () => {
    const { trackDepositJump } = createAnalytics(fakePosthog);
    trackDepositJump({
      kind: "success",
      quoteId: "q",
      eventId: "e",
      source: "eventId",
      durationMs: 123.6,
    });
    expect(captureMock).toHaveBeenCalledWith("deposit_jump_success", {
      quote_id: "q",
      event_id: "e",
      source: "eventId",
      duration_ms: 124,
    });
  });

  it("omits duration_ms when not measured", () => {
    const { trackDepositJump } = createAnalytics(fakePosthog);
    trackDepositJump({
      kind: "miss",
      quoteId: "q",
      eventId: "e",
      reason: "not_found",
      source: null,
      durationMs: null,
    });
    expect(captureMock).toHaveBeenCalledWith("deposit_jump_miss", {
      quote_id: "q",
      event_id: "e",
      reason: "not_found",
      source: null,
    });
  });
});
