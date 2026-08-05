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

describe("analytics", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal("import", {
      meta: {
        env: {
          VITE_LOVABLE_CONNECTOR_POSTHOG_API_KEY: "phc_test",
          VITE_LOVABLE_CONNECTOR_POSTHOG_REGION: "us",
        },
      },
    });
  });

  it("initializes PostHog once and captures an event", () => {
    capture("deposit_jump_success", { quote_id: "q1" });
    expect(initMock).toHaveBeenCalledTimes(1);
    expect(initMock).toHaveBeenCalledWith("phc_test", {
      api_host: "https://us.i.posthog.com",
      capture_pageview: false,
      autocapture: false,
    });
    expect(captureMock).toHaveBeenCalledWith("deposit_jump_success", { quote_id: "q1" });

    // Second call should not re-initialize.
    capture("deposit_jump_success", { quote_id: "q2" });
    expect(initMock).toHaveBeenCalledTimes(1);
    expect(captureMock).toHaveBeenCalledTimes(2);
  });

  it("uses the EU host when region is eu", () => {
    vi.stubGlobal("import", {
      meta: {
        env: {
          VITE_LOVABLE_CONNECTOR_POSTHOG_API_KEY: "phc_test",
          VITE_LOVABLE_CONNECTOR_POSTHOG_REGION: "eu",
        },
      },
    });
    capture("test");
    expect(initMock).toHaveBeenCalledWith(
      "phc_test",
      expect.objectContaining({ api_host: "https://eu.i.posthog.com" }),
    );
  });

  it("no-ops when PostHog token is not configured", () => {
    vi.stubGlobal("import", {
      meta: { env: {} },
    });
    capture("test");
    expect(initMock).not.toHaveBeenCalled();
    expect(captureMock).not.toHaveBeenCalled();
  });

  it("tracks a successful deposit jump", () => {
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
    identify("user-1", { email: "a@temaro.io" });
    expect(identifyMock).toHaveBeenCalledWith("user-1", { email: "a@temaro.io" });
    reset();
    expect(resetMock).toHaveBeenCalled();
  });
});
