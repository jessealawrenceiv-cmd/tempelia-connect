import { describe, expect, it } from "vitest";
import {
  friendlyLogRequestError,
  MAX_LOG_SEARCH_LENGTH,
  validateActivityLogFilters,
} from "./activity-log-filters.schema";
import { LogAction } from "./log-action-types.generated";

describe("validateActivityLogFilters", () => {
  it("accepts a clean payload with no issues", () => {
    const r = validateActivityLogFilters({
      logTypes: `${LogAction.status_refresh},${LogAction.automation_status_change}`,
      logSort: "oldest",
      q: "deposit",
    });
    expect(r.issues).toEqual([]);
    expect(r.value.selectedTypes).toHaveLength(2);
    expect(r.value.sortDir).toBe("oldest");
    expect(r.value.searchQuery).toBe("deposit");
  });

  it("names unknown record types in a friendly message and keeps valid ones", () => {
    const r = validateActivityLogFilters({ logTypes: `bogus_type,${LogAction.status_refresh}` });
    expect(r.value.selectedTypes).toEqual([LogAction.status_refresh]);
    const issue = r.issues.find((i) => i.field === "logTypes");
    expect(issue?.message).toContain("bogus_type");
    expect(issue?.message).not.toMatch(/zod|invalid_enum/i);
  });

  it("falls back to newest for an unrecognised sort value", () => {
    const r = validateActivityLogFilters({ logSort: "sideways" });
    expect(r.value.sortDir).toBe("newest");
    expect(r.issues.some((i) => i.field === "logSort")).toBe(true);
  });

  it("flags an over-long search and truncates it", () => {
    const r = validateActivityLogFilters({ q: "a".repeat(MAX_LOG_SEARCH_LENGTH + 10) });
    expect(r.value.searchQuery).toHaveLength(MAX_LOG_SEARCH_LENGTH);
    expect(r.issues.some((i) => i.field === "q")).toBe(true);
  });

  it("flags an inverted date range", () => {
    const r = validateActivityLogFilters({
      dateFrom: new Date("2026-05-02"),
      dateTo: new Date("2026-05-01"),
    });
    expect(r.issues.some((i) => i.field === "dateRange")).toBe(true);
  });

  it("never throws on garbage input", () => {
    const r = validateActivityLogFilters({ logTypes: 42 as unknown, logSort: {} as unknown });
    expect(r.value.selectedTypes).toEqual([]);
    expect(r.issues.length).toBeGreaterThan(0);
  });
});

describe("friendlyLogRequestError", () => {
  it("explains action_type failures without jargon", () => {
    const msg = friendlyLogRequestError(new Error('violates check constraint "logs_action_type_check"'));
    expect(msg).toContain("record types");
  });

  it("has a readable fallback", () => {
    expect(friendlyLogRequestError(null)).toMatch(/activity log/i);
  });
});
