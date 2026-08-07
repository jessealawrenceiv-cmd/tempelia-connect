/**
 * Zod validation for the Activity log's filter payload (URL search params).
 *
 * Filters arrive from the URL, so they are untrusted input: a shared link, a
 * stale bookmark, or a hand-edited query string can carry values that are not
 * in the generated action_type whitelist. This module validates them and maps
 * Zod issues to short, user-friendly sentences the UI can display instead of
 * silently dropping the value (or throwing a raw Zod error at the user).
 */

import { z } from "zod";
import {
  LOG_ACTION_TYPES,
  type LogActionType,
} from "./log-action-types.generated";
import { logActionLabel } from "./log-action-presentation";

export const MAX_LOG_SEARCH_LENGTH = 120;

const ALLOWED = new Set<string>(LOG_ACTION_TYPES);

export const logSortSchema = z.union([z.literal("newest"), z.literal("oldest")]);

export const activityLogFilterParamsSchema = z.object({
  logTypes: z.string().max(2000).optional(),
  logSort: z.string().optional(),
  q: z.string().max(MAX_LOG_SEARCH_LENGTH).optional(),
});

export type ActivityLogFilterIssue = {
  /** Which control the message belongs to, so the UI can point at it. */
  field: "logTypes" | "logSort" | "q" | "dateRange";
  message: string;
};

export type ActivityLogFilterValidation = {
  /** Sanitised values that are safe to query with. */
  value: {
    selectedTypes: LogActionType[];
    sortDir: "newest" | "oldest";
    searchQuery: string;
  };
  /** Friendly messages for anything that was rejected or corrected. */
  issues: ActivityLogFilterIssue[];
};

function friendlyTypeList(values: string[]): string {
  const labels = values.map((v) => `“${v}”`);
  if (labels.length === 1) return labels[0]!;
  return `${labels.slice(0, -1).join(", ")} and ${labels[labels.length - 1]}`;
}

/**
 * Validates the raw filter payload and returns both the usable value and a
 * list of human-readable problems. Never throws: the log must still render.
 */
export function validateActivityLogFilters(raw: {
  logTypes?: unknown;
  logSort?: unknown;
  q?: unknown;
  dateFrom?: Date | undefined;
  dateTo?: Date | undefined;
}): ActivityLogFilterValidation {
  const issues: ActivityLogFilterIssue[] = [];

  const parsed = activityLogFilterParamsSchema.safeParse({
    ...(typeof raw.logTypes === "string" ? { logTypes: raw.logTypes } : {}),
    ...(typeof raw.logSort === "string" ? { logSort: raw.logSort } : {}),
    ...(typeof raw.q === "string" ? { q: raw.q } : {}),
  });

  // Shape-level problems (wrong type, absurd length) — reported in plain words.
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      const field = issue.path[0];
      if (field === "q") {
        issues.push({
          field: "q",
          message: `Your search is too long. Please keep it under ${MAX_LOG_SEARCH_LENGTH} characters.`,
        });
      } else if (field === "logTypes") {
        issues.push({
          field: "logTypes",
          message: "The record-type filter in this link is too long to read. Showing all record types instead.",
        });
      } else {
        issues.push({ field: "logSort", message: "That sort order isn’t recognised. Showing newest first." });
      }
    }
  }

  if (raw.logTypes !== undefined && typeof raw.logTypes !== "string") {
    issues.push({
      field: "logTypes",
      message: "The record-type filter in this link couldn’t be read. Showing all record types instead.",
    });
  }

  // Per-value whitelist check: unknown action types get named back to the user.
  const selected: LogActionType[] = [];
  const unknown: string[] = [];
  const rawTypes = typeof raw.logTypes === "string" ? raw.logTypes : "";
  if (rawTypes.trim() !== "") {
    const seen = new Set<LogActionType>();
    for (const part of rawTypes.split(",")) {
      const value = part.trim();
      if (value === "") continue;
      if (ALLOWED.has(value)) {
        seen.add(value as LogActionType);
      } else if (!unknown.includes(value)) {
        unknown.push(value);
      }
    }
    selected.push(...seen);
  }
  if (unknown.length > 0) {
    issues.push({
      field: "logTypes",
      message:
        `${unknown.length === 1 ? "Record type" : "Record types"} ${friendlyTypeList(unknown)} ` +
        `${unknown.length === 1 ? "isn’t" : "aren’t"} something we track, so ${unknown.length === 1 ? "it was" : "they were"} ignored.` +
        (selected.length > 0
          ? ` Still filtering by ${selected.map((t) => logActionLabel(t)).join(", ")}.`
          : " Showing all record types."),
    });
  }

  // Sort direction.
  let sortDir: "newest" | "oldest" = "newest";
  if (raw.logSort !== undefined && raw.logSort !== null && raw.logSort !== "") {
    const sort = logSortSchema.safeParse(raw.logSort);
    if (sort.success) {
      sortDir = sort.data;
    } else {
      issues.push({
        field: "logSort",
        message: "That sort order isn’t recognised, so we’re showing newest first.",
      });
    }
  }

  // Date range sanity — an inverted range would silently return nothing.
  if (raw.dateFrom && raw.dateTo && raw.dateFrom.getTime() > raw.dateTo.getTime()) {
    issues.push({
      field: "dateRange",
      message: "Your start date is after your end date, so no records can match. Please swap them.",
    });
  }

  const q = typeof raw.q === "string" ? raw.q.slice(0, MAX_LOG_SEARCH_LENGTH) : "";

  return { value: { selectedTypes: selected, sortDir, searchQuery: q }, issues };
}

/** Turns any thrown/unknown error from a log request into a friendly sentence. */
export function friendlyLogRequestError(err: unknown): string {
  if (err instanceof z.ZodError) {
    const first = err.issues[0];
    if (first?.path[0] === "action_type") {
      return "One of the selected record types isn’t valid, so we couldn’t load that view. Try clearing your filters.";
    }
    return "Some of your filter values weren’t valid, so we couldn’t load the activity log.";
  }
  const message = err instanceof Error ? err.message : String(err ?? "");
  if (/action_type/i.test(message)) {
    return "One of the selected record types isn’t valid, so we couldn’t load that view. Try clearing your filters.";
  }
  if (/invalid input syntax|22007|22P02/i.test(message)) {
    return "One of your filter values was in a format we couldn’t read. Try resetting the filters.";
  }
  if (/permission|denied|42501|JWT/i.test(message)) {
    return "You don’t have access to these records. Try signing in again.";
  }
  if (/fetch|network|Failed to fetch/i.test(message)) {
    return "We couldn’t reach the server. Check your connection and try again.";
  }
  return "We couldn’t load the activity log with these filters. Try clearing them and searching again.";
}
