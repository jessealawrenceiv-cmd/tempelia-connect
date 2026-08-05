import { describe, expect, it } from "vitest";
import {
  describeDebugFilters,
  filterDebugEntries,
  outcomeOf,
} from "./deposit-jump-debug-filter";

const NOW = 1_700_000_000_000;

const entries = [
  { ts: NOW - 1_000, event: "deposit_jump_success" as const },
  { ts: NOW - 60_000, event: "deposit_jump_miss" as const },
  { ts: NOW - 30 * 60 * 1000, event: "deposit_jump_recovery" as const },
  { ts: NOW - 40 * 60 * 60 * 1000, event: "deposit_jump_miss" as const },
];

describe("outcomeOf", () => {
  it("treats only a confirmed jump as success", () => {
    expect(outcomeOf("deposit_jump_success")).toBe("success");
    expect(outcomeOf("deposit_jump_miss")).toBe("miss");
    expect(outcomeOf("deposit_jump_recovery")).toBe("miss");
  });
});

describe("filterDebugEntries", () => {
  const base = { event: "all", outcome: "all", range: "all" } as const;

  it("returns everything with no filters", () => {
    expect(filterDebugEntries(entries, base, NOW)).toHaveLength(4);
  });

  it("filters by event type", () => {
    const out = filterDebugEntries(
      entries,
      { ...base, event: "deposit_jump_miss" },
      NOW,
    );
    expect(out).toHaveLength(2);
  });

  it("filters by success vs miss outcome", () => {
    expect(
      filterDebugEntries(entries, { ...base, outcome: "success" }, NOW),
    ).toHaveLength(1);
    expect(
      filterDebugEntries(entries, { ...base, outcome: "miss" }, NOW),
    ).toHaveLength(3);
  });

  it("filters by time range", () => {
    expect(filterDebugEntries(entries, { ...base, range: "5m" }, NOW)).toHaveLength(2);
    expect(filterDebugEntries(entries, { ...base, range: "1h" }, NOW)).toHaveLength(3);
    expect(filterDebugEntries(entries, { ...base, range: "24h" }, NOW)).toHaveLength(3);
  });

  it("combines filters", () => {
    const out = filterDebugEntries(
      entries,
      { event: "deposit_jump_miss", outcome: "miss", range: "1h" },
      NOW,
    );
    expect(out).toEqual([{ ts: NOW - 60_000, event: "deposit_jump_miss" }]);
  });
});

describe("describeDebugFilters", () => {
  it("reports no filters", () => {
    expect(describeDebugFilters({ event: "all", outcome: "all", range: "all" })).toBe(
      "no filters",
    );
  });

  it("joins active filters", () => {
    expect(
      describeDebugFilters({
        event: "deposit_jump_miss",
        outcome: "miss",
        range: "1h",
      }),
    ).toBe("deposit_jump_miss · miss · last 1h");
  });
});
