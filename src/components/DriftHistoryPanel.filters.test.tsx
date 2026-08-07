// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { DriftHistoryPanel } from "./DriftHistoryPanel";

const baseRuns = [
  {
    id: "run-1",
    matched: true,
    ranAt: "2026-08-07T10:00:00Z",
    detail: "All values matched",
    dbValues: ["a", "b"],
    generatedValues: ["a", "b"],
  },
  {
    id: "run-2",
    matched: false,
    ranAt: "2026-08-06T10:00:00Z",
    detail: "Drift detected",
    dbValues: ["a"],
    generatedValues: ["a", "b"],
  },
  {
    id: "run-3",
    matched: true,
    ranAt: "2026-08-05T10:00:00Z",
    detail: "All values matched",
    dbValues: ["a", "b"],
    generatedValues: ["a", "b"],
  },
];

const isoToday = () => {
  const d = new Date();
  return d.toISOString();
};

const isoDaysAgo = (days: number) => {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return d.toISOString();
};

afterEach(() => cleanup());

describe("DriftHistoryPanel filters", () => {
  it("shows all runs by default and reports the count", () => {
    render(<DriftHistoryPanel runs={baseRuns} />);
    expect(screen.getByText("Drift history · 3 of 3 runs")).toBeTruthy();
    expect(screen.getAllByText(/Passed|Failed/).length).toBeGreaterThanOrEqual(3);
  });

  it("filters to only passed runs", async () => {
    const user = userEvent.setup();
    render(<DriftHistoryPanel runs={baseRuns} />);
    await user.click(screen.getByTestId("drift-status-filter-pass"));
    expect(screen.getByText("Drift history · 2 of 3 runs")).toBeTruthy();
    expect(screen.queryByText("Drift detected")).toBeNull();
  });

  it("filters to only failed runs", async () => {
    const user = userEvent.setup();
    render(<DriftHistoryPanel runs={baseRuns} />);
    await user.click(screen.getByTestId("drift-status-filter-fail"));
    expect(screen.getByText("Drift history · 1 of 3 runs")).toBeTruthy();
    expect(screen.getByText("Drift detected")).toBeTruthy();
    expect(screen.queryByText("All values matched")).toBeNull();
  });

  it("filters by date range using a preset", async () => {
    const user = userEvent.setup();
    const runs = [
      { id: "today-pass", matched: true, ranAt: isoToday(), detail: "All values matched", dbValues: ["a"], generatedValues: ["a"] },
      { id: "old-fail", matched: false, ranAt: isoDaysAgo(10), detail: "Drift detected", dbValues: ["a"], generatedValues: ["a", "b"] },
    ];
    render(<DriftHistoryPanel runs={runs} />);

    await user.click(screen.getByRole("button", { name: /date range/i }));
    await user.click(screen.getByRole("button", { name: /7 days/i }));

    expect(screen.getByText("Drift history · 1 of 2 runs")).toBeTruthy();
    expect(screen.getByText("All values matched")).toBeTruthy();
    expect(screen.queryByText("Drift detected")).toBeNull();
  });

  it("clears filters and restores all runs", async () => {
    const user = userEvent.setup();
    render(<DriftHistoryPanel runs={baseRuns} />);
    await user.click(screen.getByTestId("drift-status-filter-fail"));
    expect(screen.getByText("Drift history · 1 of 3 runs")).toBeTruthy();

    const clearButton = screen.getByRole("button", { name: "Clear filters" });
    await user.click(clearButton);

    expect(screen.getByText("Drift history · 3 of 3 runs")).toBeTruthy();
  });

  it("shows an empty state when filters exclude every run", async () => {
    const user = userEvent.setup();
    const runs = [
      { id: "today-pass", matched: true, ranAt: isoToday(), detail: "All values matched", dbValues: ["a"], generatedValues: ["a"] },
      { id: "old-fail", matched: false, ranAt: isoDaysAgo(10), detail: "Drift detected", dbValues: ["a"], generatedValues: ["a", "b"] },
    ];
    render(<DriftHistoryPanel runs={runs} />);

    await user.click(screen.getByTestId("drift-status-filter-fail"));
    await user.click(screen.getByRole("button", { name: /date range/i }));
    await user.click(screen.getByRole("button", { name: /7 days/i }));

    expect(screen.getByText(/no drift runs match the current filters/i)).toBeTruthy();
    expect(
      screen.getByRole("button", { name: /clear filters and show all runs/i }),
    ).toBeTruthy();
  });

  it("announces the filtered count via an aria-live region", () => {
    render(<DriftHistoryPanel runs={baseRuns} />);
    const liveRegion = screen.getByRole("status");
    expect(liveRegion.textContent).toContain("Showing 3 drift runs");
  });

  it("clears focusable date range clear button only when a range is set", async () => {
    const user = userEvent.setup();
    const runs = [
      { id: "today-pass", matched: true, ranAt: isoToday(), detail: "All values matched", dbValues: ["a"], generatedValues: ["a"] },
    ];
    render(<DriftHistoryPanel runs={runs} />);
    expect(screen.queryByLabelText(/clear date range/i)).toBeNull();

    await user.click(screen.getByRole("button", { name: /date range/i }));
    await user.click(screen.getByRole("button", { name: /^Today$/i }));

    expect(screen.getByLabelText(/clear date range/i)).toBeTruthy();
  });
});
