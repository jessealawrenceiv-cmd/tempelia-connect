import { describe, expect, it } from "vitest";
import { LogAction, LOG_ACTION_TYPES } from "@/lib/log-action-types";
import { describeCoverageGap, sortGaps, type BusinessSignals } from "@/lib/log-action-coverage";

const base: BusinessSignals = {
  hasPhoneNumber: false,
  reviewRequestsEnabled: true,
  intakeEnabled: true,
  voicemailEnabled: true,
  declineFollowupMode: "auto",
  customerCount: 0,
  optedInCustomerCount: 0,
  excludedNumberCount: 0,
  quoteCount: 0,
  declinedQuoteCount: 0,
  depositQuoteCount: 0,
  invoiceCount: 0,
  intakeCount: 0,
  contactImportCount: 0,
  missedCallWebhookCount: 0,
  inboundSmsWebhookCount: 0,
  webhookDeliveryCount: 0,
};

describe("describeCoverageGap", () => {
  it("returns a cause for every allowed action type", () => {
    for (const a of LOG_ACTION_TYPES) {
      const r = describeCoverageGap(a, base);
      expect(r.cause.length).toBeGreaterThan(10);
      expect(["expected", "idle", "attention"]).toContain(r.severity);
    }
  });

  it("blames the missing number for telephony gaps", () => {
    const r = describeCoverageGap(LogAction.missed_call_text, base);
    expect(r.severity).toBe("expected");
    expect(r.cause).toMatch(/no phone number/i);
  });

  it("flags missed-call webhooks without log rows for review", () => {
    const r = describeCoverageGap(LogAction.missed_call_text, {
      ...base,
      hasPhoneNumber: true,
      missedCallWebhookCount: 3,
    });
    expect(r.severity).toBe("attention");
    expect(r.cause).toContain("3");
  });

  it("treats a provisioned number without a provisioning entry as reconcilable", () => {
    expect(describeCoverageGap(LogAction.number_provisioned, { ...base, hasPhoneNumber: true }).severity)
      .toBe("attention");
    expect(describeCoverageGap(LogAction.number_provisioned, base).severity).toBe("expected");
  });

  it("explains disabled features rather than raising alarms", () => {
    expect(
      describeCoverageGap(LogAction.review_request, { ...base, reviewRequestsEnabled: false }).severity,
    ).toBe("expected");
    expect(
      describeCoverageGap(LogAction.voicemail_notify, {
        ...base,
        hasPhoneNumber: true,
        voicemailEnabled: false,
      }).severity,
    ).toBe("expected");
    expect(
      describeCoverageGap(LogAction.quote_decline_followup, {
        ...base,
        declinedQuoteCount: 2,
        declineFollowupMode: "off",
      }).severity,
    ).toBe("expected");
  });

  it("keeps the opt-in prompt hold as an expected gap", () => {
    const r = describeCoverageGap(LogAction.opt_in_prompt, base);
    expect(r.severity).toBe("expected");
    expect(r.cause).toMatch(/held/i);
  });

  it("sorts attention gaps first", () => {
    const sorted = sortGaps([
      { actionType: LogAction.review_request, severity: "expected", cause: "x" },
      { actionType: LogAction.quote_sms, severity: "attention", cause: "y" },
      { actionType: LogAction.sms_inbound, severity: "idle", cause: "z" },
    ]);
    expect(sorted.map((g) => g.severity)).toEqual(["attention", "idle", "expected"]);
  });
});
