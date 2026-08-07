import { describe, expect, it } from "vitest";
import { LOG_ACTION_TYPES, LogAction } from "@/lib/log-action-types";
import {
  logActionFilterValue,
  logActionFilterValues,
  pickLogActionTypes,
} from "@/lib/log-action-query";

describe("client-side action_type guards", () => {
  it("passes every generated action type through unchanged", () => {
    for (const type of LOG_ACTION_TYPES) {
      expect(logActionFilterValue(type)).toBe(type);
    }
    expect(logActionFilterValues([...LOG_ACTION_TYPES])).toEqual([...LOG_ACTION_TYPES]);
  });

  it("blocks values outside the whitelist before any request is built", () => {
    for (const bad of ["", " quote_sms", "QUOTE_SMS", "drop table logs", 42, null, undefined, {}]) {
      expect(() => logActionFilterValue(bad)).toThrow(/invalid action_type/i);
    }
    // The message names the allowed values so the failure is self-explaining.
    expect(() => logActionFilterValue("nope")).toThrow(new RegExp(LogAction.quote_sms));
  });

  it("rejects a list containing any invalid member", () => {
    expect(() => logActionFilterValues([LogAction.quote_sms, "nope"])).toThrow(/invalid action_type/i);
  });

  it("rejects an empty list, which would otherwise match nothing", () => {
    expect(() => logActionFilterValues([])).toThrow(/invalid action_type/i);
  });

  it("pickLogActionTypes keeps known values, dedupes, and reports the rest", () => {
    const result = pickLogActionTypes([
      LogAction.quote_sms,
      LogAction.quote_sms,
      "nope",
      "nope",
      7,
    ]);
    expect(result.valid).toEqual([LogAction.quote_sms]);
    expect(result.invalid).toEqual(["nope", "7"]);
  });
});
