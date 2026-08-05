/**
 * CSV export for the deposit deep-link debug log. One row per saved
 * deposit_jump_* event, with the common payload fields promoted to columns and
 * the full payload retained as JSON for offline review.
 */

import { outcomeOf, type DebugEventName } from "./deposit-jump-debug-filter";

export type DebugCsvEntry = {
  ts: number;
  event: DebugEventName;
  correlationId: string | null;
  payload: Record<string, unknown>;
};

const HEADERS = [
  "occurred_at_utc",
  "event",
  "outcome",
  "correlation_id",
  "event_id",
  "reason",
  "action",
  "attempt_index",
  "ms_since_first_miss",
  "ms_since_miss",
  "duration_ms",
  "payload_json",
];

function escapeCell(value: string): string {
  const safe = /^[=+\-@]/.test(value) ? `'${value}` : value;
  return `"${safe.replace(/"/g, '""')}"`;
}

function str(value: unknown): string {
  if (value === null || value === undefined) return "";
  return String(value);
}

export function buildDepositJumpDebugCsv(entries: DebugCsvEntry[]): string {
  const lines = [HEADERS.join(",")];
  for (const entry of entries) {
    const p = entry.payload ?? {};
    lines.push(
      [
        new Date(entry.ts).toISOString(),
        entry.event,
        outcomeOf(entry.event),
        entry.correlationId ?? str(p["correlation_id"]),
        str(p["event_id"] ?? p["eventId"]),
        str(p["reason"]),
        str(p["action"]),
        str(p["attempt_index"] ?? p["attemptIndex"]),
        str(p["ms_since_first_miss"] ?? p["msSinceFirstMiss"]),
        str(p["ms_since_miss"] ?? p["msSinceMiss"]),
        str(p["duration_ms"] ?? p["durationMs"]),
        JSON.stringify(p),
      ]
        .map((c) => escapeCell(c ?? ""))
        .join(","),
    );
  }
  return lines.join("\r\n");
}

export function depositJumpDebugCsvFilename(quoteShortId: string, now = new Date()): string {
  const stamp = now.toISOString().slice(0, 19).replace(/[:T]/g, "-");
  return `deposit-jump-debug-${quoteShortId || "quote"}-${stamp}.csv`;
}
