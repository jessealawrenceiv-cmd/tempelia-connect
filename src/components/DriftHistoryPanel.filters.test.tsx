import { describe, expect, it } from "vitest";
import { render, screen, within } from "@testing-library/react";
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

describe("DriftHistoryPanel filters", () => {
  it("shows all runs by default and reports the count", () => {
    render(<DriftHistoryPanel runs={baseRuns} />);
    expect(screen.getByText("Drift history · 3 of 3 runs")).toBeInTheDocument();
    expect(screen.getAllByText(/Passed|Failed/).length).toBeGreaterThanOrEqual(3);
  });

  it("filters to only passed runs", async () => {
    render(<DriftHistoryPanel runs={baseRuns} />);
    await userEvent.click(screen.getByRole("button", { name: /passed/i, pressed: false }));
    expect(screen.getByText("Drift history · 2 of 3 runs")).toBeInTheDocument();
    expect(screen.queryByText("Drift detected")).not.toBeInTheDocument();
  });

  it("filters to only failed runs", async () => {
    render(<DriftHistoryPanel runs={baseRuns} />);
    await userEvent.click(screen.getByRole("button", { name: /failed/i, pressed: false }));
    expect(screen.getByText("Drift history · 1 of 3 runs")).toBeInTheDocument();
    expect(screen.getByText("Drift detected")).toBeInTheDocument();
    expect(screen.queryByText("All values matched")).not.toBeInTheDocument();
  });

  it("filters by date range", async () => {
    render(<DriftHistoryPanel runs={baseRuns} />);
    const dateButton = screen.getByRole("button", { name: /date range/i });
    await userEvent.click(dateButton);

    // Pick a range that only includes August 7
    const day7 = screen.getByRole("gridcell", { name: "7" });
    await userEvent.click(day7);
    await userEvent.click(day7);

    // Close the popover by pressing Escape
    await userEvent.keyboard("{Escape}");

    expect(screen.getByText("Drift history · 1 of 3 runs")).toBeInTheDocument();
  });

  it("clears filters and restores all runs", async () => {
    render(<DriftHistoryPanel runs={baseRuns} />);
    await userEvent.click(screen.getByRole("button", { name: /failed/i, pressed: false }));
    expect(screen.getByText("Drift history · 1 of 3 runs")).toBeInTheDocument();

    const clearButton = screen.getByRole("button", { name: /clear filters/i });
    await userEvent.click(clearButton);

    expect(screen.getByText("Drift history · 3 of 3 runs")).toBeInTheDocument();
  });

  it("shows an empty state when filters exclude every run", async () => {
    render(<DriftHistoryPanel runs={baseRuns} />);
    await userEvent.click(screen.getByRole("button", { name: /failed/i, pressed: false }));

    const dateButton = screen.getByRole("button", { name: /date range/i });
    await userEvent.click(dateButton);

    // Pick a range in a different month/year so nothing matches
    const prevMonth = screen.getByRole("button", { name: /previous month/i });
    await userEvent.click(prevMonth);
    await userEvent.click(prevMonth);
    const day1 = screen.getByRole("gridcell", { name: "1" });
    await userEvent.click(day1);
    await userEvent.click(day1);
    await userEvent.keyboard("{Escape}");

    expect(screen.getByText(/no drift runs match the current filters/i)).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /clear filters and show all runs/i }),
    ).toBeInTheDocument();
  });

  it("announces the filtered count via an aria-live region", () => {
    render(<DriftHistoryPanel runs={baseRuns} />);
    const liveRegion = screen.getByRole("status");
    expect(liveRegion).toHaveTextContent("Showing 3 drift runs");
  });
});
