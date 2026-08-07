import { describe, it, expect, vi } from "vitest";
import {
  LOG_ACTION_TYPES,
  isLogActionType,
  assertLogActionType,
  insertLog,
  LogAction,
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
      expect(() => assertLogActionType(v)).toThrow(/logs_action_type_check/);
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
    const res = await insertLog(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      client as never,
      [{ action_type: "quote_sms" }, { action_type: "not_allowed" }] as never,
    );
    expect((res.error as { constraint?: string }).constraint).toBe("logs_action_type_check");
    expect((res.error as { rejectedActionType?: string }).rejectedActionType).toBe("not_allowed");
    expect(insert).not.toHaveBeenCalled();
  });

  it("rejects a missing action_type before insert", async () => {
    const { client, insert } = makeClient();
    const res = await insertLog(client as never, { status: "x" } as never);
    expect((res.error as { constraint?: string }).constraint).toBe("logs_action_type_check");
    expect(insert).not.toHaveBeenCalled();
  });

  it("targets the logs table and passes the rows through unchanged", async () => {
    const { client, insert } = makeClient();
    const rows = [
      { user_id: "u", action_type: LogAction.status_refresh },
      { user_id: "u", action_type: LogAction.automation_status_change },
    ];
    await insertLog(client as never, rows);
    expect(client.from).toHaveBeenCalledWith("logs");
    expect(insert).toHaveBeenCalledWith(rows);
  });

  it("surfaces a database error instead of swallowing it", async () => {
    const insert = vi.fn().mockResolvedValue({ error: { message: "boom" } });
    const client = { from: vi.fn(() => ({ insert })) };
    const res = await insertLog(client as never, { action_type: "quote_sms" });
    expect(res.error?.message).toBe("boom");
  });

  it.each(["STATUS_REFRESH", "status_refresh ", "made_up", ""])(
    "blocks invalid value %j before the database",
    async (bad) => {
      const { client, insert } = makeClient();
      const res = await insertLog(client as never, { action_type: bad } as never);
      expect((res.error as { constraint?: string }).constraint).toBe("logs_action_type_check");
      expect(client.from).not.toHaveBeenCalled();
      expect(insert).not.toHaveBeenCalled();
    },
  );
});
