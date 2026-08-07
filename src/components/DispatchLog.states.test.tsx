// @vitest-environment jsdom
/**
 * Integration coverage for the Activity log's three non-happy-path states:
 *
 * 1. Loading — skeleton rows render while the first keyset page is in flight,
 *    and no empty-state or error copy leaks through.
 * 2. Empty — a successful but empty page renders the "no dispatches yet"
 *    message, no rows, and no "N loaded" footer.
 * 3. Server error — a Postgres error surfaces the Couldn't load activity alert
 *    with a working Retry button that refetches and recovers into rows.
 *
 * Supabase is stubbed with a controllable fake so each state is driven through
 * the real component logic rather than mocked-out UI.
 */
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

type Row = {
  id: string;
  action_type: string;
  message_sent: string | null;
  created_at: string;
  status: string | null;
  customer_id: string | null;
};

const PAGE = 25;

const ROWS: Row[] = [
  {
    id: "r1",
    action_type: "quote_sms",
    message_sent: "quote row 1",
    created_at: new Date("2026-06-01T12:00:00.000Z").toISOString(),
    status: null,
    customer_id: null,
  },
];

type Mode =
  | { kind: "pending" }
  | { kind: "rows"; rows: Row[] }
  | { kind: "error"; message: string; code?: string };

/** Mutable response mode; each test flips it to drive one state. */
let mode: Mode = { kind: "rows", rows: ROWS };
let requestCount = 0;

function makeBuilder(table: string) {
  const b: Record<string, unknown> = {
    select: () => b,
    order: () => b,
    limit: () => b,
    lt: () => b,
    gt: () => b,
    gte: () => b,
    lte: () => b,
    or: () => b,
    in: () => b,
    eq: () => b,
    returns: () => {
      if (table !== "logs") return Promise.resolve({ data: [], error: null });
      requestCount += 1;
      if (mode.kind === "pending") return new Promise(() => {});
      if (mode.kind === "error") {
        return Promise.resolve({
          data: null,
          error: { message: mode.message, code: mode.code ?? "500" },
        });
      }
      return Promise.resolve({ data: mode.rows, error: null });
    },
  };
  return b;
}

vi.mock("@/integrations/supabase/client", () => ({
  supabase: { from: (table: string) => makeBuilder(table) },
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

function renderLog() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <DispatchLog limit={PAGE} />
    </QueryClientProvider>,
  );
}

const skeletons = (container: HTMLElement) =>
  container.querySelectorAll('[aria-hidden="true"] .animate-pulse').length;

beforeEach(() => {
  searchState = {};
  requestCount = 0;
  mode = { kind: "rows", rows: ROWS };
  window.localStorage.removeItem("temaro-activity-log-types");
});

afterEach(() => cleanup());

describe("Activity log loading state", () => {
  it("shows skeleton rows while the first page is in flight", async () => {
    mode = { kind: "pending" };
    const { container } = renderLog();

    await waitFor(() => expect(skeletons(container)).toBeGreaterThan(0));

    // Neither the empty state nor the error alert may render while loading.
    expect(screen.queryByText(/No dispatches yet/i)).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByText(/loaded$/i)).toBeNull();
    expect(screen.queryAllByRole("listitem")).toHaveLength(0);
  });

  it("clears the skeletons once rows arrive", async () => {
    const { container } = renderLog();

    await waitFor(() => expect(screen.getByText("quote row 1")).toBeTruthy());
    expect(skeletons(container)).toBe(0);
    expect(screen.getByText("1 loaded")).toBeTruthy();
  });
});

describe("Activity log empty state", () => {
  it("explains that nothing has happened yet when no filters are applied", async () => {
    mode = { kind: "rows", rows: [] };
    renderLog();

    await waitFor(() =>
      expect(screen.getByText(/No dispatches yet\. Actions will appear here in real time\./i)).toBeTruthy(),
    );

    // Empty is not an error, and the loaded-count footer stays hidden.
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByText(/\d+ loaded/)).toBeNull();
    expect(screen.queryByRole("button", { name: /Load \d+ older/i })).toBeNull();
  });

  it("tells the user filters are hiding everything when a filter is active", async () => {
    mode = { kind: "rows", rows: [] };
    const user = userEvent.setup();
    renderLog();

    await waitFor(() => expect(screen.getByText(/No dispatches yet/i)).toBeTruthy());

    await user.click(screen.getByRole("button", { name: /ACTIVE only/i }));

    await waitFor(() =>
      expect(screen.getByText(/No entries match the selected filters\./i)).toBeTruthy(),
    );
    expect(screen.queryByText(/No dispatches yet/i)).toBeNull();
  });
});

describe("Activity log server error state", () => {
  it("surfaces the error alert instead of rows or an empty state", async () => {
    mode = { kind: "error", message: "permission denied for table logs", code: "42501" };
    const { container } = renderLog();

    const alert = await waitFor(() => screen.getByRole("alert"));
    expect(alert.textContent).toMatch(/Couldn’t load activity/i);

    // The error path replaces both the empty state and the skeletons.
    expect(screen.queryByText(/No dispatches yet/i)).toBeNull();
    expect(skeletons(container)).toBe(0);
    expect(screen.queryByText("quote row 1")).toBeNull();
    expect(screen.queryByText(/\d+ loaded/)).toBeNull();
  });

  it("recovers when Retry succeeds", async () => {
    mode = { kind: "error", message: "server error" };
    const user = userEvent.setup();
    renderLog();

    await waitFor(() => screen.getByRole("alert"));
    const before = requestCount;

    mode = { kind: "rows", rows: ROWS };
    await user.click(screen.getByRole("button", { name: /^Retry$/i }));

    await waitFor(() => expect(screen.getByText("quote row 1")).toBeTruthy());
    expect(requestCount).toBeGreaterThan(before);
    expect(screen.queryByRole("alert")).toBeNull();
  });
});
