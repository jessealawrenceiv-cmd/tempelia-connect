// @vitest-environment jsdom
/**
 * Integration coverage: live dispatch events arriving over Realtime while the
 * user already has filters and extra pages loaded.
 *
 * The Supabase stub keeps a mutable row store and answers keyset pages exactly
 * like Postgres would (order + lt cursor + limit), so appending an older page
 * is real pagination and not a fixture trick. A captured `postgres_changes`
 * callback lets each test push a brand-new row and assert what the list does:
 *
 * 1. A matching insert is prepended to the top page and the loaded counter
 *    grows by one, while the already-loaded older page stays put.
 * 2. An insert that does not match the active record-type filter is ignored.
 * 3. A duplicate event for a row already on screen never renders twice.
 * 4. Oldest-first sort does not prepend (prepending would break the order);
 *    the row appears after a refetch instead.
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
const BASE = new Date("2026-08-01T12:00:00.000Z").getTime();

function makeRow(i: number, type: string): Row {
  return {
    id: `seed-${i}`,
    action_type: type,
    message_sent: `seed message ${i}`,
    created_at: new Date(BASE - i * 60_000).toISOString(),
    status: "sent",
    customer_id: null,
    recipient_phone: null,
  };
}

/** 12 rows of type A + 6 of type B, interleaved in time. */
let store: Row[] = [];

function seed() {
  store = [
    ...Array.from({ length: 12 }, (_, i) => makeRow(i * 2, TYPE_A)),
    ...Array.from({ length: 6 }, (_, i) => ({
      ...makeRow(i * 2 + 1, TYPE_B),
      id: `seed-b-${i}`,
      message_sent: `seed B message ${i}`,
    })),
  ];
}

/** Minimal PostgREST emulation over `store`. */
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

/** Captured Realtime INSERT handlers for the logs table. */
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

function renderLog(search: Record<string, unknown> = {}) {
  searchState = search;
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <DispatchLog limit={PAGE} />
    </QueryClientProvider>,
  );
}

const loadedCount = (n: number) =>
  waitFor(() => expect(screen.getByText(`${n} loaded`)).toBeTruthy());
const loadMore = () => screen.getByRole("button", { name: /Load \d+ (older|newer)/i });
const chip = (type: string) => screen.getByRole("button", { name: new RegExp(type, "i") });

/** Insert a fresh row into the store and emit the Realtime event for it. */
async function arrive(row: Row) {
  store = [row, ...store];
  await waitFor(() => expect(insertHandlers.length).toBeGreaterThan(0));
  for (const handler of insertHandlers) handler({ new: row });
}

function liveRow(overrides: Partial<Row> = {}): Row {
  return {
    id: "live-1",
    action_type: TYPE_A,
    message_sent: "live dispatch just landed",
    created_at: new Date(BASE + 60_000).toISOString(),
    status: "sent",
    customer_id: null,
    recipient_phone: null,
    ...overrides,
  };
}

beforeEach(() => {
  seed();
  insertHandlers = [];
  searchState = {};
  removeChannel.mockClear();
  window.localStorage.clear();
});

afterEach(() => cleanup());

describe("DispatchLog live updates with filters and pagination active", () => {
  it("prepends a matching new event without dropping already-loaded older pages", async () => {
    const user = userEvent.setup();
    renderLog();

    await loadedCount(PAGE);
    await user.click(loadMore());
    await loadedCount(PAGE * 2);

    const firstBefore = screen.getByText("seed message 0");
    expect(firstBefore).toBeTruthy();

    await arrive(liveRow());

    await waitFor(() => expect(screen.getByText("live dispatch just landed")).toBeTruthy());
    // The older page is still on screen and the counter grew by exactly one.
    await loadedCount(PAGE * 2 + 1);
    expect(screen.getByText("seed message 0")).toBeTruthy();

    // Newest-first still holds: the live row renders above the previous newest.
    const ids = Array.from(document.querySelectorAll<HTMLElement>('[id^="log-row-"]')).map(
      (el) => el.id,
    );
    expect(ids[0]).toBe("log-row-live-1");
    expect(ids.indexOf("log-row-seed-0")).toBe(1);
  });

  it("ignores a new event that does not match the active record-type filter", async () => {
    const user = userEvent.setup();
    renderLog();

    await loadedCount(PAGE);
    await user.click(chip(TYPE_B));
    await waitFor(() => expect(screen.getByText("seed B message 0")).toBeTruthy());
    const loadedBefore = screen.getByText(/\d+ loaded/).textContent;

    // Arrives as TYPE_A while only TYPE_B is selected.
    await arrive(liveRow({ id: "live-off-filter", message_sent: "off-filter dispatch" }));

    await new Promise((r) => setTimeout(r, 60));
    expect(screen.queryByText("off-filter dispatch")).toBeNull();
    expect(screen.getByText(/\d+ loaded/).textContent).toBe(loadedBefore);

    // The matching type still streams in under the same filter.
    await arrive(liveRow({ id: "live-on-filter", action_type: TYPE_B, message_sent: "on-filter dispatch" }));
    await waitFor(() => expect(screen.getByText("on-filter dispatch")).toBeTruthy());
  });

  it("does not duplicate a row when the same event is delivered twice", async () => {
    const user = userEvent.setup();
    renderLog();

    await loadedCount(PAGE);
    await user.click(loadMore());
    await loadedCount(PAGE * 2);

    const row = liveRow({ id: "live-dupe", message_sent: "duplicate delivery" });
    await arrive(row);
    await waitFor(() => expect(screen.getByText("duplicate delivery")).toBeTruthy());

    // Re-deliver the identical event (Realtime can redeliver after a reconnect).
    for (const handler of insertHandlers) handler({ new: row });
    await new Promise((r) => setTimeout(r, 60));

    expect(screen.queryAllByText("duplicate delivery")).toHaveLength(1);
    expect(document.querySelectorAll('[id="log-row-live-dupe"]').length).toBe(1);
    await loadedCount(PAGE * 2 + 1);
  });

  it("leaves oldest-first order intact and shows the new row after a refetch", async () => {
    const user = userEvent.setup();
    renderLog();

    await loadedCount(PAGE);
    await user.click(screen.getByRole("button", { name: /Oldest first/i }));
    await loadedCount(PAGE);

    await arrive(liveRow({ id: "live-asc", message_sent: "ascending arrival" }));
    await new Promise((r) => setTimeout(r, 60));

    // Prepending would corrupt ascending order, so it must not appear at the top.
    const ids = Array.from(document.querySelectorAll<HTMLElement>('[id^="log-row-"]')).map(
      (el) => el.id,
    );
    expect(ids[0]).not.toBe("log-row-live-asc");
    expect(screen.queryByText("ascending arrival")).toBeNull();

    // Flipping back to newest-first refetches and the row is now included.
    await user.click(screen.getByRole("button", { name: /Newest first/i }));
    await waitFor(() => expect(screen.getByText("ascending arrival")).toBeTruthy());
  });
});
