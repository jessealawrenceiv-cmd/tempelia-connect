// @vitest-environment jsdom
/**
 * Forces a Postgres 23514 `logs_action_type_check` response and verifies the
 * offending action_type value itself is surfaced to the user — in the export
 * toast, in the inline list-view alert, and in the parsed error info.
 */
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  describeLogRequestError,
  rejectedActionTypeFromError,
} from "@/lib/activity-log-filters.schema";

const PAGE = 25;
const REJECTED = "definitely_not_a_log_type";

const ROWS = [
  {
    id: "r1",
    action_type: "quote_sms",
    message_sent: "quote row 1",
    created_at: new Date("2026-06-01T12:00:00.000Z").toISOString(),
    status: null,
    customer_id: null,
  },
];

/** Verbatim PostgREST payload for the check-constraint violation. */
const CHECK_ERROR = {
  code: "23514",
  message: 'new row for relation "logs" violates check constraint "logs_action_type_check"',
  details: `Failing row contains (9f1c, ${REJECTED}, 2026-06-01 12:00:00+00, null).`,
  hint: null as string | null,
  status: 400,
};

let failWithCheckError = false;

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
  failWithCheckError = false;
  toastError.mockClear();
  if (!URL.createObjectURL) {
    Object.defineProperty(URL, "createObjectURL", { value: () => "blob:x", writable: true });
    Object.defineProperty(URL, "revokeObjectURL", { value: () => {}, writable: true });
  }
  window.localStorage.removeItem("temaro-activity-log-types");
});

afterEach(() => cleanup());

describe("23514 logs_action_type_check surfaces the rejected action_type", () => {
  it("parses the offending value out of the Postgres payload", () => {
    expect(rejectedActionTypeFromError(CHECK_ERROR)).toBe(REJECTED);

    const info = describeLogRequestError(CHECK_ERROR);
    expect(info.isActionTypeCheck).toBe(true);
    expect(info.rejectedValue).toBe(REJECTED);
    expect(info.message).toContain(REJECTED);
    // Real record types are never mistaken for the offender.
    expect(rejectedActionTypeFromError({ code: "23514", message: "action_type quote_sms" })).toBeUndefined();
  });

  it("includes the rejected value in the export toast", async () => {
    const user = userEvent.setup();
    renderLog();
    await waitFor(() => expect(screen.getByText("quote row 1")).toBeTruthy());

    failWithCheckError = true;
    await user.click(screen.getByRole("button", { name: /Export/i }));

    await waitFor(() => expect(toastError).toHaveBeenCalled());
    const [title, opts] = toastError.mock.calls[0] as [string, { description: string }];
    expect(title).toMatch(/record type isn’t one we track/i);
    expect(opts.description).toContain(REJECTED);
    expect(opts.description).toContain("logs_action_type_check");
    expect(opts.description).toContain("HTTP 400");
  });

  it("names the rejected value in the inline list-view alert", async () => {
    failWithCheckError = true;
    renderLog();

    await waitFor(() =>
      expect(screen.getByText(/record type isn’t one we track/i)).toBeTruthy(),
    );
    const alert = screen.getByRole("alert");
    expect(alert.textContent ?? "").toContain(REJECTED);
  });
});
