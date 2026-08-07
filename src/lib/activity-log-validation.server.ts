/**
 * Server-side sink for activity-log filter validation failures.
 *
 * Two destinations, both best-effort: a structured single-line console warning
 * (visible in the server function logs, greppable by
 * `activity_log_filter_rejected`) and a durable row in
 * `activity_log_filter_rejections` for later tracing. A failed insert must never
 * break the caller's request — diagnostics are not worth a 500.
 */

import {
  buildValidationRecord,
  formatValidationLogLine,
  type ActivityLogValidationRecord,
  type ActivityLogValidationReport,
} from "./activity-log-validation";

export async function recordActivityLogValidationFailure(input: {
  report: ActivityLogValidationReport;
  userId?: string | null;
  userAgent?: string | null;
}): Promise<ActivityLogValidationRecord> {
  const record = buildValidationRecord(input);

  // Structured log first, so the trace exists even if the DB write fails.
  console.warn(formatValidationLogLine(record));

  try {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { error } = await supabaseAdmin.from("activity_log_filter_rejections").insert({
      user_id: record.userId,
      source: record.source,
      blocked: record.blocked,
      issue_fields: record.issueFields,
      issues: record.issues,
      raw_filters: { ...record.rawFilters, correlation_id: record.correlationId },
      user_agent: record.userAgent,
    });
    if (error) {
      console.warn(
        `activity_log_filter_rejected_persist_failed ${JSON.stringify({
          code: error.code,
          message: error.message,
        })}`,
      );
    }
  } catch (err) {
    console.warn(
      `activity_log_filter_rejected_persist_threw ${JSON.stringify({
        message: err instanceof Error ? err.message : String(err),
      })}`,
    );
  }

  return record;
}
