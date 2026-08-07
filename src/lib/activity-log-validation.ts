/**
 * Structured records for Zod validation failures on the activity log.
 *
 * Filter payloads arrive from the URL, so a bad one is usually a stale
 * bookmark, a truncated shared link, or a hand-edited query string. When the
 * server rejects one we want a single machine-readable line in the server logs
 * (plus a durable row) that says exactly which field failed, what the value
 * was, and where it came from — enough to trace the payload back to a link.
 *
 * Pure helpers live here so they can be unit-tested without a server runtime.
 */

import { z } from "zod";
import type { ActivityLogFilterIssue } from "./activity-log-filters.schema";

/** Which activity-log entry point rejected the payload. */
export const ACTIVITY_LOG_VALIDATION_SOURCES = [
  "log_list",
  "log_export",
  "log_row_details",
  "log_saved_view",
  "server_fn",
] as const;
export type ActivityLogValidationSource = (typeof ACTIVITY_LOG_VALIDATION_SOURCES)[number];

/** Log line prefix — grep this in server logs to find every rejection. */
export const ACTIVITY_LOG_VALIDATION_TAG = "activity_log_filter_rejected";

/** Cap on any single stored value so a giant query string can't bloat the row. */
export const MAX_STORED_FILTER_VALUE = 500;

export const activityLogValidationReportSchema = z.object({
  source: z.enum(ACTIVITY_LOG_VALIDATION_SOURCES),
  /** True when the client refused to send the query at all. */
  blocked: z.boolean().default(false),
  /** Raw, untrusted filter values exactly as they arrived. */
  rawFilters: z
    .record(z.string().max(64), z.union([z.string(), z.number(), z.boolean(), z.null()]))
    .default({}),
  issues: z
    .array(
      z.object({
        field: z.enum(["logTypes", "logSort", "q", "dateRange", "customer", "unknown"]),
        message: z.string().max(500),
        blocking: z.boolean().optional(),
      }),
    )
    .max(20)
    .default([]),
  /** Optional caller-supplied correlation id (e.g. the react-query key hash). */
  correlationId: z.string().max(100).optional(),
});

export type ActivityLogValidationReport = z.infer<typeof activityLogValidationReportSchema>;

/** One flat, JSON-serialisable record — what gets logged and stored. */
export interface ActivityLogValidationRecord {
  tag: typeof ACTIVITY_LOG_VALIDATION_TAG;
  source: ActivityLogValidationSource;
  blocked: boolean;
  userId: string | null;
  /** Sorted, de-duplicated field names, handy for grouping in log search. */
  issueFields: string[];
  issueCount: number;
  issues: { field: string; message: string; blocking: boolean }[];
  rawFilters: Record<string, string>;
  correlationId: string | null;
  userAgent: string | null;
  at: string;
}

const truncate = (value: unknown): string => {
  const s = typeof value === "string" ? value : String(value);
  return s.length > MAX_STORED_FILTER_VALUE ? `${s.slice(0, MAX_STORED_FILTER_VALUE)}…[truncated]` : s;
};

/**
 * Builds the structured record. Values are stringified and truncated so the log
 * line stays bounded even when someone pastes a 10KB query string.
 */
export function buildValidationRecord(input: {
  report: ActivityLogValidationReport;
  userId?: string | null;
  userAgent?: string | null;
  at?: Date;
}): ActivityLogValidationRecord {
  const { report } = input;
  const rawFilters: Record<string, string> = {};
  for (const [key, value] of Object.entries(report.rawFilters)) {
    if (value === null || value === undefined) continue;
    rawFilters[key.slice(0, 64)] = truncate(value);
  }
  const issues = report.issues.map((i) => ({
    field: i.field,
    message: i.message,
    blocking: i.blocking === true,
  }));
  return {
    tag: ACTIVITY_LOG_VALIDATION_TAG,
    source: report.source,
    blocked: report.blocked,
    userId: input.userId ?? null,
    issueFields: [...new Set(issues.map((i) => i.field))].sort(),
    issueCount: issues.length,
    issues,
    rawFilters,
    correlationId: report.correlationId ?? null,
    userAgent: input.userAgent ? truncate(input.userAgent) : null,
    at: (input.at ?? new Date()).toISOString(),
  };
}

/** Converts Zod issues (from any schema) into the report's issue shape. */
export function issuesFromZodError(error: z.ZodError): ActivityLogValidationReport["issues"] {
  return error.issues.slice(0, 20).map((i) => {
    const path = String(i.path[0] ?? "");
    const field =
      path === "q" || path === "logTypes" || path === "logSort" || path === "dateRange" || path === "customer"
        ? (path as "q")
        : ("unknown" as const);
    return { field, message: `${i.code}: ${i.message}`.slice(0, 500) };
  });
}

/** Maps the UI's friendly filter issues onto the report shape. */
export function issuesFromFilterIssues(
  issues: ActivityLogFilterIssue[],
): ActivityLogValidationReport["issues"] {
  return issues.slice(0, 20).map((i) => ({
    field: i.field,
    message: i.message.slice(0, 500),
    ...(i.blocking === true ? { blocking: true } : {}),
  }));
}

/** Single-line, greppable log message. */
export function formatValidationLogLine(record: ActivityLogValidationRecord): string {
  return `${ACTIVITY_LOG_VALIDATION_TAG} ${JSON.stringify(record)}`;
}
