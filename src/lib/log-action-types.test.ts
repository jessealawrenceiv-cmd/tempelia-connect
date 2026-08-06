import { describe, it, expect, vi } from "vitest";
import {
  LOG_ACTION_TYPES,
  isLogActionType,
  assertLogActionType,
  insertLog,
} from "./log-action-types";

describe("log action_type whitelist", () => {
  it("includes the status/automation values", () => {
    expect(LOG_ACTION_TYPES).toContain("status_refresh");
    expect(LOG_ACTION_TYPES).toContain("automation_status_change");
    expect(new Set(LOG_ACTION_TYPES).size).toBe(LOG_ACTION_TYPES.length);
  });

  it.each([...LOG_ACTION_TYPES])("accepts %s", (v) => {
    expect(isLogActionType(v)).toBe(true);
    expect(assertLogActionType(v)).toBe(v);
  });

  it.each(["", " ", "STATUS_REFRESH", "status_refresh ", "made_up", null, undefined, 7, {}])(
    "rejects %j",
    (v) => {
      expect(isLogActionType(v)).toBe(false);
      expect(() => assertLogActionType(v)).toThrow(/Invalid logs\.action_type/);
    },
  );
});

describe("insertLog", () => {
  const makeClient = () => {
    const insert = vi.fn().mockResolvedValue({ error: null });
    return { client: { from: vi.fn(() => ({ insert })) }, insert };
  };

  it("inserts a valid row", async () => {
    const { client, insert } = makeClient();
    await insertLog(client as never, { user_id: "u", action_type: "status_refresh", status: "ok" });
    expect(insert).toHaveBeenCalledTimes(1);
  });

  it("validates every row in a batch and never calls the database on failure", async () => {
    const { client, insert } = makeClient();
    await expect(
      insertLog(client as never, [
        { action_type: "quote_sms" },
        { action_type: "not_allowed" },
      ]),
    ).rejects.toThrow(/Invalid logs\.action_type "not_allowed"/);
    expect(insert).not.toHaveBeenCalled();
  });

  it("rejects a missing action_type before insert", async () => {
    const { client, insert } = makeClient();
    await expect(insertLog(client as never, { status: "x" } as never)).rejects.toThrow();
    expect(insert).not.toHaveBeenCalled();
  });
});
