// @vitest-environment jsdom
/**
 * Integration coverage for Realtime *redelivery* in the Activity log.
 *
 * When the Supabase socket drops and reconnects, the server can replay INSERT
 * events the client already saw (and the reconnect also tears down and
 * re-subscribes the channel). None of that may duplicate rows on screen.
 *
 * The stub channel below models a real socket: events pushed while it is
 * "offline" are buffered, and `reconnect()` replays the *entire* buffer —
 * including events already delivered before the drop. Tests assert each
 * dispatch id renders exactly once, ordering stays newest-first, and the
 * "N loaded" counter matches the rendered rows.
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
    ...Array.from({ length: 12 }, (_, i) => ({
      id: `a-${i}`,
      action_type: TYPE_A,
      message_sent: `A dispatch ${i}`,
      created_at: new Date(BASE - i * 120_000).toISOString(),
      status: "sent",
      customer_id: null,
      recipient_phone: null,
    })),
    ...Array.from({ length: 8 }, (_, i) => ({
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

/**
 * Fake Realtime socket. `online` controls whether pushes reach handlers;
 * every push is buffered so a reconnect can replay the whole backlog.
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
  /** Reconnect replays the full backlog, exactly like an at-least-once socket. */
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
    removeChannel: (_ch: unknown) => {
      // A real teardown stops delivery to that channel's handlers.
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

const settle = async () => {
  await new Promise((r) => setTimeout(r, 200));
  await waitFor(() => expect(screen.queryByText(/Loading…/)).toBeNull());
};

function expectNoDuplicates() {
  const ids = rowIds();
  expect(new Set(ids).size).toBe(ids.length);
}

function expectNewestFirst() {
  const times = rowsOnScreen().map((r) => new Date(r.created_at).getTime());
  expect(times).toEqual([...times].sort((a, b) => b - a));
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
  // The row exists in the database as soon as the webhook wrote it, whether or
  // not the socket happens to be connected.
  store = [row, ...store];
  return row;
}

beforeEach(() => {
  seed();
  socket.reset();
  searchState = {};
  liveSeq = 0;
  window.localStorage.clear();
});

afterEach(() => cleanup());

describe("DispatchLog realtime redelivery after disconnect/reconnect", () => {
  it("does not duplicate an event that is redelivered on reconnect", async () => {
    renderLog();
    await waitForLoaded(PAGE);
    await waitFor(() => expect(socket.handlers.length).toBeGreaterThan(0));

    const row = liveRow();
    socket.push(row);
    await waitForLoaded(PAGE + 1);

    // Socket drops and comes back; the server replays the same INSERT.
    socket.drop();
    socket.reconnect();
    socket.reconnect();
    await settle();

    expect(rowIds().filter((id) => id === row.id).length).toBe(1);
    expectNoDuplicates();
    expectNewestFirst();
    expect(loadedCount()).toBe(rowsOnScreen().length);
  }, 30000);

  it("renders each buffered event once when the whole backlog replays after an outage", async () => {
    renderLog();
    await waitForLoaded(PAGE);
    await waitFor(() => expect(socket.handlers.length).toBeGreaterThan(0));

    const delivered = liveRow();
    socket.push(delivered);
    await waitForLoaded(PAGE + 1);

    // Outage: three more webhooks write rows, but nothing reaches the client.
    socket.drop();
    const buffered = [liveRow(TYPE_B), liveRow(TYPE_A), liveRow(TYPE_B)];
    for (const row of buffered) socket.push(row);
    await settle();
    expect(loadedCount()).toBe(PAGE + 1);

    // Reconnect replays everything, including the pre-outage event.
    socket.reconnect();
    await waitForLoaded(PAGE + 4);
    await settle();

    for (const row of [delivered, ...buffered]) {
      expect(rowIds().filter((id) => id === row.id).length).toBe(1);
    }
    expectNoDuplicates();
    expectNewestFirst();
    expect(loadedCount()).toBe(rowsOnScreen().length);
  }, 30000);

  it("does not duplicate rows a refetch already picked up during the outage", async () => {
    const user = userEvent.setup();
    renderLog();
    await waitForLoaded(PAGE);
    await waitFor(() => expect(socket.handlers.length).toBeGreaterThan(0));

    // Rows land in the database while the socket is down.
    socket.drop();
    const missed = [liveRow(), liveRow(TYPE_B)];
    for (const row of missed) socket.push(row);

    // A manual refresh reads them straight from the database.
    const refresh = screen.getByRole("button", { name: /^Refresh$/i });
    await user.click(refresh);
    await settle();
    expect(rowIds()).toContain(missed[0]!.id);

    // Now the socket comes back and replays the same inserts.
    socket.reconnect();
    await settle();

    for (const row of missed) {
      expect(rowIds().filter((id) => id === row.id).length).toBe(1);
    }
    expectNoDuplicates();
    expectNewestFirst();
    expect(loadedCount()).toBe(rowsOnScreen().length);
  }, 30000);

  it("does not duplicate replayed rows across a channel teardown and re-subscribe", async () => {
    const user = userEvent.setup();
    renderLog();
    await waitForLoaded(PAGE);
    await waitFor(() => expect(socket.handlers.length).toBeGreaterThan(0));

    const first = liveRow();
    socket.push(first);
    await waitForLoaded(PAGE + 1);

    // Flipping sort tears the channel down; flipping back re-subscribes it.
    await user.click(screen.getByRole("button", { name: /Oldest first/i }));
    await settle();
    expect(socket.removed).toBeGreaterThan(0);
    await user.click(screen.getByRole("button", { name: /Newest first/i }));
    await settle();
    await waitFor(() => expect(socket.handlers.length).toBeGreaterThan(0));

    // The fresh channel replays the full backlog plus a brand-new event.
    const second = liveRow(TYPE_B);
    socket.push(second);
    socket.reconnect();
    await settle();

    for (const row of [first, second]) {
      expect(rowIds().filter((id) => id === row.id).length).toBeLessThanOrEqual(1);
    }
    expectNoDuplicates();
    expectNewestFirst();
    expect(loadedCount()).toBe(rowsOnScreen().length);
  }, 30000);

  it("does not duplicate a replayed row that pagination already loaded", async () => {
    const user = userEvent.setup();
    renderLog();
    await waitForLoaded(PAGE);
    await waitFor(() => expect(socket.handlers.length).toBeGreaterThan(0));

    // Load an older page, then replay an INSERT for a row already on screen.
    const older = screen.queryByRole("button", { name: /Load \d+ older/i });
    if (older) await user.click(older);
    await settle();

    const existing = rowsOnScreen()[rowsOnScreen().length - 1]!;
    const before = loadedCount();
    socket.push(existing);
    socket.drop();
    socket.reconnect();
    await settle();

    expect(rowIds().filter((id) => id === existing.id).length).toBe(1);
    expect(loadedCount()).toBe(before);
    expectNoDuplicates();
    expectNewestFirst();
  }, 30000);
});
