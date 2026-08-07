// @vitest-environment jsdom
/**
 * Integration coverage for the Activity log's keyset pagination:
 *
 * 1. "Load 25 older" walks the cursor backwards through the log without
 *    duplicating or skipping rows, and stops with "No more older actions"
 *    once a short (partial) page comes back.
 * 2. Switching a quick filter ("ACTIVE only") resets pagination: the cursor
 *    starts over at null, only rows for the new filter render, and the loaded
 *    count reflects the new view rather than mixing in the previous pages.
 *
 * Supabase is stubbed with a keyset-aware fake that honours the `lt` cursor,
 * `limit`, and `eq(action_type)` exactly as Postgres would, so the real
 * component logic drives every assertion.
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

/**
 * 60 quote rows + 5 automation rows, newest first. 60 is not a multiple of 25,
 * so the third page is short and must end pagination.
 */
const QUOTE_ROWS: Row[] = Array.from({ length: 60 }, (_, i) => ({
  id: `q${i}`,
  action_type: "quote_sms",
  message_sent: `quote row ${i}`,
  created_at: new Date(BASE - i * 60_000).toISOString(),
  status: null,
  customer_id: null,
}));

const ACTIVE_ROWS: Row[] = Array.from({ length: 5 }, (_, i) => ({
  id: `a${i}`,
  action_type: "automation_status_change",
  message_sent: `automation row ${i}`,
  created_at: new Date(BASE - (i + 0.5) * 60_000).toISOString(),
  status: "backend",
  customer_id: null,
}));

const ALL_ROWS = [...QUOTE_ROWS, ...ACTIVE_ROWS].sort((a, b) =>
  a.created_at < b.created_at ? 1 : -1,
);

/** Every cursor the component asked for, in order — the pagination trace. */
let cursors: (string | null)[] = [];

function makeBuilder(table: string) {
  const state: {
    limit: number;
    lt?: string;
    actionTypes?: string[];
    eq: Record<string, string>;
  } = { limit: PAGE, eq: {} };

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
    in: (_col: string, values: string[]) => {
      state.actionTypes = values;
      return b;
    },
    eq: (col: string, value: string) => {
      state.eq[col] = value;
      return b;
    },
    returns: () => {
      cursors.push(state.lt ?? null);
      let rows = table === "logs" ? [...ALL_ROWS] : [];
      if (state.lt) rows = rows.filter((r) => r.created_at < state.lt!);
      if (state.actionTypes) rows = rows.filter((r) => state.actionTypes!.includes(r.action_type));
      for (const [col, value] of Object.entries(state.eq)) {
        rows = rows.filter((r) => String((r as unknown as Record<string, unknown>)[col] ?? "") === value);
      }
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

const loadedCount = async (n: number) =>
  waitFor(() => expect(screen.getByText(`${n} loaded`)).toBeTruthy());

const loadOlder = () => screen.getByRole("button", { name: new RegExp(`Load ${PAGE} older`, "i") });

beforeEach(() => {
  searchState = {};
  cursors = [];
  window.localStorage.removeItem("temaro-activity-log-types");
});

afterEach(() => cleanup());

describe("Activity log keyset pagination", () => {
  it("walks the cursor backwards and stops at the end of the log", async () => {
    const user = userEvent.setup();
    renderLog();

    // First page: cursor null, a full page of rows.
    await loadedCount(PAGE);
    expect(cursors[0]).toBeNull();

    await user.click(loadOlder());
    await loadedCount(PAGE * 2);

    // Second request continued from the last row of page one — no re-fetch
    // from the top, so no duplicates and no skipped rows.
    await waitFor(() => expect(cursors.length).toBeGreaterThanOrEqual(2));
    expect(cursors[1]).toBe(ALL_ROWS[PAGE - 1]!.created_at);

    await user.click(loadOlder());

    // 65 total rows: the third page is short (15), which ends pagination.
    await loadedCount(ALL_ROWS.length);
    expect(cursors[2]).toBe(ALL_ROWS[PAGE * 2 - 1]!.created_at);

    // Terminal state: the button is gone and the end marker is shown.
    await waitFor(() =>
      expect(screen.getByText(/No more older actions/i)).toBeTruthy(),
    );
    expect(screen.queryByRole("button", { name: /Load \d+ older/i })).toBeNull();

    // Cursors were strictly decreasing, so pages never overlapped.
    const seen = cursors.slice(1) as string[];
    expect(seen).toEqual([...seen].sort().reverse());
  });

  it("resets the cursor to the top when a quick filter changes", async () => {
    const user = userEvent.setup();
    renderLog();

    await loadedCount(PAGE);
    await user.click(loadOlder());
    await loadedCount(PAGE * 2);

    cursors = [];
    await user.click(screen.getByRole("button", { name: /ACTIVE only/i }));

    // Only the 5 automation rows remain, and pagination restarted from null:
    // the previously-loaded 50 rows are not mixed into the filtered view.
    await loadedCount(ACTIVE_ROWS.length);
    await waitFor(() => expect(cursors[0]).toBeNull());
    expect(cursors.every((c) => c === null)).toBe(true);

    expect(screen.getByText("automation row 0")).toBeTruthy();
    expect(screen.queryByText("quote row 0")).toBeNull();

    // A 5-row page is short, so the filtered view is already at its end.
    await waitFor(() => expect(screen.getByText(/No more older actions/i)).toBeTruthy());
    expect(screen.queryByRole("button", { name: /Load \d+ older/i })).toBeNull();
  });
});
