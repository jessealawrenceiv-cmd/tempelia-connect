/**
 * Server-side write guard for public.logs.action_type.
 *
 * Verifies that insertLog / insertLogReturningId never reach Postgres with a
 * value outside the generated LogAction whitelist, and that the returned error
 * mirrors the real logs_action_type_check violation (code 23514 + hint).
 */
import { describe, expect, it, vi } from "vitest";
import {
  LOG_ACTION_TYPES,
  LOG_ACTION_TYPE_CONSTRAINT,
  LogAction,
  LogActionTypeViolationError,
  assertLogActionType,
  checkLogActionType,
  insertLog,
  insertLogReturningId,
} from "./log-action-types";

function fakeClient() {
  const insert = vi.fn().mockResolvedValue({ error: null });
  const select = vi.fn(() => ({ maybeSingle: () => Promise.resolve({ data: { id: "id-1" }, error: null }) }));
  const from = vi.fn(() => ({ insert: (rows: unknown) => Object.assign(insert(rows) as object, { select }) }));
  return { client: { from } as never, from, insert };
}

describe("logs action_type write guard", () => {
  it("allows whitelisted values through to the client", async () => {
    const { client, insert } = fakeClient();
    const res = await insertLog(client, { action_type: LogAction[LOG_ACTION_TYPES[0]!]!, user_id: "u" } as never);
    expect(res.error).toBeNull();
    expect(insert).toHaveBeenCalledTimes(1);
  });

  it("blocks an invalid value before any query runs", async () => {
    const { client, insert } = fakeClient();
    vi.spyOn(console, "error").mockImplementation(() => {});
    const res = (await insertLog(client, { action_type: "totally_made_up" } as never)) as unknown as {
      error: { code: string; constraint: string; message: string; hint: string; rejectedActionType: string };
    };
    expect(insert).not.toHaveBeenCalled();
    expect(res.error.code).toBe("23514");
    expect(res.error.constraint).toBe(LOG_ACTION_TYPE_CONSTRAINT);
    expect(res.error.message).toContain(LOG_ACTION_TYPE_CONSTRAINT);
    expect(res.error.message).toContain("totally_made_up");
    expect(res.error.rejectedActionType).toBe("totally_made_up");
    expect(res.error.hint).toContain(LOG_ACTION_TYPES[0]!);
  });

  it("blocks a batch containing one bad value (writes are atomic)", async () => {
    const { client, insert } = fakeClient();
    vi.spyOn(console, "error").mockImplementation(() => {});
    const res = (await insertLog(client, [
      { action_type: LogAction[LOG_ACTION_TYPES[0]!]! },
      { action_type: "nope" },
    ] as never)) as unknown as { error: { rejectedActionType: string } };
    expect(insert).not.toHaveBeenCalled();
    expect(res.error.rejectedActionType).toBe("nope");
  });

  it("blocks the returning-id variant too", async () => {
    const { client, insert } = fakeClient();
    vi.spyOn(console, "error").mockImplementation(() => {});
    const res = (await insertLogReturningId(client, { action_type: "" } as never)) as unknown as {
      id: string | null;
      error: { code: string };
    };
    expect(insert).not.toHaveBeenCalled();
    expect(res.id).toBeNull();
    expect(res.error.code).toBe("23514");
  });

  it("rejects case and whitespace variants, like the database does", () => {
    const valid = LOG_ACTION_TYPES[0]!;
    expect(checkLogActionType(valid).ok).toBe(true);
    expect(checkLogActionType(valid.toUpperCase()).ok).toBe(false);
    expect(checkLogActionType(` ${valid}`).ok).toBe(false);
    expect(checkLogActionType(null).ok).toBe(false);
    expect(checkLogActionType(undefined).ok).toBe(false);
  });

  it("assertLogActionType throws a constraint-aware error", () => {
    expect(() => assertLogActionType("bogus")).toThrow(LogActionTypeViolationError);
    try {
      assertLogActionType("bogus");
    } catch (err) {
      const e = err as LogActionTypeViolationError;
      expect(e.code).toBe("23514");
      expect(e.constraint).toBe(LOG_ACTION_TYPE_CONSTRAINT);
      expect(e.rejectedActionType).toBe("bogus");
    }
  });
});
