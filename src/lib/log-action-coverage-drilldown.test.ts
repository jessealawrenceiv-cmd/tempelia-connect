import { describe, expect, it } from "vitest";
import { LOG_ACTION_TYPES, LogAction, type LogActionType } from "@/lib/log-action-types";
import type { BusinessSignals } from "@/lib/log-action-coverage";
import { describeGapDrilldown } from "@/lib/log-action-coverage-drilldown";

const signals = (over: Partial<BusinessSignals> = {}): BusinessSignals => ({
  hasPhoneNumber: false,
  reviewRequestsEnabled: false,
  intakeEnabled: false,
  voicemailEnabled: false,
  declineFollowupMode: "off",
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
  ...over,
});

describe("coverage gap drilldown", () => {
  it("covers every allowed action type with at least one source check", () => {
    for (const a of LOG_ACTION_TYPES as readonly LogActionType[]) {
      const d = describeGapDrilldown(a, signals());
      expect(d.sources.length, a).toBeGreaterThan(0);
      expect(d.presence).toHaveLength(2);
      for (const c of [...d.presence, ...d.sources]) {
        expect(c.table).toBeTruthy();
        expect(c.predicate).toBeTruthy();
        expect(c.window).toBeTruthy();
        expect(c.observed).toBeTruthy();
      }
    }
  });

  it("names both log tables and the action type in the presence checks", () => {
    const d = describeGapDrilldown(LogAction.sms_inbound, signals());
    expect(d.presence.map((c) => c.table)).toEqual(["public.logs", "public.logs_archive"]);
    for (const c of d.presence) {
      expect(c.predicate).toContain("action_type = 'sms_inbound'");
      expect(c.observed).toBe("0 rows");
      expect(c.outcome).toBe("no-rows");
    }
    expect(d.presence[0]!.window).toMatch(/90 days/);
    expect(d.presence[1]!.window).toMatch(/2 years/);
  });

  it("flags source rows that exist while log rows do not", () => {
    const d = describeGapDrilldown(
      LogAction.missed_call_autotext,
      signals({ hasPhoneNumber: true, missedCallWebhookCount: 3 }),
    );
    const hook = d.sources.find((c) => c.table === "public.webhook_events")!;
    expect(hook.predicate).toContain("event_kind = 'missed_call'");
    expect(hook.observed).toBe("3 rows");
    expect(hook.outcome).toBe("rows-exist");
    expect(d.notes.some((n) => n.includes("reconcile"))).toBe(true);
  });

  it("reports zero-row sources without the reconcile note", () => {
    const d = describeGapDrilldown(LogAction.invoice_balance_status, signals());
    expect(d.sources[0]!.observed).toBe("0 rows");
    expect(d.sources[0]!.outcome).toBe("no-rows");
    expect(d.notes.some((n) => n.includes("reconcile"))).toBe(false);
  });

  it("reports settings flags as config checks, not row counts", () => {
    const d = describeGapDrilldown(LogAction.voicemail_notify, signals({ hasPhoneNumber: true }));
    const flag = d.sources.find((c) => c.predicate === "voicemail_enabled")!;
    expect(flag.outcome).toBe("config");
    expect(flag.observed).toBe("false (disabled)");
    expect(flag.window).toMatch(/not versioned/);
  });

  it("states that the scan applies no created_at bound to source reads", () => {
    const d = describeGapDrilldown(LogAction.quote_sms, signals({ quoteCount: 2 }));
    expect(d.sources[0]!.window).toMatch(/All time/);
    expect(d.notes[0]).toMatch(/no created_at filter/);
  });

  it("surfaces the code-level hold for opt-in prompts", () => {
    const d = describeGapDrilldown(LogAction.opt_in_prompt, signals({ optedInCustomerCount: 5 }));
    expect(d.sources.some((c) => c.table.includes("opt-in-prompt-gate"))).toBe(true);
  });
});
