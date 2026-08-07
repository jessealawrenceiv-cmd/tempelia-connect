// @vitest-environment jsdom
/**
 * Integration coverage for the Activity log under a very large loaded row count.
 *
 * Once many keyset pages are appended the list switches to a windowed renderer,
 * so these tests make sure that switch does not corrupt anything the user sees:
 *
 * 1. Loading page after page keeps the loaded counter exact, never duplicates a
 *    row, and keeps every rendered row in strict newest-first order — including
 *    after the virtualization threshold is crossed.
 * 2. Applying a filter on top of a large loaded list restarts pagination cleanly
 *    and the remaining rows stay strictly ordered.
 * 3. Flipping to oldest-first on a large list re-sorts the whole list ascending.
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

/** Big enough that the list crosses the windowing threshold after a few pages. */
const PAGE = 25;
const TOTAL_A = 400;
const TOTAL_B = 100;
const BASE = new Date("2026-09-01T12:00:00.000Z").getTime();

/** Rows are stored scrambled — ordering must come from the query, not the fixture. */
const STORED_ROWS: Row[] = (() => {
  const rows: Row[] = [];
  for (let i = 0; i < TOTAL_A; i++) {
    rows.push({
      id: `a-${i}`,
      action_type: TYPE_A,
      message_sent: `type A dispatch ${i}`,
      created_at: new Date(BASE - i * 60_000).toISOString(),
      status: "sent",
      customer_id: null,
      recipient_phone: null,
    });
  }
  for (let i = 0; i < TOTAL_B; i++) {
    rows.push({
      id: `b-${i}`,
      action_type: TYPE_B,
      message_sent: `type B dispatch ${i}`,
      created_at: new Date(BASE - i * 60_000 - 30_000).toISOString(),
      status: "sent",
      customer_id: null,
      recipient_phone: null,
    });
  }
  // Deterministic shuffle.
  let seed = 42;
  for (let i = rows.length - 1; i > 0; i--) {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    const j = seed % (i + 1);
    [rows[i]!, rows[j]!] = [rows[j]!, rows[i]!];
  }
  return rows;
})();

const TOTAL = STORED_ROWS.length;
const byId = new Map(STORED_ROWS.map((r) => [r.id, r]));

/** Minimal PostgREST emulation: order + keyset cursor + limit. */
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

vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    from: (table: string) => makeBuilder(table),
    channel: () => {
      const ch: Record<string, unknown> = { on: () => ch, subscribe: () => ch };
      return ch;
    },
    removeChannel: vi.fn(),
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

/** Rendered dispatch rows, top to bottom (windowed lists render a slice). */
function renderedRows(): Row[] {
  return Array.from(container.querySelectorAll<HTMLElement>('[id^="log-row-"]'))
    .map((el) => byId.get(el.id.replace("log-row-", "")))
    .filter((r): r is Row => Boolean(r));
}

const loadedCount = (n: number) =>
  waitFor(() => expect(screen.getByText(`${n} loaded`)).toBeTruthy(), { timeout: 8000 });

const loadMore = () => screen.getByRole("button", { name: /Load \d+ (older|newer)/i });

function expectStrictOrder(rows: Row[], dir: "desc" | "asc") {
  expect(rows.length).toBeGreaterThan(0);
  const times = rows.map((r) => new Date(r.created_at).getTime());
  const expected = [...times].sort((a, b) => (dir === "desc" ? b - a : a - b));
  expect(times).toEqual(expected);
  expect(new Set(rows.map((r) => r.id)).size).toBe(rows.length);
}

/** Click "load more" until `pages` total pages are loaded. */
async function loadPages(user: ReturnType<typeof userEvent.setup>, pages: number) {
  for (let p = 2; p <= pages; p++) {
    await user.click(loadMore());
    await loadedCount(PAGE * p);
  }
}

beforeEach(() => {
  searchState = {};
  window.localStorage.clear();
});

afterEach(() => cleanup());

describe("DispatchLog with a very large number of loaded rows", () => {
  it("stays exact and newest-first while many pages are appended", async () => {
    const user = userEvent.setup();
    renderLog();

    await loadedCount(PAGE);
    expectStrictOrder(renderedRows(), "desc");

    // Cross the windowing threshold (60 rows) and keep going well past it.
    await loadPages(user, 8);
    expect(PAGE * 8).toBeGreaterThan(60);

    const rows = renderedRows();
    expectStrictOrder(rows, "desc");
    // Every rendered row belongs to the correct prefix of the global ordering.
    const globalDesc = [...STORED_ROWS].sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
    const prefix = new Set(globalDesc.slice(0, PAGE * 8).map((r) => r.id));
    expect(rows.every((r) => prefix.has(r.id))).toBe(true);
    expect(rows[0]!.id).toBe(globalDesc[0]!.id);
  }, 30000);

  it("keeps a filtered large list strictly ordered after pagination restarts", async () => {
    const user = userEvent.setup();
    renderLog();

    await loadedCount(PAGE);
    await loadPages(user, 6);

    await user.click(screen.getByRole("button", { name: new RegExp(TYPE_B, "i") }));
    await loadedCount(PAGE);
    expectStrictOrder(renderedRows(), "desc");

    await loadPages(user, 4);
    const rows = renderedRows();
    expect(rows.every((r) => r.action_type === TYPE_B)).toBe(true);
    expectStrictOrder(rows, "desc");
    expect(rows.length).toBeLessThanOrEqual(TOTAL);
  }, 30000);

  it("re-sorts the whole large list when flipping to oldest-first", async () => {
    const user = userEvent.setup();
    renderLog();

    await loadedCount(PAGE);
    await loadPages(user, 5);

    await user.click(screen.getByRole("button", { name: /Oldest first/i }));
    await loadedCount(PAGE);
    expectStrictOrder(renderedRows(), "asc");

    await loadPages(user, 4);
    const rows = renderedRows();
    expectStrictOrder(rows, "asc");
    const globalAsc = [...STORED_ROWS].sort((a, b) => (a.created_at < b.created_at ? -1 : 1));
    expect(rows[0]!.id).toBe(globalAsc[0]!.id);
  }, 30000);
});
