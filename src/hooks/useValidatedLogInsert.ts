import { useCallback, useState } from "react";

import { insertLog, validateLogInsertActionTypes, type LogRowInput } from "@/lib/log-action-types";
import { LOGS_ACTION_TYPE_CONSTRAINT } from "@/lib/log-action-types.generated";
import { reportLogWriteRejection } from "@/lib/log-write-rejections.functions";
import {
  describeLogActionTypeViolation,
  toastLogActionTypeViolation,
  type LogActionTypeViolationDisplay,
} from "@/lib/log-action-violation";

/** Best-effort: records the rejection for the operator diagnostics page. */
function reportRejection(
  rows: LogRowInput | LogRowInput[],
  error: unknown,
  blockedAt: "client" | "database",
) {
  const display = describeLogActionTypeViolation(error);
  if (!display) return;
  const list = Array.isArray(rows) ? rows : [rows];
  const allowed = new Set<string>(display.allowed);
  const rejected = list
    .map((r) => String(r.action_type ?? ""))
    .filter((v) => !allowed.has(v));

  void reportLogWriteRejection({
    data: {
      rejectedActionType: display.rejected ?? rejected[0] ?? null,
      rejectedActionTypes: rejected,
      blockedAt,
      constraintName: LOGS_ACTION_TYPE_CONSTRAINT,
      errorCode: blockedAt === "database" ? "23514" : "client_prevalidation",
      errorMessage: display.technical,
      attemptedRow: (list[0] ?? {}) as Record<string, unknown>,
      requestPath: typeof window === "undefined" ? null : window.location.pathname,
    },
  }).catch(() => {
    /* diagnostics must never break the caller */
  });
}

type Options = {
  /** Set false to suppress the automatic toast (e.g. when rendering inline only). */
  toastOnViolation?: boolean;
};

/**
 * React hook that wraps the logs write API with client-side validation.
 *
 * Any `action_type` outside the generated `LogAction` whitelist is rejected
 * before `insertLog` is called, so the logs write API never receives an
 * invalid action_type from the client. Rejections — client-side or a real
 * Postgres `logs_action_type_check` (23514) — surface as a toast that names
 * the rejected value and lists the allowed action_type hints.
 */
export function useValidatedLogInsert(
  client: Parameters<typeof insertLog>[0],
  options: Options = {},
) {
  const { toastOnViolation = true } = options;
  return useCallback(
    async (rows: LogRowInput | LogRowInput[]) => {
      const validation = validateLogInsertActionTypes(rows);
      if (!validation.ok) {
        console.error(
          "[logs] client-side validation blocked insert:",
          validation.error.message,
          validation.error.hint,
        );
        if (toastOnViolation) toastLogActionTypeViolation(validation.error);
        reportRejection(rows, validation.error, "client");
        return { error: validation.error };
      }
      const result = await insertLog(client, rows);
      if (result?.error) {
        if (toastOnViolation) toastLogActionTypeViolation(result.error);
        reportRejection(rows, result.error, "database");
      }
      return result;
    },
    [client, toastOnViolation],
  );
}

/**
 * Same guarantees as `useValidatedLogInsert`, plus violation state for callers
 * that want to render an inline error (see `LogWriteErrorAlert`).
 */
export function useValidatedLogInsertWithError(
  client: Parameters<typeof insertLog>[0],
  options: Options = {},
) {
  const [violation, setViolation] = useState<LogActionTypeViolationDisplay | null>(null);
  const write = useValidatedLogInsert(client, options);

  const insert = useCallback(
    async (rows: LogRowInput | LogRowInput[]) => {
      const result = await write(rows);
      setViolation(result?.error ? describeLogActionTypeViolation(result.error) : null);
      return result;
    },
    [write],
  );

  const clearViolation = useCallback(() => setViolation(null), []);

  return { insert, violation, clearViolation };
}
