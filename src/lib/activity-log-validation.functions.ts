/**
 * Server endpoint for activity-log filter validation failures.
 *
 * The activity log reads Supabase directly from the browser, so there is no
 * server hop that naturally sees a bad filter payload. This function is that
 * hop: the client reports rejected/adjusted filters here, the server re-runs the
 * Zod validation itself (never trusting the client's verdict), and every failure
 * lands in the structured server log plus the rejections table.
 */

import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import {
  activityLogFilterParamsSchema,
} from "@/lib/activity-log-filters.schema";
import {
  activityLogValidationReportSchema,
  issuesFromZodError,
  type ActivityLogValidationReport,
} from "@/lib/activity-log-validation";

export interface ReportFilterRejectionResult {
  recorded: boolean;
  /** Fields the server itself found invalid, independent of the client report. */
  serverIssueFields: string[];
}

export const reportActivityLogFilterRejection = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown): ActivityLogValidationReport => {
    // The report itself is untrusted input; a malformed report is still a
    // signal worth keeping, so fall back to a minimal well-formed one.
    const parsed = activityLogValidationReportSchema.safeParse(input);
    if (parsed.success) return parsed.data;
    return {
      source: "server_fn",
      blocked: false,
      rawFilters: {},
      issues: issuesFromZodError(parsed.error),
    };
  })
  .handler(async ({ data, context }): Promise<ReportFilterRejectionResult> => {
    const { recordActivityLogValidationFailure } = await import("@/lib/activity-log-validation.server");

    // Re-validate the raw filter values server-side rather than trusting the
    // client's issue list, and merge anything extra the server catches.
    const serverCheck = activityLogFilterParamsSchema.safeParse({
      ...(typeof data.rawFilters["logTypes"] === "string" ? { logTypes: data.rawFilters["logTypes"] } : {}),
      ...(typeof data.rawFilters["logSort"] === "string" ? { logSort: data.rawFilters["logSort"] } : {}),
      ...(typeof data.rawFilters["q"] === "string" ? { q: data.rawFilters["q"] } : {}),
    });
    const serverIssues = serverCheck.success ? [] : issuesFromZodError(serverCheck.error);

    const record = await recordActivityLogValidationFailure({
      report: { ...data, issues: [...data.issues, ...serverIssues].slice(0, 20) },
      userId: context.userId,
    });

    return {
      recorded: true,
      serverIssueFields: [...new Set(serverIssues.map((i) => i.field))].sort(),
    };
  });
