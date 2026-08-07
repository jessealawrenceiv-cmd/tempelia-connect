/**
 * Structured logging of activity-log filter validation failures.
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  ACTIVITY_LOG_VALIDATION_TAG,
  MAX_STORED_FILTER_VALUE,
  activityLogValidationReportSchema,
  buildValidationRecord,
  formatValidationLogLine,
  issuesFromFilterIssues,
  issuesFromZodError,
} from "./activity-log-validation";
import { MAX_LOG_SEARCH_LENGTH, validateActivityLogFilters } from "./activity-log-filters.schema";

const report = (over: Partial<z.input<typeof activityLogValidationReportSchema>> = {}) =>
  activityLogValidationReportSchema.parse({ source: "log_list", ...over });

describe("buildValidationRecord", () => {
  it("produces a flat, greppable record with sorted issue fields", () => {
    const record = buildValidationRecord({
      report: report({
        blocked: true,
        rawFilters: { q: "x", logTypes: "nope" },
        issues: [
          { field: "q", message: "too long", blocking: true },
          { field: "logTypes", message: "unknown type" },
        ],
      }),
      userId: "user-1",
      userAgent: "Mozilla/5.0",
      at: new Date("2026-08-07T03:00:00.000Z"),
    });

    expect(record.tag).toBe(ACTIVITY_LOG_VALIDATION_TAG);
    expect(record.issueFields).toEqual(["logTypes", "q"]);
    expect(record.issueCount).toBe(2);
    expect(record.blocked).toBe(true);
    expect(record.userId).toBe("user-1");
    expect(record.at).toBe("2026-08-07T03:00:00.000Z");
    expect(record.issues[1]).toEqual({ field: "logTypes", message: "unknown type", blocking: false });
  });

  it("truncates oversized raw filter values so the log line stays bounded", () => {
    const record = buildValidationRecord({
      report: report({ rawFilters: { q: "y".repeat(5_000) }, issues: [{ field: "q", message: "bad" }] }),
    });
    expect(record.rawFilters["q"]!.length).toBeLessThanOrEqual(MAX_STORED_FILTER_VALUE + 20);
    expect(record.rawFilters["q"]).toContain("truncated");
  });

  it("serialises to one parseable line prefixed with the tag", () => {
    const line = formatValidationLogLine(
      buildValidationRecord({ report: report({ issues: [{ field: "dateRange", message: "inverted" }] }) }),
    );
    expect(line.startsWith(`${ACTIVITY_LOG_VALIDATION_TAG} `)).toBe(true);
    expect(line.split("\n")).toHaveLength(1);
    const parsed = JSON.parse(line.slice(ACTIVITY_LOG_VALIDATION_TAG.length + 1));
    expect(parsed.issues[0].field).toBe("dateRange");
  });
});

describe("issue mapping", () => {
  it("carries the UI's friendly messages and blocking flags across", () => {
    const issues = validateActivityLogFilters({ q: "z".repeat(MAX_LOG_SEARCH_LENGTH + 5) }).issues;
    const mapped = issuesFromFilterIssues(issues);
    expect(mapped[0]).toMatchObject({ field: "q", blocking: true });
    expect(mapped[0]!.message).toContain("too long");
    expect(activityLogValidationReportSchema.parse({ source: "log_list", issues: mapped }).issues).toHaveLength(1);
  });

  it("maps raw Zod issues, bucketing unknown paths", () => {
    const err = z
      .object({ q: z.string().max(1), other: z.string() })
      .safeParse({ q: "toolong", other: 5 });
    const mapped = issuesFromZodError((err as { error: z.ZodError }).error);
    expect(mapped.some((i) => i.field === "q")).toBe(true);
    expect(mapped.some((i) => i.field === "unknown")).toBe(true);
  });
});

describe("report schema", () => {
  it("rejects an unknown source", () => {
    expect(activityLogValidationReportSchema.safeParse({ source: "hacked" }).success).toBe(false);
  });

  it("caps the issue list", () => {
    const many = Array.from({ length: 25 }, () => ({ field: "q" as const, message: "bad" }));
    expect(activityLogValidationReportSchema.safeParse({ source: "log_list", issues: many }).success).toBe(false);
  });
});
