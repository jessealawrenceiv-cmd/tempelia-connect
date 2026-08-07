// @vitest-environment jsdom
/**
 * Race-condition coverage: flipping quick filters faster than the network can
 * answer must never leave rows from an earlier request on screen.
 *
 * Each filter combination resolves its own row set with a controllable delay,
 * so an earlier slow response lands *after* a later fast one. The list must
 * always show the rows for the currently selected filters and nothing else.
 */
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { LOG_ACTION_TYPES } from "@/lib/log-action-types.generated";
import { LogAction } from "@/lib/log-action-types";

const TYPE_A = LOG_ACTION_TYPES[0]!;
const TYPE_B = LOG_ACTION_TYPES[1]!;
const STATUS_REFRESH = LogAction.status_refresh as string;

const MSG = {
  all: "row for unfiltered view",
  a: "row for type A",
  b: "row for type B",
  statusRefresh: "row for status refresh only",
} as const;

/** ms to hold each response before resolving; keyed by the filter signature. */
let delays: Record<string, number> = {};
/** Every filter signature the component asked for, in request order. */
let requested: string[] = [];

function rowFor(message: string, actionType: string) {
  return {
    id: `row-${message}`,
    action_type: actionType,
    message_sent: message,
    created_at: new Date("2026-06-01T12:00:00.000Z").toISOString(),
    status: "sent",
    customer_id: null,
    recipient_phone: null,
  };
}

/**
 * Minimal PostgREST emulation. It records which action_type filters a request
 * carried, then answers with that combination's fixture after its delay.
 */
function makeBuilder(table: string) {
  const isLogs = table === "logs" || table === "logs_archive";
  const types: string[] = [];
  let eqStatusRefresh = false;

  const signature = () => {
    if (eqStatusRefresh) return "status_refresh";
    if (types.length === 0) return "all";
    return [...types].sort().join("+");
  };

  const payload = () => {
    const sig = signature();
    if (!isLogs) return [];
    if (sig === "status_refresh") return [rowFor(MSG.statusRefresh, STATUS_REFRESH)];
    if (sig === TYPE_A) return [rowFor(MSG.a, TYPE_A)];
    if (sig === TYPE_B) return [rowFor(MSG.b, TYPE_B)];
    if (sig === [TYPE_A, TYPE_B].sort().join("+")) {
      return [rowFor(MSG.a, TYPE_A), rowFor(MSG.b, TYPE_B)];
    }
    if (sig === "all") return [rowFor(MSG.all, TYPE_A)];
    return [];
  };

  const settle = () => {
    const sig = signature();
    if (isLogs) requested.push(sig);
    const wait = isLogs ? (delays[sig] ?? 0) : 0;
    const value = { data: payload(), error: null };
    if (wait === 0) return Promise.resolve(value);
    return new Promise((resolve) => setTimeout(() => resolve(value), wait));
  };

  const b: Record<string, unknown> = {
    select: () => b,
    order: () => b,
    limit: () => b,
    returns: () => settle(),
    then: (resolve: (v: unknown) => unknown) => settle().then(resolve),
  };
  for (const fn of ["gte", "lte", "lt", "gt", "or"]) b[fn] = () => b;
  b["in"] = (_col: string, values: string[]) => {
    if (Array.isArray(values)) types.push(...values);
    return b;
  };
  b["eq"] = (col: string, value: string) => {
    if (col === "action_type" && value === STATUS_REFRESH) eqStatusRefresh = true;
    else if (col === "action_type") types.push(value);
    return b;
  };
  return b;
}

vi.mock("@/integrations/supabase/client", () => ({
  supabase: { from: (table: string) => makeBuilder(table) },
}));

vi.mock("sonner", () => ({
  toast: { error: vi.fn(), success: vi.fn(), info: vi.fn(), message: vi.fn(), warning: vi.fn() },
}));

vi.mock("@/lib/activity-log-validation.reporter", () => ({
  reportFilterRejection: vi.fn(),
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
      <DispatchLog limit={25} />
    </QueryClientProvider>,
  );
}

const chip = (type: string) => screen.getByRole("button", { name: new RegExp(type, "i") });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

beforeEach(() => {
  delays = {};
  requested = [];
  searchState = {};
  window.localStorage.clear();
});

afterEach(() => cleanup());

describe("rapid quick-filter changes never show stale rows", () => {
  it("ignores a slow earlier response that lands after a faster later one", async () => {
    const user = userEvent.setup();
    // Unfiltered answers instantly; type A is slow; type B is fast.
    delays = { all: 0, [TYPE_A]: 250, [TYPE_B]: 10 };
    renderLog();

    await waitFor(() => expect(screen.getByText(MSG.all)).toBeTruthy());

    // Select A (in flight, slow), then immediately swap to B before A resolves.
    await user.click(chip(TYPE_A));
    await user.click(chip(TYPE_A)); // deselect A
    await user.click(chip(TYPE_B));

    await waitFor(() => expect(screen.getByText(MSG.b)).toBeTruthy());

    // Let the slow A response land; it must not appear or replace B's rows.
    await sleep(350);
    expect(screen.queryByText(MSG.a)).toBeNull();
    expect(screen.queryByText(MSG.all)).toBeNull();
    expect(screen.getByText(MSG.b)).toBeTruthy();
    expect(requested).toContain(TYPE_A);
    expect(requested).toContain(TYPE_B);
  });

  it("shows only the final selection after three filter flips in quick succession", async () => {
    const user = userEvent.setup();
    delays = { all: 5, [TYPE_A]: 200, [TYPE_B]: 120, status_refresh: 5 };
    renderLog();

    await waitFor(() => expect(screen.getByText(MSG.all)).toBeTruthy());

    await user.click(chip(TYPE_A));
    await user.click(chip(TYPE_B)); // A + B
    await user.click(chip(TYPE_A)); // B only
    await user.click(chip(TYPE_B)); // back to unfiltered

    // Every intermediate (slower) response resolves after this point.
    await sleep(300);

    await waitFor(() => expect(screen.getByText(MSG.all)).toBeTruthy());
    expect(screen.queryByText(MSG.a)).toBeNull();
    expect(screen.queryByText(MSG.b)).toBeNull();
    expect(searchState["logTypes"]).toBeUndefined();
  });

  it("does not leak rows from a slow type request into the STATUS_REFRESH only view", async () => {
    const user = userEvent.setup();
    delays = { all: 0, [TYPE_A]: 250, status_refresh: 10 };
    renderLog();

    await waitFor(() => expect(screen.getByText(MSG.all)).toBeTruthy());

    await user.click(chip(TYPE_A));
    await user.click(chip(TYPE_A)); // clear the type chip
    await user.click(screen.getByLabelText(/STATUS_REFRESH only/i));

    await waitFor(() => expect(screen.getByText(MSG.statusRefresh)).toBeTruthy());

    await sleep(350);
    expect(screen.queryByText(MSG.a)).toBeNull();
    expect(screen.queryByText(MSG.all)).toBeNull();
    expect(screen.getByText(MSG.statusRefresh)).toBeTruthy();
  });

  it("keeps the rendered rows consistent with the row counter after a race", async () => {
    const user = userEvent.setup();
    delays = { all: 0, [TYPE_A]: 220, [TYPE_B]: 10 };
    renderLog();

    await waitFor(() => expect(screen.getByText(MSG.all)).toBeTruthy());

    await user.click(chip(TYPE_A));
    await user.click(chip(TYPE_A));
    await user.click(chip(TYPE_B));

    await waitFor(() => expect(screen.getByText(MSG.b)).toBeTruthy());
    await sleep(320);

    // Exactly one row body for the current filter — no duplicated/stale row.
    expect(screen.queryAllByText(MSG.b)).toHaveLength(1);
    expect(screen.queryAllByText(MSG.a)).toHaveLength(0);
  });
});
