/**
 * Server-side validation for the Activity log CSV export.
 *
 * The export used to trust the browser: it built its own `action_type` filter
 * and queried Supabase directly, so a caller who bypassed the client guard
 * (devtools, patched bundle, replayed request) could smuggle an out-of-whitelist
 * or mixed filter into the export path even though the list path rejects it.
 *
 * This server function is the export's enforcement point. It mirrors the logs
 * list endpoint exactly: the same shared guard (`log-action-filter.server.ts`),
 * the same atomic all-or-nothing rejection for mixed valid/invalid lists, and
 * the same `logs_action_type_check` 400 payload (constraint text, allowed list,
 * correlation ID) that the list view's error alert renders.
 */

import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

import {
  logActionFilterRejectionPayload,
  type LogActionFilterRejection,
} from "./log-action-filter-rejection";

/** Stable endpoint id used in structured server logs. */
export const LOG_EXPORT_ENDPOINT = "api.logs.export";

export type LogExportFilterResult =
  | { ok: true; actionTypes: string[] | null }
  | { ok: false; rejection: LogActionFilterRejection };

type Input = { actionTypes?: unknown };

export const validateLogExportFilters = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: Input) => input ?? {})
  .handler(async ({ data }): Promise<LogExportFilterResult> => {
    const raw = data.actionTypes;
    // No action_type filter at all is a legitimate export ("everything").
    if (raw === undefined || raw === null) return { ok: true, actionTypes: null };

    const { checkLogActionFilters } = await import("./log-action-filter.server");
    const checked = checkLogActionFilters(LOG_EXPORT_ENDPOINT, raw);
    if (!checked.ok) {
      return {
        ok: false,
        rejection: logActionFilterRejectionPayload({
          endpoint: checked.error.endpoint,
          rejected: checked.error.rejected,
          requestId: checked.error.requestId,
          allowed: checked.error.allowed,
        }),
      };
    }
    return { ok: true, actionTypes: checked.values };
  });
