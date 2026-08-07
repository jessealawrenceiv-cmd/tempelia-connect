import { useCallback, useState } from "react";

import { insertLog, validateLogInsertActionTypes, type LogRowInput } from "@/lib/log-action-types";
import {
  describeLogActionTypeViolation,
  toastLogActionTypeViolation,
  type LogActionTypeViolationDisplay,
} from "@/lib/log-action-violation";

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
        return { error: validation.error };
      }
      const result = await insertLog(client, rows);
      if (result?.error && toastOnViolation) toastLogActionTypeViolation(result.error);
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
