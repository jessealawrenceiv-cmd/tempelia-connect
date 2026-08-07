import { describe, expect, it } from "vitest";
import { LOG_ACTION_TYPES } from "./log-action-types.generated";
import {
  logResponseRowSchema,
  parseLogRowsResponse,
  parseLogRowsResponseStrict,
} from "./log-action-types.schema";

const row = (action_type: string, id = "1") => ({ id, action_type, message_sent: null });

describe("logResponseRowSchema", () => {
  it("accepts every generated action_type", () => {
    for (const t of LOG_ACTION_TYPES) {
      expect(logResponseRowSchema.safeParse(row(t)).success).toBe(true);
    }
  });

  it("rejects unknown action_type values", () => {
    for (const bad of ["", "nope", "STATUS_REFRESH", "status_refresh "]) {
      expect(logResponseRowSchema.safeParse(row(bad)).success).toBe(false);
    }
  });
});

describe("parseLogRowsResponse", () => {
  it("keeps whitelisted rows and narrows the type", () => {
    const result = parseLogRowsResponse([row("status_refresh", "a"), row("missed_call_text", "b")]);
    expect(result.rows.map((r) => r.id)).toEqual(["a", "b"]);
    expect(result.droppedCount).toBe(0);
    expect(result.unknownActionTypes).toEqual([]);
    // Type-level guarantee: this must compile as a LogActionType comparison.
    expect(LOG_ACTION_TYPES).toContain(result.rows[0]!.action_type);
  });

  it("drops rows with unknown action_type and reports them once", () => {
    const result = parseLogRowsResponse([
      row("status_refresh", "a"),
      row("mystery_event", "b"),
      row("mystery_event", "c"),
      row(undefined as unknown as string, "d"),
    ]);
    expect(result.rows.map((r) => r.id)).toEqual(["a"]);
    expect(result.droppedCount).toBe(3);
    expect(result.unknownActionTypes.sort()).toEqual(["mystery_event", "undefined"]);
  });

  it("handles null and empty input", () => {
    expect(parseLogRowsResponse(null).rows).toEqual([]);
    expect(parseLogRowsResponse(undefined).droppedCount).toBe(0);
    expect(parseLogRowsResponse([]).unknownActionTypes).toEqual([]);
  });
});

describe("parseLogRowsResponseStrict", () => {
  it("returns rows when everything is whitelisted", () => {
    expect(parseLogRowsResponseStrict([row("review_request")])).toHaveLength(1);
  });

  it("throws with the offending value and the allowed list", () => {
    expect(() => parseLogRowsResponseStrict([row("bogus_type")])).toThrow(/bogus_type/);
    expect(() => parseLogRowsResponseStrict([row("bogus_type")])).toThrow(/status_refresh/);
  });
});
