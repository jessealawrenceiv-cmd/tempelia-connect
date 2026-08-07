// @vitest-environment jsdom
/**
 * Integration coverage: the Activity log developer/debug panel.
 *
 * The panel exists to make reconnect reports diagnosable, so the tests assert
 * the three facts it promises:
 *
 * 1. It is hidden by default and toggled by the Debug control, which persists
 *    the state into the URL (?logDebug=1) so the view is shareable.
 * 2. Subscription state tracks the Realtime lifecycle verbatim — subscribing ->
 *    subscribed -> reconnecting -> error — and counts transitions so a
 *    reconnect loop is visible.
 * 3. The last received event id, its outcome (prepended / duplicate ignored /
 *    filtered out) and the live keyset cursor all reflect reality, including
 *    after loading an extra page.
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

function makeRow(i: number, type = TYPE_A): Row {
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

let store: Row[] = [];
const seed = () => {
  store = Array.from({ length: 14 }, (_, i) => makeRow(i));
};

/** Minimal PostgREST emulation over `store` (order + keyset cursor + limit). */
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
/** subscribe() callbacks, so a test can drive the channel lifecycle itself. */
let statusCallbacks: ((status: string) => void)[] = [];
let channelTopics: string[] = [];
const removeChannel = vi.fn();

vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    from: (table: string) => makeBuilder(table),
    channel: (topic: string) => {
      channelTopics.push(topic);
      const ch: Record<string, unknown> = {
        on: (_event: string, _cfg: unknown, cb: (payload: { new: Row }) => void) => {
          insertHandlers.push(cb);
          return ch;
        },
        subscribe: (cb?: (status: string) => void) => {
          if (cb) statusCallbacks.push(cb);
          return ch;
        },
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
const debugToggle = () => screen.getByTestId("log-debug-toggle");
const panel = () => screen.getByTestId("dispatch-log-debug");
const statusEl = () => screen.getByTestId("debug-realtime-status");

async function setStatus(status: string) {
  await waitFor(() => expect(statusCallbacks.length).toBeGreaterThan(0));
  for (const cb of statusCallbacks) cb(status);
}

async function arrive(row: Row, { addToStore = true } = {}) {
  if (addToStore) store = [row, ...store];
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
  statusCallbacks = [];
  channelTopics = [];
  searchState = {};
  removeChannel.mockClear();
  window.localStorage.clear();
});

afterEach(() => cleanup());

describe("DispatchLog debug panel visibility", () => {
  it("is hidden until the Debug control is used", async () => {
    const user = userEvent.setup();
    renderLog();
    await loadedCount(PAGE);

    expect(screen.queryByTestId("dispatch-log-debug")).toBeNull();
    expect(debugToggle().getAttribute("aria-pressed")).toBe("false");

    await user.click(debugToggle());

    await waitFor(() => expect(panel()).toBeTruthy());
    expect(debugToggle().getAttribute("aria-pressed")).toBe("true");
    // Shareable: the open state lives in the URL, not in component-local state.
    expect(searchState["logDebug"]).toBe("1");
  });

  it("opens straight from ?logDebug=1 and closes back out of the URL", async () => {
    const user = userEvent.setup();
    renderLog({ logDebug: "1" });
    await loadedCount(PAGE);

    expect(panel()).toBeTruthy();
    await user.click(debugToggle());

    await waitFor(() => expect(screen.queryByTestId("dispatch-log-debug")).toBeNull());
    expect(searchState["logDebug"]).toBeUndefined();
  });
});

describe("DispatchLog debug panel subscription state", () => {
  it("reports the channel topic and the live subscribe() lifecycle", async () => {
    renderLog({ logDebug: "1" });
    await loadedCount(PAGE);

    // Before any status callback fires the panel says the attempt is in flight.
    expect(statusEl().getAttribute("data-status")).toBe("subscribing");
    expect(panel().textContent).toContain(channelTopics[0]!);

    await setStatus("SUBSCRIBED");
    await waitFor(() => expect(statusEl().getAttribute("data-status")).toBe("subscribed"));
    expect(statusEl().textContent).toContain("Subscribed");
    expect(panel().textContent).toContain("SUBSCRIBED");
  });

  it("surfaces a timeout as reconnecting and a channel error as an error", async () => {
    renderLog({ logDebug: "1" });
    await loadedCount(PAGE);

    await setStatus("SUBSCRIBED");
    await setStatus("TIMED_OUT");
    await waitFor(() => expect(statusEl().getAttribute("data-status")).toBe("reconnecting"));

    await setStatus("CHANNEL_ERROR");
    await waitFor(() => expect(statusEl().getAttribute("data-status")).toBe("error"));
    expect(panel().textContent).toContain("CHANNEL_ERROR");
  });

  it("counts lifecycle transitions so a reconnect loop is visible", async () => {
    renderLog({ logDebug: "1" });
    await loadedCount(PAGE);

    const transitions = () => Number(screen.getByTestId("debug-realtime-transitions").textContent);
    const start = transitions();

    await setStatus("SUBSCRIBED");
    await setStatus("SUBSCRIBED"); // repeated identical status is not a transition
    await waitFor(() => expect(transitions()).toBe(start + 1));

    await setStatus("CLOSED");
    await setStatus("SUBSCRIBED");
    await waitFor(() => expect(transitions()).toBe(start + 3));
  });
});

describe("DispatchLog debug panel last event and cursor", () => {
  it("records the last received event id and that it was prepended", async () => {
    renderLog({ logDebug: "1" });
    await loadedCount(PAGE);

    expect(screen.getByTestId("debug-last-event-id").textContent).toBe("—");

    await arrive(liveRow());

    await waitFor(() =>
      expect(screen.getByTestId("debug-last-event-id").textContent).toBe("live-1"),
    );
    await waitFor(() => expect(panel().textContent).toContain("prepended"));
    expect(screen.getByTestId("debug-events-seen").textContent).toBe("1/1 applied");
  });

  it("labels a redelivered event as a duplicate instead of counting it as applied", async () => {
    renderLog({ logDebug: "1" });
    await loadedCount(PAGE);

    await arrive(liveRow());
    await waitFor(() => expect(panel().textContent).toContain("prepended"));

    // Same payload again, as a reconnect backlog would replay it.
    await arrive(liveRow(), { addToStore: false });

    await waitFor(() => expect(panel().textContent).toContain("duplicate ignored"));
    expect(screen.getByTestId("debug-events-seen").textContent).toBe("1/2 applied");
  });

  it("labels an event that fails the active filter as filtered out", async () => {
    renderLog({ logDebug: "1", logTypes: TYPE_A });
    await loadedCount(PAGE);

    await arrive(liveRow({ id: "live-b", action_type: TYPE_B, message_sent: "other type" }));

    await waitFor(() => expect(screen.getByTestId("debug-last-event-id").textContent).toBe("live-b"));
    await waitFor(() => expect(panel().textContent).toContain("filtered out"));
    expect(screen.getByTestId("debug-events-seen").textContent).toBe("0/1 applied");
  });

  it("shows the keyset cursor that the next page request will use", async () => {
    const user = userEvent.setup();
    renderLog({ logDebug: "1" });
    await loadedCount(PAGE);

    // After the first page the cursor is the created_at of the last loaded row.
    const firstCursor = makeRow(PAGE - 1).created_at;
    await waitFor(() =>
      expect(screen.getByTestId("debug-next-cursor").textContent).toBe(firstCursor),
    );
    expect(panel().textContent).toContain(`1 × ${PAGE}`);

    await user.click(loadMore());
    await loadedCount(PAGE * 2);

    const secondCursor = makeRow(PAGE * 2 - 1).created_at;
    await waitFor(() =>
      expect(screen.getByTestId("debug-next-cursor").textContent).toBe(secondCursor),
    );
    expect(panel().textContent).toContain(`2 × ${PAGE}`);
    // Consumed cursors are listed in order, starting from the initial null page.
    expect(panel().textContent).toContain(firstCursor);
  });

  it("reports the end of the result set once the last page is short", async () => {
    const user = userEvent.setup();
    renderLog({ logDebug: "1" });
    await loadedCount(PAGE);

    await user.click(loadMore());
    await loadedCount(PAGE * 2);
    await user.click(loadMore());
    await loadedCount(14);

    await waitFor(() =>
      expect(screen.getByTestId("debug-next-cursor").textContent).toBe("end of results"),
    );
  });
});
