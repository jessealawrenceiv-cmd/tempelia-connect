/**
 * Pure filtering helpers for the deposit-jump debug log panel.
 * Kept out of the component so the narrowing rules are unit-testable.
 */

export type DebugEventName =
  | "deposit_jump_success"
  | "deposit_jump_miss"
  | "deposit_jump_recovery";

export type DebugEventFilter = "all" | DebugEventName;
export type DebugOutcomeFilter = "all" | "success" | "miss";
export type DebugRangeFilter = "all" | "5m" | "1h" | "24h";

export const DEBUG_RANGE_MS: Record<Exclude<DebugRangeFilter, "all">, number> = {
  "5m": 5 * 60 * 1000,
  "1h": 60 * 60 * 1000,
  "24h": 24 * 60 * 60 * 1000,
};

export type FilterableDebugEntry = {
  ts: number;
  event: DebugEventName;
};

/** A success is only the confirmed jump; miss and recovery both describe a failed jump. */
export function outcomeOf(event: DebugEventName): "success" | "miss" {
  return event === "deposit_jump_success" ? "success" : "miss";
}

export function filterDebugEntries<T extends FilterableDebugEntry>(
  entries: T[],
  filters: {
    event: DebugEventFilter;
    outcome: DebugOutcomeFilter;
    range: DebugRangeFilter;
  },
  now: number = Date.now(),
): T[] {
  const cutoff =
    filters.range === "all" ? null : now - DEBUG_RANGE_MS[filters.range];

  return entries.filter((entry) => {
    if (filters.event !== "all" && entry.event !== filters.event) return false;
    if (filters.outcome !== "all" && outcomeOf(entry.event) !== filters.outcome)
      return false;
    if (cutoff !== null && entry.ts < cutoff) return false;
    return true;
  });
}

export function describeDebugFilters(filters: {
  event: DebugEventFilter;
  outcome: DebugOutcomeFilter;
  range: DebugRangeFilter;
}): string {
  const parts: string[] = [];
  if (filters.event !== "all") parts.push(filters.event);
  if (filters.outcome !== "all") parts.push(filters.outcome);
  if (filters.range !== "all") parts.push(`last ${filters.range}`);
  return parts.length ? parts.join(" · ") : "no filters";
}
