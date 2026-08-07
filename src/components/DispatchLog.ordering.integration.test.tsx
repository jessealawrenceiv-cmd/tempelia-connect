// @vitest-environment jsdom
/**
 * Integration coverage for chronological ordering in the Activity log.
 *
 * The Supabase stub deliberately stores rows in a shuffled order and only sorts
 * when the component calls `.order(col, { ascending })`, exactly like Postgres.
 * That way these tests fail if the component ever forgets to order, appends a
 * page in the wrong place, or mixes filtered pages out of sequence.
 *
 * 1. Newest-first (default): every rendered row is older than the one above it,
 *    and that holds after loading two older pages.
 * 2. Applying a filter keeps the remaining rows in strict newest-first order.
 * 3. Oldest-first sort flips the order and appended "newer" pages stay ascending.
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

const PAGE = 5;
const BASE = new Date("2026-06-01T12:00:00.000Z").getTime();

/** 12 quote rows + 6 automation rows, interleaved in time. */
const QUOTE_ROWS: Row[] = Array.from({ length: 12 }, (_, i) => ({
  id: `q${i}`,
  action_type: "quote_sms",
  message_sent: `quote row ${i}`,
  created_at: new Date(BASE - i * 120_000).toISOString(),
  status: null,
  customer_id: null,
}));

const ACTIVE_ROWS: Row[] = Array.from({ length: 6 }, (_, i) => ({
  id: `a${i}`,
  action_type: "automation_status_change",
  message_sent: `automation row ${i}`,
  created_at: new Date(BASE - i * 120_000 - 60_000).toISOString(),
  status: "backend",
  customer_id: null,
}));

/** Storage order is intentionally scrambled — ordering must come from the query. */
const STORED_ROWS: Row[] = [
  QUOTE_ROWS[5]!, ACTIVE_ROWS[2]!, QUOTE_ROWS[0]!, QUOTE_ROWS[11]!, ACTIVE_ROWS[5]!,
  QUOTE_ROWS[3]!, ACTIVE_ROWS[0]!, QUOTE_ROWS[8]!, ACTIVE_ROWS[4]!, QUOTE_ROWS[1]!,
  QUOTE_ROWS[9]!, ACTIVE_ROWS[1]!, QUOTE_ROWS[2]!, QUOTE_ROWS[7]!, ACTIVE_ROWS[3]!,
  QUOTE_ROWS[10]!, QUOTE_ROWS[4]!, QUOTE_ROWS[6]!,
];

const TOTAL = STORED_ROWS.length;
const byId = new Map(STORED_ROWS.map((r) => [r.id, r]));

function makeBuilder(table: string) {
  const state: {
    limit: number;
    lt?: string;
    gt?: string;
    ascending: boolean;
    actionTypes?: string[];
    eq: Record<string, string>;
  } = { limit: PAGE, ascending: false, eq: {} };

  const b: Record<string, unknown> = {
    select: () => b,
    order: (_col: string, opts?: { ascending?: boolean }) => {
      state.ascending = opts?.ascending === true;
      return b;
    },
    limit: (n: number) => {
      state.limit = n;
      return b;
    },
    lt: (_col: string, value: string) => {
      state.lt = value;
      return b;
    },
    gt: (_col: string, value: string) => {
      state.gt = value;
      return b;
    },
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
      let rows = table === "logs" ? [...STORED_ROWS] : [];
      if (state.lt) rows = rows.filter((r) => r.created_at < state.lt!);
      if (state.gt) rows = rows.filter((r) => r.created_at > state.gt!);
      if (state.actionTypes) rows = rows.filter((r) => state.actionTypes!.includes(r.action_type));
      for (const [col, value] of Object.entries(state.eq)) {
        rows = rows.filter(
          (r) => String((r as unknown as Record<string, unknown>)[col] ?? "") === value,
        );
      }
      rows.sort((x, y) =>
        x.created_at === y.created_at ? 0 : x.created_at < y.created_at === state.ascending ? -1 : 1,
      );
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

let container: HTMLElement;

function renderLog() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const result = render(
    <QueryClientProvider client={queryClient}>
      <DispatchLog limit={PAGE} />
    </QueryClientProvider>,
  );
  container = result.container;
  return result;
}

/** Rendered dispatch rows, top to bottom. */
function renderedRows(): Row[] {
  return Array.from(container.querySelectorAll<HTMLElement>('[id^="log-row-"]'))
    .map((el) => byId.get(el.id.replace("log-row-", "")))
    .filter((r): r is Row => Boolean(r));
}

const loadedCount = async (n: number) =>
  waitFor(() => expect(screen.getByText(`${n} loaded`)).toBeTruthy());

const loadMore = () => screen.getByRole("button", { name: /Load \d+ (older|newer)/i });

function expectStrictOrder(rows: Row[], dir: "desc" | "asc") {
  expect(rows.length).toBeGreaterThan(0);
  const times = rows.map((r) => new Date(r.created_at).getTime());
  const expected = [...times].sort((a, b) => (dir === "desc" ? b - a : a - b));
  expect(times).toEqual(expected);
  // Strictly monotonic: no duplicated rows anywhere in the list.
  expect(new Set(rows.map((r) => r.id)).size).toBe(rows.length);
}

beforeEach(() => {
  searchState = {};
  window.localStorage.removeItem("temaro-activity-log-types");
});

afterEach(() => cleanup());

describe("Activity log chronological ordering", () => {
  it("renders newest first and keeps order while loading older pages", async () => {
    const user = userEvent.setup();
    renderLog();

    await loadedCount(PAGE);
    expectStrictOrder(renderedRows(), "desc");
    // Newest stored row leads the list even though it is not first in storage.
    expect(renderedRows()[0]!.id).toBe("q0");

    await user.click(loadMore());
    await loadedCount(PAGE * 2);
    expectStrictOrder(renderedRows(), "desc");

    await user.click(loadMore());
    await loadedCount(PAGE * 3);
    const rows = renderedRows();
    expectStrictOrder(rows, "desc");

    // The appended page continues below the first ones — no interleaving.
    expect(rows.slice(0, PAGE * 2).map((r) => r.id)).toEqual(
      [...STORED_ROWS]
        .sort((a, b) => (a.created_at < b.created_at ? 1 : -1))
        .slice(0, PAGE * 2)
        .map((r) => r.id),
    );
  });

  it("keeps newest-first order after a filter is applied", async () => {
    const user = userEvent.setup();
    renderLog();

    await loadedCount(PAGE);
    await user.click(loadMore());
    await loadedCount(PAGE * 2);

    await user.click(screen.getByRole("button", { name: /ACTIVE only/i }));
    await loadedCount(ACTIVE_ROWS.length);

    const rows = renderedRows();
    expect(rows.every((r) => r.action_type === "automation_status_change")).toBe(true);
    expectStrictOrder(rows, "desc");
    expect(rows[0]!.id).toBe("a0");
  });

  it("flips to oldest-first and keeps ascending order across pages", async () => {
    const user = userEvent.setup();
    renderLog();

    await loadedCount(PAGE);
    await user.click(screen.getByRole("button", { name: /Oldest first/i }));
    await loadedCount(PAGE);

    let rows = renderedRows();
    expectStrictOrder(rows, "asc");
    // Oldest stored row leads once the sort direction flips.
    expect(rows[0]!.id).toBe("q11");

    await user.click(loadMore());
    await loadedCount(PAGE * 2);
    expectStrictOrder(renderedRows(), "asc");

    await user.click(loadMore());
    await loadedCount(PAGE * 3);
    rows = renderedRows();
    expectStrictOrder(rows, "asc");
    expect(rows.length).toBeLessThanOrEqual(TOTAL);
  });
});
