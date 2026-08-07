// @vitest-environment jsdom
/**
 * Verifies the CSV export path handles an invalid action_type the same way the
 * list view does.
 *
 * Two layers are checked:
 *
 * 1. Client guard — an invalid action_type in the persisted/URL filters is
 *    sanitised before any request, so the export never sends a bad value.
 * 2. Server 400 — when Postgres still rejects the request with
 *    `violates check constraint "logs_action_type_check"` (HTTP 400), the
 *    export toast shows the same friendly headline plus the exact constraint
 *    message, not a raw error dump.
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

const ROWS: Row[] = [
  {
    id: "r1",
    action_type: "quote_sms",
    message_sent: "quote row 1",
    created_at: new Date("2026-06-01T12:00:00.000Z").toISOString(),
    status: null,
    customer_id: null,
  },
];

/** Exactly what PostgREST returns for a check-constraint violation (HTTP 400). */
const CHECK_ERROR = {
  code: "23514",
  message: 'new row for relation "logs" violates check constraint "logs_action_type_check"',
  details: 'Failing row contains (…, not_a_real_type, …).',
  hint: null as string | null,
  status: 400,
};

/** Flip to true to make the logs request fail with the 400 check violation. */
let failWithCheckError = false;
/** action_type values that actually reached Postgres via .in()/.eq(). */
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
      if (failWithCheckError) return Promise.resolve({ data: null, error: CHECK_ERROR });
      return Promise.resolve({ data: ROWS, error: null });
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
  searchState = {};
  sentActionTypes = [];
  logRequests = 0;
  failWithCheckError = false;
  toastError.mockClear();
  // jsdom has no download plumbing; keep the happy path from throwing.
  if (!URL.createObjectURL) {
    Object.defineProperty(URL, "createObjectURL", { value: () => "blob:x", writable: true });
    Object.defineProperty(URL, "revokeObjectURL", { value: () => {}, writable: true });
  }
  window.localStorage.removeItem("temaro-activity-log-types");
});

afterEach(() => cleanup());

const exportButton = () => screen.getByRole("button", { name: /Export/i });

describe("CSV export with an invalid action_type filter", () => {
  it("strips the invalid value client-side so the export request stays valid", async () => {
    // A tampered deep link carrying one real and one bogus record type.
    searchState = { logTypes: "quote_sms,not_a_real_type" };
    const user = userEvent.setup();
    renderLog();

    await waitFor(() => expect(screen.getByText("quote row 1")).toBeTruthy());
    sentActionTypes = [];

    await user.click(exportButton());

    await waitFor(() => expect(sentActionTypes.length).toBeGreaterThan(0));
    expect(sentActionTypes).toContain("quote_sms");
    expect(sentActionTypes).not.toContain("not_a_real_type");
    expect(toastError).not.toHaveBeenCalled();
  });

  it("shows the friendly headline and the exact logs_action_type_check message on an HTTP 400", async () => {
    const user = userEvent.setup();
    renderLog();
    await waitFor(() => expect(screen.getByText("quote row 1")).toBeTruthy());

    // Server-side rejection: PostgREST answers the export query with the 400.
    failWithCheckError = true;
    const before = logRequests;
    await user.click(exportButton());

    await waitFor(() => expect(toastError).toHaveBeenCalled());
    expect(logRequests).toBeGreaterThan(before);

    const [title, opts] = toastError.mock.calls[0] as [string, { description: string }];
    expect(title).toMatch(/record type isn’t one we track/i);
    // The exact constraint text is preserved for support/debugging…
    expect(opts.description).toContain("logs_action_type_check");
    expect(opts.description).toContain('violates check constraint');
    expect(opts.description).toContain("HTTP 400");
    // …alongside the plain-language explanation the list view uses.
    expect(opts.description).toMatch(/fixed list of record types/i);
  });

  it("keeps the generic Export failed headline for unrelated failures", async () => {
    const user = userEvent.setup();
    renderLog();
    await waitFor(() => expect(screen.getByText("quote row 1")).toBeTruthy());

    failWithCheckError = true;
    CHECK_ERROR.code = "42501";
    CHECK_ERROR.message = "permission denied for table logs";
    CHECK_ERROR.details = "";
    try {
      await user.click(exportButton());
      await waitFor(() => expect(toastError).toHaveBeenCalled());
      const [title, opts] = toastError.mock.calls[0] as [string, { description: string }];
      expect(title).toBe("Export failed");
      expect(opts.description).toContain("permission denied for table logs");
    } finally {
      CHECK_ERROR.code = "23514";
      CHECK_ERROR.message =
        'new row for relation "logs" violates check constraint "logs_action_type_check"';
      CHECK_ERROR.details = 'Failing row contains (…, not_a_real_type, …).';
    }
  });
});
