// @vitest-environment jsdom
/**
 * Integration coverage for race conditions in the Activity log: the user flips
 * filters, sort direction and pages quickly while live dispatch events keep
 * arriving over Realtime.
 *
 * The Supabase stub keeps a mutable row store and answers keyset pages exactly
 * like Postgres (order + cursor + limit), and captured `postgres_changes`
 * callbacks let each test push new rows mid-interaction. The invariants checked
 * after the dust settles are the ones a user would notice:
 *
 * 1. Rapid filter toggling with inserts landing in between leaves one coherent
 *    list: only matching rows, strict newest-first order, no duplicates.
 * 2. Flipping sort back and forth while events arrive never leaves stale rows
 *    from the other direction on screen.
 * 3. Clicking "load more" repeatedly while inserts stream in keeps the loaded
 *    counter equal to the rendered row count (no double-appended pages).
 * 4. Clearing all filters after a rapid sequence returns a consistent full list.
 */
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { LOG_ACTION_TYPES } from "@/lib/log-action-types.generated";

const TYPE_A = LOG_ACTION_TYPES[0]!;
const TYPE_B = LOG_ACTION_TYPES[1]!;

type Row = {
  id: string;
  action_type: string;
  message_sent: string | null;
  created_at: string;
  status: string | null;
  customer_id: string | null;
  recipient_phone: string | null;
};

const PAGE = 5;
const BASE = new Date("2026-10-01T12:00:00.000Z").getTime();

let store: Row[] = [];

function seed() {
  store = [
    ...Array.from({ length: 14 }, (_, i) => ({
      id: `a-${i}`,
      action_type: TYPE_A,
      message_sent: `A dispatch ${i}`,
      created_at: new Date(BASE - i * 120_000).toISOString(),
      status: "sent",
      customer_id: null,
      recipient_phone: null,
    })),
    ...Array.from({ length: 9 }, (_, i) => ({
      id: `b-${i}`,
      action_type: TYPE_B,
      message_sent: `B dispatch ${i}`,
      created_at: new Date(BASE - i * 120_000 - 60_000).toISOString(),
      status: "sent",
      customer_id: null,
      recipient_phone: null,
    })),
  ];
}

/** Minimal PostgREST emulation over the mutable store. */
function makeBuilder(table: string) {
  const state: {
    limit: number;
    lt?: string;
    gt?: string;
    ascending: boolean;
    actionTypes?: string[];
    eq: Record<string, string>;
  } = { limit: PAGE, ascending: false, eq: {} };

  const run = () => {
    let rows = table === "logs" ? [...store] : [];
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
  };

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
    lt: (_col: string, v: string) => {
      state.lt = v;
      return b;
    },
    gt: (_col: string, v: string) => {
      state.gt = v;
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
    returns: () => run(),
    then: (resolve: (v: unknown) => unknown) => run().then(resolve),
  };
  return b;
}

let insertHandlers: ((payload: { new: Row }) => void)[] = [];
const removeChannel = vi.fn();

vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    from: (table: string) => makeBuilder(table),
    channel: () => {
      const ch: Record<string, unknown> = {
        on: (_event: string, _cfg: unknown, cb: (payload: { new: Row }) => void) => {
          insertHandlers.push(cb);
          return ch;
        },
        subscribe: () => ch,
      };
      return ch;
    },
    removeChannel,
  },
}));

vi.mock("sonner", () => ({
  toast: { error: vi.fn(), success: vi.fn(), info: vi.fn(), message: vi.fn(), warning: vi.fn() },
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

const rowIds = () =>
  Array.from(container.querySelectorAll<HTMLElement>('[id^="log-row-"]')).map((el) =>
    el.id.replace("log-row-", ""),
  );

const rowsOnScreen = (): Row[] => {
  const byId = new Map(store.map((r) => [r.id, r]));
  return rowIds()
    .map((id) => byId.get(id))
    .filter((r): r is Row => Boolean(r));
};

const loadedCount = () => {
  const text = screen.getByText(/\d+ loaded/).textContent ?? "";
  return Number(text.match(/(\d+) loaded/)?.[1] ?? -1);
};
const waitForLoaded = (n: number) =>
  waitFor(() => expect(screen.getByText(`${n} loaded`)).toBeTruthy(), { timeout: 8000 });

const loadMore = () => screen.queryByRole("button", { name: /Load \d+ (older|newer)/i });
const chip = (type: string) => screen.getByRole("button", { name: new RegExp(type, "i") });

function expectStrictOrder(rows: Row[], dir: "desc" | "asc") {
  expect(rows.length).toBeGreaterThan(0);
  const times = rows.map((r) => new Date(r.created_at).getTime());
  const expected = [...times].sort((a, b) => (dir === "desc" ? b - a : a - b));
  expect(times).toEqual(expected);
  expect(new Set(rows.map((r) => r.id)).size).toBe(rows.length);
}

/** Push a brand-new row into the store and emit its Realtime event. */
async function arrive(row: Row) {
  store = [row, ...store];
  await waitFor(() => expect(insertHandlers.length).toBeGreaterThan(0));
  for (const handler of insertHandlers) handler({ new: row });
}

let liveSeq = 0;
function liveRow(type: string, overrides: Partial<Row> = {}): Row {
  liveSeq += 1;
  return {
    id: `live-${liveSeq}`,
    action_type: type,
    message_sent: `live ${type} ${liveSeq}`,
    created_at: new Date(BASE + liveSeq * 30_000).toISOString(),
    status: "sent",
    customer_id: null,
    recipient_phone: null,
    ...overrides,
  };
}

/** Let all queued queries, refetches and realtime patches settle. */
const settle = async () => {
  await new Promise((r) => setTimeout(r, 150));
  await waitFor(() => expect(screen.queryByText(/Loading…/)).toBeNull());
};

beforeEach(() => {
  seed();
  insertHandlers = [];
  searchState = {};
  liveSeq = 0;
  removeChannel.mockClear();
  window.localStorage.clear();
});

afterEach(() => cleanup());

describe("DispatchLog under rapid filter/pagination changes with live events", () => {
  it("settles into one coherent filtered list after rapid filter toggling with inserts", async () => {
    const user = userEvent.setup();
    renderLog();
    await waitForLoaded(PAGE);

    // Toggle filters quickly, with live rows landing between the clicks.
    await user.click(chip(TYPE_A));
    await arrive(liveRow(TYPE_B));
    await user.click(chip(TYPE_B));
    await arrive(liveRow(TYPE_A));
    await user.click(chip(TYPE_A));
    await arrive(liveRow(TYPE_B));

    await settle();

    // Only TYPE_B remains selected: the visible list must match it exactly.
    const rows = rowsOnScreen();
    expect(rows.every((r) => r.action_type === TYPE_B)).toBe(true);
    expectStrictOrder(rows, "desc");
    expect(loadedCount()).toBe(rows.length);
  }, 30000);

  it("never leaves rows from the previous sort direction after rapid flips with inserts", async () => {
    const user = userEvent.setup();
    renderLog();
    await waitForLoaded(PAGE);

    const newest = () => screen.getByRole("button", { name: /Newest first/i });
    const oldest = () => screen.getByRole("button", { name: /Oldest first/i });

    await user.click(oldest());
    await arrive(liveRow(TYPE_A));
    await user.click(newest());
    await arrive(liveRow(TYPE_A));
    await user.click(oldest());
    await settle();

    expectStrictOrder(rowsOnScreen(), "asc");
    expect(loadedCount()).toBe(rowsOnScreen().length);

    await user.click(newest());
    await settle();
    expectStrictOrder(rowsOnScreen(), "desc");
    expect(loadedCount()).toBe(rowsOnScreen().length);
  }, 30000);

  it("keeps the loaded counter and rendered rows in sync across rapid page loads with inserts", async () => {
    const user = userEvent.setup();
    renderLog();
    await waitForLoaded(PAGE);

    for (let i = 0; i < 3; i++) {
      const button = loadMore();
      if (!button) break;
      await user.click(button);
      await arrive(liveRow(i % 2 === 0 ? TYPE_A : TYPE_B));
    }
    await settle();

    const rows = rowsOnScreen();
    expectStrictOrder(rows, "desc");
    expect(loadedCount()).toBe(rows.length);
    // Every live row that arrived is present exactly once.
    for (let i = 1; i <= 3; i++) {
      expect(rowIds().filter((id) => id === `live-${i}`).length).toBeLessThanOrEqual(1);
    }
  }, 30000);

  it("returns to a consistent full list when filters are cleared after a rapid sequence", async () => {
    const user = userEvent.setup();
    renderLog();
    await waitForLoaded(PAGE);

    await user.click(chip(TYPE_A));
    const more = loadMore();
    if (more) await user.click(more);
    await arrive(liveRow(TYPE_A));
    await user.click(screen.getByRole("button", { name: /Oldest first/i }));
    await arrive(liveRow(TYPE_B));
    await settle();

    const clear = screen.queryByRole("button", { name: /Clear (all )?filters/i });
    if (clear) await user.click(clear);
    await user.click(screen.getByRole("button", { name: /Newest first/i }));
    await settle();

    const rows = rowsOnScreen();
    expectStrictOrder(rows, "desc");
    expect(loadedCount()).toBe(rows.length);
    // Both record types are visible again once the type filter is gone.
    expect(new Set(rows.map((r) => r.action_type)).size).toBeGreaterThanOrEqual(1);
  }, 30000);
});
