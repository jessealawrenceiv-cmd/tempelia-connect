// @vitest-environment jsdom
/**
 * Integration coverage for the Activity log's error → Retry path.
 *
 * When a page request fails, the log shows a "Couldn't load activity" alert
 * alongside whatever rows are already loaded. Tapping **Retry** must:
 *
 * 1. re-fetch through the *same* cursors the loaded pages were fetched with
 *    (keyset page params, not the cursor of the failed request),
 * 2. clear the server-error state once the request succeeds,
 * 3. leave exactly one copy of every row — a retry must never duplicate or
 *    drop rows already on screen,
 * 4. keep "Load 25 older" working from the correct cursor afterwards.
 *
 * Supabase is stubbed with a keyset-aware fake that honours `lt` + `limit`
 * and can be told to fail the next request, so the real component logic
 * drives every assertion.
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
const BASE = new Date("2026-06-01T12:00:00.000Z").getTime();

/** 55 rows, newest first: two full pages plus a short third page. */
const ALL_ROWS: Row[] = Array.from({ length: 55 }, (_, i) => ({
  id: `q${i}`,
  action_type: "quote_sms",
  message_sent: `quote row ${i}`,
  created_at: new Date(BASE - i * 60_000).toISOString(),
  status: null,
  customer_id: null,
}));

/** Every cursor the component asked for, in request order. */
let cursors: (string | null)[] = [];
/** How many of the next requests should fail. */
let failCount = 0;

class FakeLogError extends Error {
  code = "PGRST500";
  details = "connection reset by peer";
  constructor() {
    super("upstream request timed out");
  }
}

function makeBuilder(table: string) {
  const state: { limit: number; lt?: string } = { limit: PAGE };
  const b: Record<string, unknown> = {
    select: () => b,
    order: () => b,
    limit: (n: number) => {
      state.limit = n;
      return b;
    },
    lt: (_col: string, value: string) => {
      state.lt = value;
      return b;
    },
    gt: () => b,
    gte: () => b,
    lte: () => b,
    or: () => b,
    in: () => b,
    eq: () => b,
    returns: () => {
      cursors.push(state.lt ?? null);
      if (failCount > 0) {
        failCount -= 1;
        return Promise.resolve({ data: null, error: new FakeLogError() });
      }
      let rows = table === "logs" ? [...ALL_ROWS] : [];
      if (state.lt) rows = rows.filter((r) => r.created_at < state.lt!);
      return Promise.resolve({ data: rows.slice(0, state.limit), error: null });
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

const loadedCount = (n: number) =>
  waitFor(() => expect(screen.getByText(`${n} loaded`)).toBeTruthy());

const loadOlder = () => screen.getByRole("button", { name: new RegExp(`Load ${PAGE} older`, "i") });
const retryButton = () => screen.getByRole("button", { name: /^Retry$/i });
const errorAlert = () => screen.queryByText(/Couldn’t load activity|Couldn't load activity/i);
const rowCopies = (text: string) => screen.queryAllByText(text).length;

beforeEach(() => {
  searchState = {};
  cursors = [];
  failCount = 0;
  window.localStorage.removeItem("temaro-activity-log-types");
});

afterEach(() => cleanup());

describe("Activity log Retry after a server error", () => {
  it("re-fetches the loaded pages with the same cursors and clears the error without duplicating rows", async () => {
    const user = userEvent.setup();
    renderLog();

    // Two good pages, then a failing third request.
    await loadedCount(PAGE);
    await user.click(loadOlder());
    await loadedCount(PAGE * 2);

    const pageCursors = [...cursors];
    expect(pageCursors[0]).toBeNull();
    expect(pageCursors[1]).toBe(ALL_ROWS[PAGE - 1]!.created_at);

    failCount = 1;
    await user.click(loadOlder());

    // Error surfaces without discarding the rows already on screen.
    await waitFor(() => expect(errorAlert()).toBeTruthy());
    await loadedCount(PAGE * 2);
    expect(screen.getByText(/upstream request timed out/i)).toBeTruthy();

    // Retry re-runs the two loaded pages with their original cursors — never
    // the cursor of the failed request.
    cursors = [];
    await user.click(retryButton());

    await waitFor(() => expect(cursors.length).toBe(2));
    expect(cursors).toEqual(pageCursors);

    // Server-error state cleared, row count unchanged, no duplicated rows.
    await waitFor(() => expect(errorAlert()).toBeNull());
    await loadedCount(PAGE * 2);
    expect(rowCopies("quote row 0")).toBe(1);
    expect(rowCopies("quote row 24")).toBe(1);
    expect(rowCopies("quote row 49")).toBe(1);
    expect(screen.queryByText("quote row 50")).toBeNull();

    // Pagination still continues from the correct cursor after the retry.
    await user.click(loadOlder());
    await loadedCount(ALL_ROWS.length);
    expect(cursors[cursors.length - 1]).toBe(ALL_ROWS[PAGE * 2 - 1]!.created_at);
    expect(rowCopies("quote row 50")).toBe(1);
  });

  it("retries the very first page from a null cursor and renders each row once", async () => {
    const user = userEvent.setup();
    failCount = 1;
    renderLog();

    await waitFor(() => expect(errorAlert()).toBeTruthy());
    expect(cursors).toEqual([null]);
    expect(screen.queryByText("quote row 0")).toBeNull();

    cursors = [];
    await user.click(retryButton());

    await waitFor(() => expect(errorAlert()).toBeNull());
    await loadedCount(PAGE);
    expect(cursors).toEqual([null]);
    expect(rowCopies("quote row 0")).toBe(1);
    expect(rowCopies("quote row 24")).toBe(1);
  });

  it("keeps the error visible and the cursor unchanged when the retry also fails", async () => {
    const user = userEvent.setup();
    renderLog();
    await loadedCount(PAGE);

    failCount = 2; // failing next page + failing retry
    await user.click(loadOlder());
    await waitFor(() => expect(errorAlert()).toBeTruthy());

    cursors = [];
    await user.click(retryButton());

    await waitFor(() => expect(cursors).toEqual([null]));
    expect(errorAlert()).toBeTruthy();
    await loadedCount(PAGE);
    expect(rowCopies("quote row 0")).toBe(1);

    // A third attempt succeeds and clears the alert with no duplicates.
    await user.click(retryButton());
    await waitFor(() => expect(errorAlert()).toBeNull());
    await loadedCount(PAGE);
    expect(rowCopies("quote row 0")).toBe(1);
  });
});
