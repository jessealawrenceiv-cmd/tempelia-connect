// @vitest-environment jsdom
/**
 * Stress coverage: an extremely large Activity log dataset (50k+ rows in the
 * database, thousands loaded on screen through the windowed renderer) combined
 * with repeated Realtime disconnect/reconnect cycles that replay their whole
 * backlog.
 *
 * The point is the interaction of the two pressures: virtualization only mounts
 * a slice of the list, so a de-dupe bug can hide behind the window. These tests
 * therefore assert on both the rendered slice and the authoritative "N loaded"
 * counter after every cycle.
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

/** Big page size so a handful of clicks puts thousands of rows in the list. */
const PAGE = 500;
/** Rows in the "database" — well past any realistic single-tenant volume. */
const TOTAL = 50_000;
const BASE = new Date("2026-11-01T12:00:00.000Z").getTime();

let store: Row[] = [];
/** Sorted newest-first mirror, used for cheap keyset slicing. */
let sortedDesc: Row[] = [];
let byId = new Map<string, Row>();

function seed() {
  store = new Array(TOTAL);
  for (let i = 0; i < TOTAL; i += 1) {
    store[i] = {
      id: `seed-${i}`,
      action_type: i % 2 === 0 ? TYPE_A : TYPE_B,
      message_sent: `stress dispatch ${i}`,
      // Unique, strictly decreasing timestamps: no keyset ties to reason about.
      created_at: new Date(BASE - i * 1_000).toISOString(),
      status: "sent",
      customer_id: null,
      recipient_phone: null,
    };
  }
  reindex();
}

function reindex() {
  sortedDesc = [...store].sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
  byId = new Map(store.map((r) => [r.id, r]));
}

/**
 * Minimal PostgREST emulation over the mutable store. Filtering runs against
 * the pre-sorted mirror so 50k rows stay fast enough for many paged reads.
 */
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
    if (table !== "logs") return Promise.resolve({ data: [], error: null });
    const source = state.ascending ? [...sortedDesc].reverse() : sortedDesc;
    const out: Row[] = [];
    for (const r of source) {
      if (state.lt && !(r.created_at < state.lt)) continue;
      if (state.gt && !(r.created_at > state.gt)) continue;
      if (state.actionTypes && !state.actionTypes.includes(r.action_type)) continue;
      let ok = true;
      for (const [col, value] of Object.entries(state.eq)) {
        if (String((r as unknown as Record<string, unknown>)[col] ?? "") !== value) {
          ok = false;
          break;
        }
      }
      if (!ok) continue;
      out.push(r);
      if (out.length >= state.limit) break;
    }
    return Promise.resolve({ data: out, error: null });
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

/**
 * Fake Realtime socket: pushes only reach handlers while online, and every
 * push is buffered so a reconnect replays the full at-least-once backlog.
 */
const socket = {
  handlers: [] as ((payload: { new: Row }) => void)[],
  buffer: [] as Row[],
  online: true,
  channels: 0,
  removed: 0,
  push(row: Row) {
    this.buffer.push(row);
    if (this.online) this.deliver([row]);
  },
  deliver(rows: Row[]) {
    for (const row of rows) for (const handler of [...this.handlers]) handler({ new: row });
  },
  drop() {
    this.online = false;
  },
  reconnect() {
    this.online = true;
    this.deliver([...this.buffer]);
  },
  reset() {
    this.handlers = [];
    this.buffer = [];
    this.online = true;
    this.channels = 0;
    this.removed = 0;
  },
};

vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    from: (table: string) => makeBuilder(table),
    channel: () => {
      socket.channels += 1;
      const ch: Record<string, unknown> = {
        on: (_event: string, _cfg: unknown, cb: (payload: { new: Row }) => void) => {
          socket.handlers.push(cb);
          return ch;
        },
        subscribe: () => ch,
      };
      return ch;
    },
    removeChannel: () => {
      socket.removed += 1;
      socket.handlers = [];
      return Promise.resolve("ok");
    },
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

const rowsOnScreen = (): Row[] =>
  rowIds()
    .map((id) => byId.get(id))
    .filter((r): r is Row => Boolean(r));

const loadedCount = () => {
  const text = screen.getByText(/\d+ loaded/).textContent ?? "";
  return Number(text.match(/(\d+) loaded/)?.[1] ?? -1);
};

const waitForLoaded = (n: number) =>
  waitFor(() => expect(screen.getByText(`${n} loaded`)).toBeTruthy(), { timeout: 20000 });

const settle = async () => {
  await new Promise((r) => setTimeout(r, 200));
  await waitFor(() => expect(screen.queryByText(/Loading…/)).toBeNull(), { timeout: 20000 });
};

/**
 * Rows only need to appear at most once: the window mounts a slice, so an older
 * live row can legitimately scroll out of the rendered set. Two copies of the
 * same id never can.
 */
function expectAtMostOnce(rows: Row[]) {
  for (const row of rows) {
    expect(rowIds().filter((id) => id === row.id).length).toBeLessThanOrEqual(1);
  }
}

function expectNoDuplicates() {
  const ids = rowIds();
  expect(new Set(ids).size).toBe(ids.length);
}

function expectNewestFirst() {
  const times = rowsOnScreen().map((r) => new Date(r.created_at).getTime());
  expect(times).toEqual([...times].sort((a, b) => b - a));
}

/** The windowed renderer mounts a slice, never the whole loaded list. */
function expectVirtualized(loaded: number) {
  expect(loaded).toBeGreaterThan(60);
  expect(rowIds().length).toBeLessThan(loaded);
  expect(rowIds().length).toBeGreaterThan(0);
}

let liveSeq = 0;
function liveRow(type: string = TYPE_A): Row {
  liveSeq += 1;
  const row: Row = {
    id: `live-${liveSeq}`,
    action_type: type,
    message_sent: `live ${type} ${liveSeq}`,
    created_at: new Date(BASE + liveSeq * 30_000).toISOString(),
    status: "sent",
    customer_id: null,
    recipient_phone: null,
  };
  // The webhook wrote the row whether or not the socket is connected.
  store.push(row);
  reindex();
  return row;
}

const loadMoreOlder = () => screen.queryByRole("button", { name: /Load \d+ older/i });

/** Click "load more" until `pages` keyset pages are loaded. */
async function loadPages(user: ReturnType<typeof userEvent.setup>, pages: number) {
  for (let p = 2; p <= pages; p += 1) {
    const btn = loadMoreOlder();
    if (!btn) break;
    await user.click(btn);
    await waitForLoaded(PAGE * p);
  }
}

/**
 * jsdom reports every element as 0x0, which would make the windowed renderer
 * mount nothing. Give elements a real viewport so rows actually render.
 */
function stubLayout() {
  for (const prop of ["clientHeight", "offsetHeight"]) {
    Object.defineProperty(HTMLElement.prototype, prop, { configurable: true, get: () => 600 });
  }
  Object.defineProperty(HTMLElement.prototype, "clientWidth", {
    configurable: true,
    get: () => 800,
  });
  HTMLElement.prototype.getBoundingClientRect = function () {
    return {
      width: 800,
      height: 600,
      top: 0,
      left: 0,
      bottom: 600,
      right: 800,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    } as DOMRect;
  };
  if (!("ResizeObserver" in window)) {
    (window as unknown as Record<string, unknown>)["ResizeObserver"] = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    };
  }
}

beforeEach(() => {
  seed();
  socket.reset();
  searchState = {};
  liveSeq = 0;
  window.localStorage.clear();
  stubLayout();
});

afterEach(() => cleanup());

describe("DispatchLog stress: 50k-row dataset under virtualization + reconnect cycles", () => {
  it("never duplicates rows across repeated outage/replay cycles on a huge loaded list", async () => {
    const user = userEvent.setup();
    renderLog();

    await waitForLoaded(PAGE);
    await waitFor(() => expect(socket.handlers.length).toBeGreaterThan(0));

    // Load thousands of rows so the list is deep inside the windowed renderer.
    await loadPages(user, 6);
    let expectedLoaded = PAGE * 6;
    await waitForLoaded(expectedLoaded);
    expectVirtualized(expectedLoaded);
    expectNewestFirst();
    expectNoDuplicates();

    const seen: Row[] = [];
    for (let cycle = 0; cycle < 6; cycle += 1) {
      // A burst lands while online.
      const online = liveRow(cycle % 2 === 0 ? TYPE_A : TYPE_B);
      socket.push(online);
      seen.push(online);

      // Outage: rows keep landing in the database, nothing reaches the client.
      socket.drop();
      const buffered = [liveRow(TYPE_A), liveRow(TYPE_B), liveRow(TYPE_A)];
      for (const row of buffered) socket.push(row);
      seen.push(...buffered);

      // Reconnect replays the entire backlog, including earlier cycles.
      socket.reconnect();
      expectedLoaded += 1 + buffered.length;
      await waitForLoaded(expectedLoaded);
      await settle();

      // Every live row exists exactly once in the rendered window…
      expectAtMostOnce(seen);
      // The newest live row is always inside the top of the window.
      expect(rowIds()).toContain(seen[seen.length - 1]!.id);
      // …and the loaded counter never inflates from replayed inserts.
      expect(loadedCount()).toBe(expectedLoaded);
      expectNoDuplicates();
      expectNewestFirst();
      expectVirtualized(expectedLoaded);
    }

    expect(seen.length).toBe(24);
  }, 180000);

  it("stays deduped when reconnect replays interleave with paging deeper into 50k rows", async () => {
    const user = userEvent.setup();
    renderLog();

    await waitForLoaded(PAGE);
    await waitFor(() => expect(socket.handlers.length).toBeGreaterThan(0));
    await loadPages(user, 3);

    let expectedLoaded = PAGE * 3;
    const seen: Row[] = [];

    for (let cycle = 0; cycle < 4; cycle += 1) {
      socket.drop();
      const missed = liveRow(cycle % 2 === 0 ? TYPE_B : TYPE_A);
      socket.push(missed);
      seen.push(missed);

      socket.reconnect();
      expectedLoaded += 1;
      await waitForLoaded(expectedLoaded);
      await settle();

      // Page deeper while the backlog is still replayable.
      const older = loadMoreOlder();
      if (older) {
        await user.click(older);
        expectedLoaded += PAGE;
        await waitForLoaded(expectedLoaded);
      }
      await settle();

      // Replay the whole backlog once more after the new page landed.
      socket.reconnect();
      await settle();

      expectAtMostOnce(seen);
      expect(rowIds()).toContain(seen[seen.length - 1]!.id);
      expect(loadedCount()).toBe(expectedLoaded);
      expectNoDuplicates();
      expectNewestFirst();
      expectVirtualized(expectedLoaded);
    }
  }, 180000);

  it("keeps a filtered huge list deduped across reconnect replays", async () => {
    const user = userEvent.setup();
    renderLog();

    await waitForLoaded(PAGE);
    await waitFor(() => expect(socket.handlers.length).toBeGreaterThan(0));
    await loadPages(user, 4);
    await waitForLoaded(PAGE * 4);

    // Narrow to one action type: pagination restarts against 25k matching rows.
    await user.click(screen.getByRole("button", { name: new RegExp(TYPE_B, "i") }));
    await waitForLoaded(PAGE);
    await loadPages(user, 3);

    let expectedLoaded = PAGE * 3;
    const matching: Row[] = [];

    for (let cycle = 0; cycle < 4; cycle += 1) {
      socket.drop();
      // One row that passes the filter, one that must be ignored by it.
      const kept = liveRow(TYPE_B);
      const dropped = liveRow(TYPE_A);
      socket.push(kept);
      socket.push(dropped);
      matching.push(kept);

      socket.reconnect();
      expectedLoaded += 1;
      await waitForLoaded(expectedLoaded);
      await settle();

      expectAtMostOnce(matching);
      expect(rowIds()).toContain(matching[matching.length - 1]!.id);
      expect(rowIds()).not.toContain(dropped.id);
      expect(rowsOnScreen().every((r) => r.action_type === TYPE_B)).toBe(true);
      expect(loadedCount()).toBe(expectedLoaded);
      expectNoDuplicates();
      expectNewestFirst();
      expectVirtualized(expectedLoaded);
    }
  }, 180000);
});
