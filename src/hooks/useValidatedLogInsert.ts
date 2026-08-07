import { useCallback } from "react";
import { insertLog, validateLogInsertActionTypes, type LogRowInput } from "@/lib/log-action-types";

/**
 * React hook that wraps the logs write API with client-side validation.
 *
 * Any `action_type` outside the generated `LogAction` whitelist is rejected
 * before `insertLog` is called, so the logs write API never receives an
 * invalid action_type from the client.
 */
export function useValidatedLogInsert(client: Parameters<typeof insertLog>[0]) {
  return useCallback(
    async (rows: LogRowInput | LogRowInput[]) => {
      const validation = validateLogInsertActionTypes(rows);
      if (!validation.ok) {
        console.error(
          "[logs] client-side validation blocked insert:",
          validation.error.message,
          validation.error.hint,
        );
        return { error: validation.error };
      }
      return insertLog(client, rows);
    },
    [client],
  );
}
