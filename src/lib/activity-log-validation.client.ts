/**
 * Client-side reporter for activity-log filter validation failures.
 *
 * De-duplicates by (source + issue signature) for the lifetime of the page so a
 * user typing an over-long search doesn't emit one report per keystroke, and
 * fails silently: diagnostics must never surface an error to the user.
 */

import {
  issuesFromFilterIssues,
  type ActivityLogValidationSource,
} from "@/lib/activity-log-validation";
import type { ActivityLogFilterIssue } from "@/lib/activity-log-filters.schema";
import { reportActivityLogFilterRejection } from "@/lib/activity-log-validation.functions";

const seen = new Set<string>();

/** Exposed for tests so each case starts from a clean de-dupe cache. */
export function resetFilterRejectionReports() {
  seen.clear();
}

export function signatureFor(
  source: string,
  blocked: boolean,
  issues: ActivityLogFilterIssue[],
): string {
  return [source, blocked ? "blocked" : "adjusted", ...issues.map((i) => `${i.field}:${i.message}`)].join("|");
}

export function reportFilterRejection(input: {
  source: ActivityLogValidationSource;
  blocked: boolean;
  issues: ActivityLogFilterIssue[];
  rawFilters: Record<string, string | number | boolean | null | undefined>;
}): void {
  if (input.issues.length === 0) return;
  const signature = signatureFor(input.source, input.blocked, input.issues);
  if (seen.has(signature)) return;
  seen.add(signature);

  const rawFilters: Record<string, string | number | boolean | null> = {};
  for (const [key, value] of Object.entries(input.rawFilters)) {
    if (value === undefined) continue;
    rawFilters[key] = value;
  }

  void reportActivityLogFilterRejection({
    data: {
      source: input.source,
      blocked: input.blocked,
      rawFilters,
      issues: issuesFromFilterIssues(input.issues),
    },
  }).catch(() => {
    // Never let a diagnostics call break the log UI.
  });
}
