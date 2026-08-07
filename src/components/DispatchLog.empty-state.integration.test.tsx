// @vitest-environment jsdom
/**
 * UI integration test: the Activity log's empty state must distinguish
 * "you have no activity yet" from "your filters matched nothing".
 *
 * Truly empty  -> "No dispatches yet. Actions will appear here in real time."
 * Filtered out -> "No entries match the selected filters." (+ Clear filters)
 * Date range   -> range-specific copy suggesting a wider range
 * Archive scope-> "Nothing archived yet."
 */
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { LOG_ACTION_TYPES } from "@/lib/log-action-types.generated";

const GOOD_TYPE = LOG_ACTION_TYPES[0]!;
const OTHER_TYPE = LOG_ACTION_TYPES[1] ?? GOOD_TYPE;
const ROW_MESSAGE = "dispatch row body";

/** When false the `logs` table behaves as a brand-new business: zero rows. */
let hasAnyRows = true;

const baseRow = {
  id: "row-1",
  action_type: GOOD_TYPE,
  message_sent: ROW_MESSAGE,
  created_at: new Date("2026-06-01T12:00:00.000Z").toISOString(),
  status: "sent",
  customer_id: null,
  recipient_phone: null,
};

/**
 * Minimal PostgREST emulation: rows only survive when no narrowing filter was
 * applied, so any quick filter produces the "no match" empty state while the
 * unfiltered view still renders a row.
 */
function makeBuilder(table: string) {
  const isLogs = table === "logs" || table === "logs_archive";
  let narrowed = table === "logs_archive";
  const result = () => ({
    data: isLogs && hasAnyRows && !narrowed ? [baseRow] : [],
    error: null,
  });
  const b: Record<string, unknown> = {
    select: () => b,
    order: () => b,
    limit: () => b,
    returns: () => Promise.resolve(result()),
    then: (resolve: (v: unknown) => unknown) => resolve(result()),
  };
  for (const fn of ["gte", "lte", "lt", "gt", "eq", "in", "or"]) {
    b[fn] = () => {
      if (isLogs) narrowed = true;
      return b;
    };
  }
  return b;
}

vi.mock("@/integrations/supabase/client", () => ({
  supabase: { from: (table: string) => makeBuilder(table) },
}));

vi.mock("sonner", () => ({
  toast: { error: vi.fn(), success: vi.fn(), info: vi.fn(), message: vi.fn(), warning: vi.fn() },
}));

vi.mock("@/lib/activity-log-validation.reporter", () => ({
  reportFilterRejection: vi.fn(),
}));

let searchState: Record<string, unknown> = {};
const subscribers = new Set<() => void>();

vi.mock("@tanstack/react-router", () => ({
  Link: ({ children }: { children?: React.ReactNode }) => React.createElement("a", null, children),
  useNavigate: () => (opts: { search?: unknown }) => {
    const next =
      typeof opts.search === "function"
        ? (opts.search as (p: Record<string, unknown>) => Record<string, unknown>)(searchState)
        : ((opts.search as Record<string, unknown>) ?? {});
    const cleaned: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(next)) if (v !== undefined) cleaned[k] = v;
    searchState = cleaned;
    subscribers.forEach((fn) => fn());
  },
  useSearch: ({ select }: { select?: (s: Record<string, unknown>) => unknown }) => {
    const snapshot = React.useSyncExternalStore(
      (cb) => {
        subscribers.add(cb);
        return () => subscribers.delete(cb);
      },
      () => searchState,
      () => searchState,
    );
    return select ? select(snapshot) : snapshot;
  },
}));

const { DispatchLog } = await import("./DispatchLog");

function renderLog(search: Record<string, unknown> = {}) {
  searchState = search;
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <DispatchLog limit={25} />
    </QueryClientProvider>,
  );
}

const EMPTY_ALL = /No dispatches yet\. Actions will appear here in real time\./i;
const EMPTY_FILTERED = /No entries match the selected filters\./i;
const EMPTY_RANGE = /No entries in the selected date range/i;
const EMPTY_ARCHIVE = /Nothing archived yet/i;

beforeEach(() => {
  hasAnyRows = true;
  searchState = {};
  window.localStorage.clear();
});

afterEach(() => cleanup());

describe("DispatchLog empty state distinguishes no activity from no matches", () => {
  it("says there are no dispatches yet when activity is truly empty and no filters are set", async () => {
    hasAnyRows = false;
    renderLog();

    await waitFor(() => expect(screen.getByText(EMPTY_ALL)).toBeTruthy());
    expect(screen.queryByText(EMPTY_FILTERED)).toBeNull();
    expect(screen.queryByText(EMPTY_RANGE)).toBeNull();
    // Nothing to clear when the log is genuinely empty.
    expect(screen.queryByRole("button", { name: /Clear all filters/i })).toBeNull();
  });

  it("switches to the filtered empty message after a type filter matches nothing", async () => {
    const user = userEvent.setup();
    renderLog();

    // Baseline: unfiltered view renders the row, no empty state at all.
    await waitFor(() => expect(screen.getByText(ROW_MESSAGE)).toBeTruthy());
    expect(screen.queryByText(EMPTY_ALL)).toBeNull();

    await user.click(screen.getByRole("button", { name: new RegExp(GOOD_TYPE, "i") }));

    await waitFor(() => expect(screen.getByText(EMPTY_FILTERED)).toBeTruthy());
    expect(screen.queryByText(EMPTY_ALL)).toBeNull();
    expect(screen.queryByText(ROW_MESSAGE)).toBeNull();
    // Recovery affordance is offered for a filtered miss.
    expect(screen.getByRole("button", { name: /Clear all filters/i })).toBeTruthy();
  });

  it("shows the filtered message for the Failed only quick filter", async () => {
    const user = userEvent.setup();
    renderLog();
    await waitFor(() => expect(screen.getByText(ROW_MESSAGE)).toBeTruthy());

    await user.click(screen.getByLabelText(/Failed only/i));

    await waitFor(() => expect(screen.getByText(EMPTY_FILTERED)).toBeTruthy());
    expect(screen.queryByText(EMPTY_ALL)).toBeNull();
  });

  it("shows the filtered message for the ACTIVE only origin chip", async () => {
    const user = userEvent.setup();
    renderLog();
    await waitFor(() => expect(screen.getByText(ROW_MESSAGE)).toBeTruthy());

    await user.click(screen.getByRole("button", { name: /ACTIVE only/i }));

    await waitFor(() => expect(screen.getByText(EMPTY_FILTERED)).toBeTruthy());
    expect(screen.queryByText(EMPTY_ALL)).toBeNull();
  });

  it("prefers the date-range message over the generic filtered one", async () => {
    renderLog({ dateFrom: "2026-01-01", dateTo: "2026-01-31", logTypes: OTHER_TYPE });

    await waitFor(() => expect(screen.getByText(EMPTY_RANGE)).toBeTruthy());
    expect(screen.queryByText(EMPTY_FILTERED)).toBeNull();
    expect(screen.queryByText(EMPTY_ALL)).toBeNull();
  });

  it("uses archive-specific copy when the archive scope is empty and unfiltered", async () => {
    renderLog({ logScope: "archive" });

    await waitFor(() => expect(screen.getByText(EMPTY_ARCHIVE)).toBeTruthy());
    expect(screen.queryByText(EMPTY_ALL)).toBeNull();
    expect(screen.queryByText(EMPTY_FILTERED)).toBeNull();
  });

  it("returns to the truly-empty message once filters are cleared", async () => {
    const user = userEvent.setup();
    hasAnyRows = false;
    renderLog({ logTypes: GOOD_TYPE });

    await waitFor(() => expect(screen.getByText(EMPTY_FILTERED)).toBeTruthy());

    await user.click(screen.getByRole("button", { name: /Clear all filters/i }));

    await waitFor(() => expect(screen.getByText(EMPTY_ALL)).toBeTruthy());
    expect(screen.queryByText(EMPTY_FILTERED)).toBeNull();
    expect(searchState["logTypes"]).toBeUndefined();
  });
});
