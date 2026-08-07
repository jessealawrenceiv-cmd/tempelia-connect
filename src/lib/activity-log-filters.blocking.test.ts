/**
 * Client-side prevalidation: which filter problems must stop the request.
 *
 * Correctable problems (unknown record types, unrecognised sort) are silently
 * fixed and the log still loads. Uncorrectable ones (over-long search, inverted
 * date range) block the request so we never round-trip a query that can't work.
 */
import { describe, expect, it } from "vitest";
import {
  MAX_LOG_SEARCH_LENGTH,
  hasBlockingFilterIssues,
  validateActivityLogFilters,
} from "./activity-log-filters.schema";

describe("blocking filter issues", () => {
  it("blocks a search longer than the schema allows", () => {
    const v = validateActivityLogFilters({ q: "x".repeat(MAX_LOG_SEARCH_LENGTH + 1) });
    expect(hasBlockingFilterIssues(v.issues)).toBe(true);
    expect(v.issues.find((i) => i.field === "q")?.message).toContain("too long");
  });

  it("blocks an inverted date range", () => {
    const v = validateActivityLogFilters({
      dateFrom: new Date("2026-03-10T00:00:00Z"),
      dateTo: new Date("2026-03-01T00:00:00Z"),
    });
    expect(hasBlockingFilterIssues(v.issues)).toBe(true);
    expect(v.issues.find((i) => i.field === "dateRange")?.blocking).toBe(true);
  });

  it("does not block correctable issues", () => {
    const v = validateActivityLogFilters({ logTypes: "not_a_real_type", logSort: "sideways" });
    expect(v.issues.length).toBeGreaterThan(0);
    expect(hasBlockingFilterIssues(v.issues)).toBe(false);
    expect(v.value.sortDir).toBe("newest");
  });

  it("does not block a valid filter set", () => {
    const v = validateActivityLogFilters({
      q: "415",
      logSort: "oldest",
      dateFrom: new Date("2026-03-01T00:00:00Z"),
      dateTo: new Date("2026-03-10T00:00:00Z"),
    });
    expect(v.issues).toEqual([]);
    expect(hasBlockingFilterIssues(v.issues)).toBe(false);
  });
});
