// @vitest-environment jsdom
/**
 * Drift scenario: a record type the app still considers valid is rejected by
 * Postgres, so the value really does reach the server and comes back as a
 * `logs_action_type_check` violation (HTTP 400).
 *
 * The point of the test is parity — the CSV export toast must surface the same
 * headline, plain-language explanation, allowed-type list and exact constraint
 * text that the list view's error alert shows, so support sees one story
 * regardless of which control the user touched.
 */
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { LOG_ACTION_TYPES } from "@/lib/log-action-types.generated";

const PAGE = 25;

/** Valid in the app's whitelist today, rejected by this (drifted) database. */
const DRIFTED_TYPE = LOG_ACTION_TYPES[0]!;

const CHECK_ERROR = {
  code: "23514",
  message: 'new row for relation "logs" violates check constraint "logs_action_type_check"',
  details: `Failing row contains (…, ${DRIFTED_TYPE}, …).`,
  hint: null as string | null,
  status: 400,
};

/** action_type values that actually reached the database layer. */
let sentActionTypes: string[] = [];
let logRequests = 0;

function makeBuilder(table: string) {
  const b: Record<string, unknown> = {
    select: () => b,
    order: () => b,
    limit: () => b,
    lt: () => b,
    gt: () => b,
    gte: () => b,
    lte: () => b,
    or: () => b,
    in: (col: string, vals: string[]) => {
      if (col === "action_type") sentActionTypes.push(...vals);
      return b;
    },
    eq: (col: string, val: string) => {
      if (col === "action_type") sentActionTypes.push(val);
      return b;
    },
    returns: () => {
      if (table !== "logs" && table !== "logs_archive") {
        return Promise.resolve({ data: [], error: null });
      }
      logRequests += 1;
      // The server rejects every request carrying the drifted type.
      return Promise.resolve({ data: null, error: CHECK_ERROR });
    },
  };
  return b;
}

vi.mock("@/integrations/supabase/client", () => ({
  supabase: { from: (table: string) => makeBuilder(table) },
}));

const toastError = vi.fn();
vi.mock("sonner", () => ({
  toast: {
    error: (...args: unknown[]) => toastError(...args),
    success: vi.fn(),
    info: vi.fn(),
    message: vi.fn(),
    warning: vi.fn(),
  },
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

beforeEach(() => {
  searchState = { logTypes: DRIFTED_TYPE };
  sentActionTypes = [];
  logRequests = 0;
  toastError.mockClear();
  if (!URL.createObjectURL) {
    Object.defineProperty(URL, "createObjectURL", { value: () => "blob:x", writable: true });
    Object.defineProperty(URL, "revokeObjectURL", { value: () => {}, writable: true });
  }
  window.localStorage.removeItem("temaro-activity-log-types");
});

afterEach(() => cleanup());

describe("CSV export parity with the list view on a server-side action_type rejection", () => {
  it("sends the drifted type to the server and reports identical logs_action_type_check details", async () => {
    const user = userEvent.setup();
    renderLog();

    // 1. The filter value was not stripped client-side — it hit the database.
    const alert = await screen.findByTestId("log-error-alert");
    expect(sentActionTypes).toContain(DRIFTED_TYPE);
    expect(logRequests).toBeGreaterThan(0);

    // 2. List view: friendly headline, explanation, whitelist, constraint text.
    const listTitle = alert.querySelector("p")!.textContent!;
    expect(listTitle).toMatch(/record type isn’t one we track/i);
    expect(alert.textContent).toMatch(/fixed list of record types/i);
    expect(alert.textContent).toContain(`Allowed: ${LOG_ACTION_TYPES.join(", ")}`);
    await user.click(screen.getByTestId("log-error-details-toggle"));
    const listDetail = screen.getByTestId("log-error-details-text").textContent!;
    expect(listDetail).toContain("logs_action_type_check");
    expect(screen.getByTestId("log-error-details-toggle").textContent).toContain("HTTP 400");

    // 3. Export the same filters: the toast repeats the list view's story.
    toastError.mockClear();
    await user.click(screen.getByRole("button", { name: /Export/i }));
    await waitFor(() => expect(toastError).toHaveBeenCalled());

    const [toastTitle, opts] = toastError.mock.calls[0] as [string, { description: string }];
    expect(toastTitle).toBe(listTitle);
    expect(opts.description).toContain("HTTP 400");
    // Same constraint text, verbatim, as the list view's technical details.
    expect(opts.description).toContain(listDetail);
    expect(opts.description).toMatch(/fixed list of record types/i);
    expect(opts.description).toContain(DRIFTED_TYPE);
  });
});
