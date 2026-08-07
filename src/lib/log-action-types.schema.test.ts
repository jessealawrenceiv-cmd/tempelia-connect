import { describe, it, expect } from "vitest";
import { LOG_ACTION_TYPES, LogAction } from "./log-action-types.generated";
import {
  logActionTypeSchema,
  logActionTypeFilterSchema,
  logActionTypeListSchema,
  logRowSchema,
  logRowsSchema,
  parseLogActionType,
  safeParseLogActionType,
} from "./log-action-types.schema";

describe("logActionTypeSchema", () => {
  it("accepts every generated value", () => {
    for (const t of LOG_ACTION_TYPES) {
      expect(logActionTypeSchema.parse(t)).toBe(t);
    }
  });

  it("rejects strings outside the whitelist", () => {
    for (const bad of ["not_allowed", "drop table logs", "", "STATUS_REFRESH", " status_refresh "]) {
      expect(logActionTypeSchema.safeParse(bad).success).toBe(false);
    }
  });

  it("rejects non-string values", () => {
    for (const bad of [null, undefined, 1, {}, ["status_refresh"], true]) {
      expect(logActionTypeSchema.safeParse(bad).success).toBe(false);
    }
  });

  it("treats undefined as no filter in the optional form", () => {
    expect(logActionTypeFilterSchema.parse(undefined)).toBeUndefined();
    expect(logActionTypeFilterSchema.parse(LogAction.status_refresh)).toBe("status_refresh");
    expect(logActionTypeFilterSchema.safeParse("bogus").success).toBe(false);
  });

  it("validates list filters and requires at least one value", () => {
    expect(logActionTypeListSchema.parse([LogAction.quote_sms, LogAction.invoice_sms])).toHaveLength(2);
    expect(logActionTypeListSchema.safeParse([]).success).toBe(false);
    expect(logActionTypeListSchema.safeParse([LogAction.quote_sms, "nope"]).success).toBe(false);
  });
});

describe("logRowSchema", () => {
  it("accepts a well-formed row and strips unknown keys", () => {
    const parsed = logRowSchema.parse({
      action_type: LogAction.review_request,
      status: "sent",
      message_sent: "hello",
      injected_column: "ignored",
    });
    expect(parsed.action_type).toBe("review_request");
    expect("injected_column" in parsed).toBe(false);
  });

  it("rejects an invalid action_type on a row", () => {
    const res = logRowSchema.safeParse({ action_type: "made_up", status: "sent" });
    expect(res.success).toBe(false);
  });

  it("rejects a bad customer_id", () => {
    expect(
      logRowSchema.safeParse({ action_type: LogAction.quote_sms, customer_id: "not-a-uuid" }).success,
    ).toBe(false);
  });

  it("validates batches and rejects a batch containing one bad row", () => {
    expect(
      logRowsSchema.safeParse([
        { action_type: LogAction.quote_sms },
        { action_type: LogAction.status_refresh },
      ]).success,
    ).toBe(true);
    expect(
      logRowsSchema.safeParse([{ action_type: LogAction.quote_sms }, { action_type: "bad" }]).success,
    ).toBe(false);
    expect(logRowsSchema.safeParse([]).success).toBe(false);
  });
});

describe("parse helpers", () => {
  it("parseLogActionType throws with the allowed values listed", () => {
    expect(() => parseLogActionType("bogus")).toThrow(/Invalid logs\.action_type "bogus"/);
    expect(() => parseLogActionType("bogus")).toThrow(/status_refresh/);
    expect(parseLogActionType(LogAction.invoice_balance_status)).toBe("invoice_balance_status");
  });

  it("safeParseLogActionType returns an error payload instead of throwing", () => {
    expect(safeParseLogActionType(LogAction.sms_inbound)).toEqual({ ok: true, value: "sms_inbound" });
    const bad = safeParseLogActionType("sms_inbound; drop");
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.error).toMatch(/Allowed values:/);
  });
});
