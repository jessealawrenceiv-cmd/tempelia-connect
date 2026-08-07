/**
 * Correlation presentation: a missed-call webhook that never produced an
 * Activity log entry must read as a failure everywhere it surfaces, and unknown
 * or missing DB values must degrade to "linking" rather than crashing the panel.
 */
import { describe, expect, it } from "vitest";
import {
  CORRELATION_STATES,
  correlationApplies,
  correlationPresentation,
  correlationState,
  countCorrelationFailures,
} from "./webhook-correlation";

describe("correlationState", () => {
  it("passes through every known state", () => {
    for (const s of CORRELATION_STATES) expect(correlationState(s)).toBe(s);
  });

  it("falls back to pending for null, empty, and unknown values", () => {
    expect(correlationState(null)).toBe("pending");
    expect(correlationState(undefined)).toBe("pending");
    expect(correlationState("")).toBe("pending");
    expect(correlationState("something_new")).toBe("pending");
  });
});

describe("correlationPresentation", () => {
  it("flags only the missing state as a failure", () => {
    expect(correlationPresentation("missing").isFailure).toBe(true);
    expect(correlationPresentation("correlated").isFailure).toBe(false);
    expect(correlationPresentation("pending").isFailure).toBe(false);
    expect(correlationPresentation("not_applicable").isFailure).toBe(false);
  });

  it("gives every state a label, description, and semantic tone token", () => {
    for (const s of CORRELATION_STATES) {
      const p = correlationPresentation(s);
      expect(p.label.length).toBeGreaterThan(0);
      expect(p.description.length).toBeGreaterThan(0);
      // Semantic tokens only — never a hard-coded colour.
      expect(p.tone).toMatch(/^text-[a-z-]+$/);
      expect(p.tone).not.toMatch(/#|\[/);
    }
  });
});

describe("correlationApplies", () => {
  it("only applies to missed-call hits", () => {
    expect(correlationApplies("missed_call")).toBe(true);
    expect(correlationApplies("sms_inbound")).toBe(false);
    expect(correlationApplies("recording_status")).toBe(false);
  });
});

describe("countCorrelationFailures", () => {
  it("counts flagged missed calls and ignores other kinds", () => {
    const rows = [
      { event_kind: "missed_call", correlation_state: "missing" },
      { event_kind: "missed_call", correlation_state: "correlated" },
      { event_kind: "missed_call", correlation_state: "pending" },
      { event_kind: "missed_call", correlation_state: null },
      // A non-missed-call hit is never expected to produce a missed-call entry.
      { event_kind: "sms_inbound", correlation_state: "missing" },
    ];
    expect(countCorrelationFailures(rows)).toBe(1);
  });

  it("returns 0 for an empty log", () => {
    expect(countCorrelationFailures([])).toBe(0);
  });
});
