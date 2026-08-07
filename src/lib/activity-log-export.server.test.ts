/**
 * Contract: the CSV export endpoint rejects action_type filters exactly like the
 * logs list endpoint, and returns the same `logs_action_type_check` payload.
 *
 * Both paths run the shared guard in log-action-filter.server.ts and shape the
 * 400 body with logActionFilterRejectionPayload, so this suite pins the parity
 * rather than duplicating rules in two places.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { checkLogActionFilters } from "./log-action-filter.server";
import {
  isLogActionFilterRejection,
  logActionFilterRejectionPayload,
} from "./log-action-filter-rejection";
import { describeLogRequestError } from "./activity-log-filters.schema";
import { LOG_ACTION_TYPES, LOGS_ACTION_TYPE_CONSTRAINT, LogAction } from "./log-action-types.generated";
import { LOG_EXPORT_ENDPOINT } from "./activity-log-export.functions";

/** Same body-building path both endpoints use. */
function validate(endpoint: string, actionTypes: unknown) {
  const checked = checkLogActionFilters(endpoint, actionTypes);
  if (checked.ok) return { ok: true as const, values: checked.values };
  return {
    ok: false as const,
    rejection: logActionFilterRejectionPayload({
      endpoint: checked.error.endpoint,
      rejected: checked.error.rejected,
      requestId: checked.error.requestId,
      allowed: checked.error.allowed,
    }),
  };
}

const listEndpoint = "api.logs.list";

describe("CSV export endpoint action_type validation", () => {
  beforeEach(() => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  it("accepts a whitelist-only filter", () => {
    const result = validate(LOG_EXPORT_ENDPOINT, [LogAction.status_refresh]);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.values).toEqual([LogAction.status_refresh]);
  });

  it("rejects a mixed valid/invalid list atomically", () => {
    const result = validate(LOG_EXPORT_ENDPOINT, [
      LogAction.status_refresh,
      "not_a_type",
      LogAction.invoice_sms,
    ]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.rejection.status).toBe(400);
    expect(result.rejection.rejected).toEqual(["not_a_type"]);
    expect(result.rejection.allowed).toEqual([...LOG_ACTION_TYPES]);
    expect(result.rejection.message).toContain(LOGS_ACTION_TYPE_CONSTRAINT);
    expect(result.rejection.requestId).toMatch(/^lg_/);
    expect(isLogActionFilterRejection(result.rejection)).toBe(true);
  });

  it("rejects an empty list (would match nothing)", () => {
    const result = validate(LOG_EXPORT_ENDPOINT, []);
    expect(result.ok).toBe(false);
  });

  it("rejects a non-array filter", () => {
    const result = validate(LOG_EXPORT_ENDPOINT, LogAction.status_refresh);
    expect(result.ok).toBe(false);
  });

  it("produces the same payload shape as the list endpoint", () => {
    const bad = [LogAction.status_refresh, "bogus"];
    const list = validate(listEndpoint, bad);
    const exp = validate(LOG_EXPORT_ENDPOINT, bad);
    expect(list.ok).toBe(false);
    expect(exp.ok).toBe(false);
    if (list.ok || exp.ok) return;

    expect(Object.keys(exp.rejection).sort()).toEqual(Object.keys(list.rejection).sort());
    expect(exp.rejection.error).toBe(list.rejection.error);
    expect(exp.rejection.code).toBe(list.rejection.code);
    expect(exp.rejection.rejected).toEqual(list.rejection.rejected);
    expect(exp.rejection.allowed).toEqual(list.rejection.allowed);
    // Only the endpoint id and correlation ID differ between the two paths.
    expect(exp.rejection.endpoint).toBe(LOG_EXPORT_ENDPOINT);
    expect(exp.rejection.requestId).not.toBe(list.rejection.requestId);
  });

  it("is understood by the shared UI error describer", () => {
    const result = validate(LOG_EXPORT_ENDPOINT, ["bogus"]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    const info = describeLogRequestError(result.rejection);
    expect(info.isActionTypeCheck).toBe(true);
    expect(info.status).toBe(400);
    expect(info.suggestClearFilters).toBe(true);
    expect(info.allowedTypes).toEqual([...LOG_ACTION_TYPES]);
    expect(info.requestId).toBe(result.rejection.requestId);
  });

  it("logs the rejection structurally with the correlation ID", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const result = validate(LOG_EXPORT_ENDPOINT, ["bogus"]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    const line = warn.mock.calls.map((c) => String(c[0])).join("\n");
    expect(line).toContain("logs_action_type_filter_rejected");
    expect(line).toContain(LOG_EXPORT_ENDPOINT);
    expect(line).toContain(result.rejection.requestId);
  });
});
