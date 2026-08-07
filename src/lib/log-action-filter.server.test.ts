/**
 * Server-side action_type filter enforcement.
 *
 * These tests treat the client guard as absent: they call the server helpers
 * directly with values a bypassing caller could send.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LOG_ACTION_TYPES, LogAction } from "@/lib/log-action-types.generated";
import {
  LogActionFilterError,
  assertLogActionFilter,
  assertLogActionFilters,
  assertOptionalLogActionFilter,
  checkLogActionFilters,
} from "./log-action-filter.server";

let warn: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  warn = vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => warn.mockRestore());

describe("assertLogActionFilter", () => {
  it("accepts every generated whitelist value", () => {
    for (const type of LOG_ACTION_TYPES) {
      expect(assertLogActionFilter("test", type)).toBe(type);
    }
  });

  it("rejects unknown strings with a 400-shaped error", () => {
    try {
      assertLogActionFilter("test.endpoint", "logs; drop table");
      throw new Error("expected a rejection");
    } catch (err) {
      expect(err).toBeInstanceOf(LogActionFilterError);
      const e = err as LogActionFilterError;
      expect(e.status).toBe(400);
      expect(e.code).toBe("invalid_action_type_filter");
      expect(e.endpoint).toBe("test.endpoint");
      expect(e.rejected).toEqual(["logs; drop table"]);
      expect(e.message).toContain("Allowed values:");
    }
  });

  it("rejects non-string values", () => {
    for (const bad of [null, 42, {}, [], true]) {
      expect(() => assertLogActionFilter("test", bad)).toThrow(LogActionFilterError);
    }
  });

  it("logs a greppable structured warning on rejection", () => {
    expect(() => assertLogActionFilter("test.endpoint", "nope")).toThrow();
    const line = String(warn.mock.calls[0]?.[0] ?? "");
    expect(line).toContain("logs_action_type_filter_rejected");
    expect(line).toContain("test.endpoint");
  });
});

describe("assertLogActionFilters", () => {
  it("accepts a valid list and de-duplicates", () => {
    expect(
      assertLogActionFilters("test", [LogAction.sms_inbound, LogAction.sms_inbound, LogAction.missed_call_text]),
    ).toEqual([LogAction.sms_inbound, LogAction.missed_call_text]);
  });

  it("rejects atomically when valid and invalid values are mixed", () => {
    try {
      assertLogActionFilters("test", [LogAction.sms_inbound, "made_up", "also_fake"]);
      throw new Error("expected a rejection");
    } catch (err) {
      expect(err).toBeInstanceOf(LogActionFilterError);
      // Never partially applied: the caller gets no filtered result set.
      expect((err as LogActionFilterError).rejected).toEqual(["made_up", "also_fake"]);
    }
  });

  it("rejects an empty list rather than matching nothing", () => {
    expect(() => assertLogActionFilters("test", [])).toThrow(/empty action_type list/i);
  });

  it("rejects non-array input", () => {
    expect(() => assertLogActionFilters("test", LogAction.sms_inbound)).toThrow(
      /expected an array/i,
    );
  });
});

describe("assertOptionalLogActionFilter", () => {
  it("treats undefined, null and empty string as no filter", () => {
    for (const empty of [undefined, null, ""]) {
      expect(assertOptionalLogActionFilter("test", empty)).toBeUndefined();
    }
  });

  it("still validates any provided value", () => {
    expect(assertOptionalLogActionFilter("test", LogAction.review_request)).toBe(
      LogAction.review_request,
    );
    expect(() => assertOptionalLogActionFilter("test", "bogus")).toThrow(LogActionFilterError);
  });
});

describe("checkLogActionFilters", () => {
  it("returns ok with parsed values", () => {
    const res = checkLogActionFilters("test", [LogAction.voicemail_notify]);
    expect(res).toEqual({ ok: true, values: [LogAction.voicemail_notify] });
  });

  it("returns the error payload instead of throwing", () => {
    const res = checkLogActionFilters("test.endpoint", ["bad"]);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      const payload = res.error.toPayload();
      expect(payload.error).toBe("invalid_action_type_filter");
      expect(payload.rejected).toEqual(["bad"]);
      expect(payload.allowed).toEqual(LOG_ACTION_TYPES);
    }
  });

  it("produces a 400 JSON Response for raw HTTP boundaries", async () => {
    const res = checkLogActionFilters("test", ["bad"]);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      const response = res.error.toResponse();
      expect(response.status).toBe(400);
      expect(response.headers.get("Content-Type")).toBe("application/json");
      expect(await response.json()).toMatchObject({ error: "invalid_action_type_filter" });
    }
  });
});
