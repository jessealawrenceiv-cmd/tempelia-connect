// @vitest-environment jsdom
/**
 * Integration coverage for the "Load 25 older" control's disabled/loading
 * states around a mid-pagination server error.
 *
 * While a page is in flight the button must read "Loading…" and be disabled so
 * a second tap can't fire a duplicate keyset request. When that request fails
 * the button must return to its enabled "Load 25 older" label (so pagination
 * stays reachable) alongside the error alert — and after a successful Retry it
 * must keep working and finally settle on "No more older actions".
 *
 * Supabase is stubbed with a keyset-aware fake that honours `lt` + `limit`,
 * can be told to fail the next request, and can hold a response open so the
 * in-flight UI state is observable.
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
/** When set, the next response waits for this gate before settling. */
let gate: { release: () => void; promise: Promise<void> } | null = null;

function openGate() {
  let release = () => {};
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  gate = { release, promise };
  return () => {
    const g = gate;
    gate = null;
    g?.release();
  };
}

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
    returns: async () => {
      cursors.push(state.lt ?? null);
      const held = gate;
      if (held) await held.promise;
      if (failCount > 0) {
        failCount -= 1;
        return { data: null, error: new FakeLogError() };
      }
      let rows = table === "logs" ? [...ALL_ROWS] : [];
      if (state.lt) rows = rows.filter((r) => r.created_at < state.lt!);
      return { data: rows.slice(0, state.limit), error: null };
    },
  };
  return b;
}

vi.mock("@/integrations/supabase/client", () => ({
  supabase: { from: (table: string) => makeBuilder(table) },
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

const loadOlder = () =>
  screen.queryByRole("button", { name: new RegExp(`Load ${PAGE} older`, "i") }) as
    | HTMLButtonElement
    | null;
const loadingButton = () =>
  screen.queryByRole("button", { name: /Loading…/i }) as HTMLButtonElement | null;
const retryButton = () => screen.getByRole("button", { name: /^Retry|^Retrying/i });
const errorAlert = () => screen.queryByText(/Couldn’t load activity|Couldn't load activity/i);

beforeEach(() => {
  searchState = {};
  cursors = [];
  failCount = 0;
  gate = null;
  window.localStorage.clear();
});

afterEach(() => {
  gate?.release();
  gate = null;
  cleanup();
});

describe("Load 25 older states across a mid-pagination server error", () => {
  it("disables the control and shows Loading… while the next page is in flight", async () => {
    const user = userEvent.setup();
    renderLog();
    await loadedCount(PAGE);

    const release = openGate();
    await user.click(loadOlder()!);

    // In-flight: label switches to Loading… and the button is disabled.
    await waitFor(() => expect(loadingButton()).toBeTruthy());
    expect(loadingButton()!.disabled).toBe(true);
    expect(loadOlder()).toBeNull();

    // A second tap while disabled must not queue another keyset request.
    const before = cursors.length;
    await user.click(loadingButton()!);
    expect(cursors.length).toBe(before);

    release();
    await loadedCount(PAGE * 2);
    expect(loadOlder()!.disabled).toBe(false);
  });

  it("re-enables the control with its normal label when the page request fails", async () => {
    const user = userEvent.setup();
    renderLog();
    await loadedCount(PAGE);

    failCount = 1;
    const release = openGate();
    await user.click(loadOlder()!);

    await waitFor(() => expect(loadingButton()).toBeTruthy());
    expect(loadingButton()!.disabled).toBe(true);

    release();

    // Error surfaces, rows are kept, and the button is usable again.
    await waitFor(() => expect(errorAlert()).toBeTruthy());
    await loadedCount(PAGE);
    await waitFor(() => expect(loadOlder()).toBeTruthy());
    expect(loadOlder()!.disabled).toBe(false);
    expect(loadingButton()).toBeNull();
    expect(screen.getByText(/upstream request timed out/i)).toBeTruthy();
  });

  it("shows Retrying… and keeps Load 25 older disabled during a retry", async () => {
    const user = userEvent.setup();
    renderLog();
    await loadedCount(PAGE);

    failCount = 1;
    await user.click(loadOlder()!);
    await waitFor(() => expect(errorAlert()).toBeTruthy());

    const release = openGate();
    await user.click(retryButton());

    await waitFor(() => expect(screen.getByRole("button", { name: /Retrying…/i })).toBeTruthy());
    expect(screen.getByRole("button", { name: /Retrying…/i })).toBeDisabled();

    release();
    await waitFor(() => expect(errorAlert()).toBeNull());
    await loadedCount(PAGE);
    expect(loadOlder()!.disabled).toBe(false);
  });

  it("recovers pagination after a retry and settles on No more older actions", async () => {
    const user = userEvent.setup();
    renderLog();
    await loadedCount(PAGE);

    failCount = 1;
    await user.click(loadOlder()!);
    await waitFor(() => expect(errorAlert()).toBeTruthy());

    await user.click(retryButton());
    await waitFor(() => expect(errorAlert()).toBeNull());
    await loadedCount(PAGE);

    // Pagination resumes from the correct cursor.
    cursors = [];
    await user.click(loadOlder()!);
    await loadedCount(PAGE * 2);
    expect(cursors).toEqual([ALL_ROWS[PAGE - 1]!.created_at]);

    // Final short page ends pagination and removes the control entirely.
    await user.click(loadOlder()!);
    await loadedCount(ALL_ROWS.length);
    await waitFor(() => expect(screen.getByText(/No more older actions/i)).toBeTruthy());
    expect(loadOlder()).toBeNull();
    expect(loadingButton()).toBeNull();
  });

  it("retries directly from the failed page without leaving a stuck Loading… state", async () => {
    const user = userEvent.setup();
    renderLog();
    await loadedCount(PAGE);

    failCount = 2; // failing page + failing retry
    await user.click(loadOlder()!);
    await waitFor(() => expect(errorAlert()).toBeTruthy());
    expect(loadOlder()!.disabled).toBe(false);

    await user.click(retryButton());
    await waitFor(() => expect(errorAlert()).toBeTruthy());
    // Still enabled after a failed retry — never stuck in the loading state.
    expect(loadingButton()).toBeNull();
    expect(loadOlder()!.disabled).toBe(false);

    await user.click(retryButton());
    await waitFor(() => expect(errorAlert()).toBeNull());
    expect(loadOlder()!.disabled).toBe(false);
  });
});
