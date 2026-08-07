/**
 * Integration coverage for the logs API's invalid `action_type` behaviour.
 *
 * Every logs endpoint funnels its action_type filters through
 * src/lib/log-action-filter.server.ts. These tests exercise that boundary the
 * way a bypassing client hits it — a raw HTTP handler and the MCP tool handler —
 * and assert the caller gets a 400 with a message that names the rejected value
 * and the allowed set, and that no database query is ever attempted.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  LogActionFilterError,
  assertLogActionFilters,
  checkLogActionFilters,
} from "./log-action-filter.server";
import { LOG_ACTION_TYPES, LogAction } from "./log-action-types.generated";

/** Stands in for a logs read endpoint: validate, then query. */
function makeLogsEndpoint(query: (types: string[]) => unknown) {
  return async (request: Request): Promise<Response> => {
    const body = (await request.json()) as { action_type?: unknown };
    const checked = checkLogActionFilters("api.logs.list", body.action_type);
    if (!checked.ok) return checked.error.toResponse();
    return Response.json({ rows: query(checked.values) });
  };
}

function post(body: unknown): Request {
  return new Request("http://localhost/api/logs", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("logs API — invalid action_type returns 400", () => {
  const query = vi.fn(() => []);
  const endpoint = makeLogsEndpoint(query);

  beforeEach(() => {
    query.mockClear();
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  it("rejects an unknown action_type with 400 and a clear message", async () => {
    const res = await endpoint(post({ action_type: ["totally_made_up"] }));
    expect(res.status).toBe(400);
    expect(res.headers.get("Content-Type")).toContain("application/json");

    const body = (await res.json()) as Record<string, unknown>;
    expect(body["error"]).toBe("invalid_action_type_filter");
    expect(body["rejected"]).toEqual(["totally_made_up"]);
    expect(body["allowed"]).toEqual([...LOG_ACTION_TYPES]);
    expect(String(body["message"])).toContain("totally_made_up");
    expect(String(body["message"])).toContain("Allowed values:");
    expect(String(body["message"])).toContain(LogAction.status_refresh);
    // The query must never run for a rejected request.
    expect(query).not.toHaveBeenCalled();
  });

  it("rejects atomically when valid and invalid values are mixed", async () => {
    const res = await endpoint(
      post({ action_type: [LogAction.status_refresh, "sql_injection', 1)--", LogAction.invoice_sms] }),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { rejected: string[]; message: string };
    expect(body.rejected).toEqual(["sql_injection', 1)--"]);
    expect(body.message).toContain("1 disallowed value(s)");
    expect(query).not.toHaveBeenCalled();
  });

  it("names every rejected value once, de-duplicated", async () => {
    const res = await endpoint(post({ action_type: ["nope", "nope", "also_nope"] }));
    const body = (await res.json()) as { rejected: string[]; message: string };
    expect(res.status).toBe(400);
    expect(body.rejected).toEqual(["nope", "also_nope"]);
    expect(body.message).toContain("2 disallowed value(s)");
  });

  it("rejects an empty filter list rather than returning zero rows", async () => {
    const res = await endpoint(post({ action_type: [] }));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { message: string; rejected: string[] };
    expect(body.message).toContain("empty action_type list");
    expect(body.rejected).toEqual([]);
    expect(query).not.toHaveBeenCalled();
  });

  it.each([
    ["a bare string", "status_refresh"],
    ["a number", 7],
    ["an object", { action_type: "status_refresh" }],
    ["null", null],
  ])("rejects %s where a list is required", async (_label, value) => {
    const res = await endpoint(post({ action_type: value }));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { message: string };
    expect(body.message).toContain("expected an array of action_type values");
  });

  it("rejects case and whitespace variants of a real action type", async () => {
    for (const bad of ["Status_Refresh", " status_refresh", "status_refresh "]) {
      const res = await endpoint(post({ action_type: [bad] }));
      expect(res.status).toBe(400);
      expect((await res.json()).rejected).toEqual([bad]);
    }
  });

  it("passes valid filters through and queries with the normalized list", async () => {
    const res = await endpoint(
      post({ action_type: [LogAction.invoice_sms, LogAction.invoice_sms, LogAction.review_request] }),
    );
    expect(res.status).toBe(200);
    expect(query).toHaveBeenCalledWith([LogAction.invoice_sms, LogAction.review_request]);
  });

  it("logs a greppable structured warning for each rejection", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    warn.mockClear();
    await endpoint(post({ action_type: ["bogus_type"] }));
    expect(warn).toHaveBeenCalledTimes(1);
    const line = String(warn.mock.calls[0]?.[0]);
    expect(line).toContain("logs_action_type_filter_rejected");
    expect(line).toContain("api.logs.list");
    expect(line).toContain("bogus_type");
  });

  it("throws a 400-shaped error object for server-function call sites", () => {
    try {
      assertLogActionFilters("serverFn.resendSms", ["nonsense"]);
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(LogActionFilterError);
      const e = err as LogActionFilterError;
      expect(e.status).toBe(400);
      expect(e.code).toBe("invalid_action_type_filter");
      expect(e.endpoint).toBe("serverFn.resendSms");
      expect(e.toPayload().rejected).toEqual(["nonsense"]);
    }
  });
});

describe("MCP logs endpoint — invalid action_type", () => {
  const from = vi.fn();

  beforeEach(() => {
    vi.resetModules();
    from.mockClear();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.doMock("@supabase/supabase-js", () => ({
      createClient: () => ({ from }),
    }));
  });

  async function callTool(action_type: unknown) {
    const tool = (await import("./mcp/tools/list_missed_calls")).default;
    const ctx = {
      isAuthenticated: () => true,
      getToken: () => "test-token",
      getUserId: () => "user-1",
    } as never;
    return (tool as unknown as {
      handler: (input: unknown, ctx: unknown) => Promise<{ isError?: boolean; content: { text: string }[] }>;
    }).handler({ action_type }, ctx);
  }

  it("returns an error result naming the rejected value and never queries logs", async () => {
    const result = await callTool("not_a_real_action");
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("not_a_real_action");
    expect(from).not.toHaveBeenCalled();
  });

  it("returns an error result for a valid-looking but non-whitelisted variant", async () => {
    const result = await callTool("STATUS_REFRESH");
    expect(result.isError).toBe(true);
    expect(from).not.toHaveBeenCalled();
  });
});
