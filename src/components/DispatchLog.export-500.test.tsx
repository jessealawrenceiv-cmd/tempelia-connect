// @vitest-environment jsdom
/**
 * Simulates an HTTP 500 from the CSV export request and confirms the UI falls
 * back to the generic "Export failed" toast (no constraint-specific headline,
 * no raw error dump), and that the button recovers to its idle label.
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

/** Shape PostgREST/the gateway returns for an unexpected server fault. */
const SERVER_ERROR = {
  code: "500",
  message: "Internal Server Error",
  details: "upstream request timeout",
  hint: null as string | null,
  status: 500,
};

/** Only the export request should fail; the initial list load must succeed. */
let failWith500 = false;
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
    in: () => b,
    eq: () => b,
    returns: () => {
      if (table !== "logs" && table !== "logs_archive") {
        return Promise.resolve({ data: [], error: null });
      }
      logRequests += 1;
      if (failWith500) return Promise.resolve({ data: null, error: SERVER_ERROR });
      return Promise.resolve({ data: ROWS, error: null });
    },
  };
  return b;
}

vi.mock("@/integrations/supabase/client", () => ({
  supabase: { from: (table: string) => makeBuilder(table) },
}));

const toastError = vi.fn();
const toastSuccess = vi.fn();
vi.mock("sonner", () => ({
  toast: {
    error: (...args: unknown[]) => toastError(...args),
    success: (...args: unknown[]) => toastSuccess(...args),
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
  logRequests = 0;
  failWith500 = false;
  toastError.mockClear();
  toastSuccess.mockClear();
  if (!URL.createObjectURL) {
    Object.defineProperty(URL, "createObjectURL", { value: () => "blob:x", writable: true });
    Object.defineProperty(URL, "revokeObjectURL", { value: () => {}, writable: true });
  }
  window.localStorage.removeItem("temaro-activity-log-types");
});

afterEach(() => cleanup());

const exportButton = () => screen.getByRole("button", { name: /Export/i });

describe("CSV export when the endpoint returns HTTP 500", () => {
  it("shows the generic Export failed toast", async () => {
    const user = userEvent.setup();
    renderLog();
    await waitFor(() => expect(screen.getByText("quote row 1")).toBeTruthy());

    failWith500 = true;
    const before = logRequests;
    await user.click(exportButton());

    await waitFor(() => expect(toastError).toHaveBeenCalled());
    expect(logRequests).toBeGreaterThan(before);
    expect(toastSuccess).not.toHaveBeenCalled();

    const [title, opts] = toastError.mock.calls[0] as [string, { description: string }];
    expect(title).toBe("Export failed");
    // No constraint-specific wording leaks in for a plain server fault.
    expect(title).not.toMatch(/record type/i);
    expect(opts.description).not.toContain("logs_action_type_check");
  });

  it("leaves the export button usable again after the failure", async () => {
    const user = userEvent.setup();
    renderLog();
    await waitFor(() => expect(screen.getByText("quote row 1")).toBeTruthy());

    failWith500 = true;
    await user.click(exportButton());
    await waitFor(() => expect(toastError).toHaveBeenCalled());

    // isExporting must be cleared in the finally block, not stuck on "Exporting…".
    await waitFor(() => {
      const btn = exportButton() as HTMLButtonElement;
      expect(btn.disabled).toBe(false);
      expect(btn.textContent).toMatch(/Export CSV/i);
    });

    // A retry after the server recovers succeeds.
    failWith500 = false;
    await user.click(exportButton());
    await waitFor(() => expect(toastSuccess).toHaveBeenCalled());
  });
});
