// @vitest-environment jsdom
/**
 * Integration coverage for the Activity log's free-text search and date-range
 * filters: both must land in the URL (?q=, ?dateFrom=, ?dateTo=), push down to
 * the Supabase query, and narrow the rendered rows. Deep links must hydrate the
 * controls, and clearing filters must strip the params again.
 *
 * Supabase and the router are stubbed, so the full filter -> query -> render
 * loop runs exactly as it does in the app against fixture rows.
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

/** Two rows today, one row eight days ago (outside a 7-day range). */
const TODAY = new Date();
const EIGHT_DAYS_AGO = new Date(TODAY.getTime() - 8 * 24 * 60 * 60 * 1000);

function at(date: Date, hour: number, minute: number): string {
  const d = new Date(date);
  d.setHours(hour, minute, 0, 0);
  return d.toISOString();
}

const FIXTURES: Row[] = [
  {
    id: "r1",
    action_type: "quote_sms",
    message_sent: "quote link sent to Rivera",
    created_at: at(TODAY, 9, 30),
    status: null,
    customer_id: null,
  },
  {
    id: "r2",
    action_type: "invoice_sms",
    message_sent: "invoice link sent to Chen",
    created_at: at(TODAY, 9, 15),
    status: null,
    customer_id: null,
  },
  {
    id: "r3",
    action_type: "quote_sms",
    message_sent: "older quote link sent to Rivera",
    created_at: at(EIGHT_DAYS_AGO, 11, 0),
    status: null,
    customer_id: null,
  },
];

/** Records what the component pushed down, so tests can assert on the query. */
type Pushed = { gte?: string; lte?: string; or: string[] };
let lastPushed: Pushed = { or: [] };

// --- Supabase stub: applies search + range filters like Postgres would -------
function makeBuilder(table: string) {
  const state: { gte?: string; lte?: string; or: string[]; limit: number } = { or: [], limit: 100 };
  const b: Record<string, unknown> = {
    select: () => b,
    order: () => b,
    limit: (n: number) => {
      state.limit = n;
      return b;
    },
    gte: (_col: string, value: string) => {
      state.gte = value;
      return b;
    },
    lte: (_col: string, value: string) => {
      state.lte = value;
      return b;
    },
    or: (clause: string) => {
      state.or.push(clause);
      return b;
    },
    eq: () => b,
    lt: () => b,
    gt: () => b,
    in: () => b,
    returns: () => {
      lastPushed = { or: state.or, ...(state.gte ? { gte: state.gte } : {}), ...(state.lte ? { lte: state.lte } : {}) };
      let rows = table === "logs" ? [...FIXTURES] : [];
      if (state.gte) rows = rows.filter((r) => r.created_at >= state.gte!);
      if (state.lte) rows = rows.filter((r) => r.created_at <= state.lte!);
      // Each OR group must match somewhere on the row (message/type/phone).
      for (const clause of state.or) {
        const terms = clause
          .split(",")
          .map((c) => c.match(/ilike\.%(.*)%$/)?.[1])
          .filter((t): t is string => Boolean(t));
        rows = rows.filter((r) =>
          terms.some(
            (t) =>
              (r.message_sent ?? "").toLowerCase().includes(t) || r.action_type.toLowerCase().includes(t),
          ),
        );
      }
      return Promise.resolve({ data: rows.slice(0, state.limit), error: null });
    },
  };
  return b;
}

vi.mock("@/integrations/supabase/client", () => ({
  supabase: { from: (table: string) => makeBuilder(table) },
}));

// --- Router stub: a tiny observable search-param store ----------------------
let searchState: Record<string, unknown> = {};
const subscribers = new Set<() => void>();

vi.mock("@tanstack/react-router", () => ({
  Link: ({ children }: { children?: React.ReactNode }) => React.createElement("a", null, children),
  useNavigate: () => (opts: { search?: unknown }) => {
    const next =
      typeof opts.search === "function"
        ? (opts.search as (p: Record<string, unknown>) => Record<string, unknown>)(searchState)
        : ((opts.search as Record<string, unknown>) ?? {});
    // Mirror the router: undefined values drop out of the query string.
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
      <DispatchLog limit={25} />
    </QueryClientProvider>,
  );
}

const searchBox = () => screen.getByRole("searchbox", { name: /Search activity/i });

beforeEach(() => {
  searchState = {};
  lastPushed = { or: [] };
  window.localStorage.removeItem("temaro-activity-log-types");
});

afterEach(() => cleanup());

describe("Activity log search filter", () => {
  it("writes the term to ?q=, pushes it into the query, and narrows the rows", async () => {
    const user = userEvent.setup();
    renderLog();

    await waitFor(() => expect(screen.getByText("quote link sent to Rivera")).toBeTruthy());
    expect(screen.getByText("invoice link sent to Chen")).toBeTruthy();

    await user.type(searchBox(), "invoice");

    // 1. URL is updated (debounced) with the raw term.
    await waitFor(() => expect(searchState["q"]).toBe("invoice"));
    // 2. The term reached Postgres as an OR group, not a client-side filter.
    await waitFor(() => expect(lastPushed.or.join("|")).toMatch(/message_sent\.ilike\.%invoice%/));
    // 3. Results narrow to matching rows only.
    await waitFor(() => expect(screen.queryByText("quote link sent to Rivera")).toBeNull());
    expect(screen.getByText("invoice link sent to Chen")).toBeTruthy();
  });

  it("hydrates the search box from a shared ?q= link", async () => {
    searchState = { q: "invoice" };
    renderLog();

    await waitFor(() => expect((searchBox() as HTMLInputElement).value).toBe("invoice"));
    await waitFor(() => expect(screen.getByText("invoice link sent to Chen")).toBeTruthy());
    expect(screen.queryByText("quote link sent to Rivera")).toBeNull();
  });

  it("removes ?q= and restores every row when the search is cleared", async () => {
    const user = userEvent.setup();
    searchState = { q: "invoice" };
    renderLog();

    await waitFor(() => expect(screen.getByText("invoice link sent to Chen")).toBeTruthy());

    await user.click(screen.getByRole("button", { name: /Clear search/i }));

    await waitFor(() => expect("q" in searchState).toBe(false));
    await waitFor(() => expect(screen.getByText("quote link sent to Rivera")).toBeTruthy());
  });
});

describe("Activity log date-range filter", () => {
  it("writes the picked range to ?dateFrom=/?dateTo= and bounds the query", async () => {
    const user = userEvent.setup();
    renderLog();

    await waitFor(() => expect(screen.getByText("older quote link sent to Rivera")).toBeTruthy());

    await user.click(screen.getByRole("button", { name: /Date range/i }));
    await user.click(await screen.findByRole("button", { name: "7 days" }));

    // 1. Both bounds land in the URL as yyyy-MM-dd day strings.
    await waitFor(() => expect(searchState["dateFrom"]).toMatch(/^\d{4}-\d{2}-\d{2}$/));
    expect(searchState["dateTo"]).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    // 2. The bounds were pushed down as created_at gte/lte.
    await waitFor(() => expect(lastPushed.gte).toBeTruthy());
    expect(lastPushed.lte).toBeTruthy();
    // 3. The eight-day-old row falls outside the range; today's rows remain.
    await waitFor(() => expect(screen.queryByText("older quote link sent to Rivera")).toBeNull());
    expect(screen.getByText("quote link sent to Rivera")).toBeTruthy();
  });

  it("hydrates the range from a shared link and clears it with Clear filters", async () => {
    const user = userEvent.setup();
    const day = (d: Date) =>
      `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    searchState = { dateFrom: day(TODAY), dateTo: day(TODAY) };
    renderLog();

    // Deep-linked range is applied on first render: only today's rows load.
    await waitFor(() => expect(screen.getByText("quote link sent to Rivera")).toBeTruthy());
    expect(screen.queryByText("older quote link sent to Rivera")).toBeNull();
    expect(lastPushed.gte).toBeTruthy();

    await user.click(screen.getByRole("button", { name: /Clear all filters and reset sort/i }));

    await waitFor(() => expect("dateFrom" in searchState).toBe(false));
    expect("dateTo" in searchState).toBe(false);
    await waitFor(() => expect(screen.getByText("older quote link sent to Rivera")).toBeTruthy());
  });
});
