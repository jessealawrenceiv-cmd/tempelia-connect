/**
 * Correlation ID contract for logs API failures.
 *
 * A user-reported "the activity log broke" is only actionable if the string on
 * their screen matches the server log line, so the ID must survive every hop:
 * the thrown server error, the JSON body, the `x-request-id` header, and the
 * plain message text a client may be left with.
 */
import { describe, expect, it, vi, afterEach } from "vitest";
import { LogActionFilterError, checkLogActionFilters } from "./log-action-filter.server";
import { logRequestIdFromError, newLogRequestId } from "./log-request-id";
import { describeLogRequestError } from "./activity-log-filters.schema";

const ID_SHAPE = /^lg_[a-z0-9]{6,32}$/;

afterEach(() => vi.restoreAllMocks());

describe("newLogRequestId", () => {
  it("mints short unique ids", () => {
    const ids = new Set(Array.from({ length: 50 }, () => newLogRequestId()));
    expect(ids.size).toBe(50);
    for (const id of ids) expect(id).toMatch(ID_SHAPE);
  });
});

describe("logs 400 rejection", () => {
  it("carries one id through the log line, payload, header and message", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const result = checkLogActionFilters("test.endpoint", ["missed_call", "not_a_type"]);
    expect(result.ok).toBe(false);
    const error = (result as { ok: false; error: LogActionFilterError }).error;

    expect(error.requestId).toMatch(ID_SHAPE);
    expect(error.toPayload().requestId).toBe(error.requestId);
    expect(error.message).toContain(error.requestId);

    const response = error.toResponse();
    expect(response.status).toBe(400);
    expect(response.headers.get("x-request-id")).toBe(error.requestId);
    expect((await response.json()).requestId).toBe(error.requestId);

    expect(warn.mock.calls[0]?.[0]).toContain(error.requestId);
  });
});

describe("logRequestIdFromError", () => {
  it("reads the id from a payload field, a header bag or bare text", () => {
    const id = "lg_abc123def4";
    expect(logRequestIdFromError({ requestId: id })).toBe(id);
    expect(logRequestIdFromError({ request_id: id })).toBe(id);
    expect(logRequestIdFromError({ headers: new Headers({ "x-request-id": id }) })).toBe(id);
    expect(logRequestIdFromError(`boom ... request id: ${id}`)).toBe(id);
    expect(logRequestIdFromError({ message: "no id here" })).toBeUndefined();
  });
});

describe("describeLogRequestError", () => {
  it("exposes the id for the action_type 400 so the UI can display it", () => {
    const info = describeLogRequestError({
      status: 400,
      message: 'violates check constraint "logs_action_type_check"',
      requestId: "lg_ff00aa1122",
    });
    expect(info.isActionTypeCheck).toBe(true);
    expect(info.requestId).toBe("lg_ff00aa1122");
  });

  it("exposes the id for generic failures too", () => {
    const info = describeLogRequestError({ message: "Failed to fetch (request id: lg_991188ccdd)" });
    expect(info.requestId).toBe("lg_991188ccdd");
  });
});
