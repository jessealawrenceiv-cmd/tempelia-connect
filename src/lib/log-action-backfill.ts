import type { LogActionType } from "@/lib/log-action-types";

/**
 * Action types that have a source of truth we can rebuild missing log entries
 * from (see public.reconcile_activity_logs_scoped). Everything else is written
 * live by the app only, so there is nothing to backfill.
 */
export const BACKFILLABLE_ACTION_TYPES = [
  "number_provisioned",
  "sms_inbound",
  "missed_call_text",
  "missed_call_autotext",
] as const satisfies readonly LogActionType[];

export type BackfillableActionType = (typeof BACKFILLABLE_ACTION_TYPES)[number];

export function isBackfillable(actionType: string): actionType is BackfillableActionType {
  return (BACKFILLABLE_ACTION_TYPES as readonly string[]).includes(actionType);
}

export const BACKFILL_SOURCE_LABEL: Record<BackfillableActionType, string> = {
  number_provisioned: "public.profiles provisioning fields",
  sms_inbound: "verified inbound-SMS webhook events",
  missed_call_text: "verified missed-call webhook events",
  missed_call_autotext: "verified missed-call webhook events",
};

export interface BackfillResult {
  runId: string | null;
  actionType: string;
  businessId: string;
  insertedCount: number;
  durationMs: number;
  supported: boolean;
  detail: string;
  finishedAt: string;
}
