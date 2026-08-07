// @vitest-environment jsdom
/**
 * Inline helper text beside the Record type filter when the logs API returns a
 * 400: the valid action_type values must be visible without opening the
 * technical-details disclosure.
 */
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { LOG_ACTION_TYPES } from "@/lib/log-action-types.generated";

const PAGE = 25;

/** Verbatim PostgREST body for a 400 constraint violation on logs. */
const CONSTRAINT_MESSAGE =
  'new row for relation "logs" violates check constraint "logs_action_type_check"';
const API_400 = {
  code: "23514",
  message: CONSTRAINT_MESSAGE,
  details: "Failing row contains (9f1c, bogus_type, 2026-06-01 12:00:00+00, null).",
  hint: null as string | null,
  status: 400,
};

let fail400 = false;

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
      if (fail400) return Promise.resolve({ data: null, error: API_400 });
      return Promise.resolve({
        data: [
          {
            id: "r1",
            action_type: "quote_sms",
            message_sent: "quote row 1",
            created_at: new Date("2026-06-01T12:00:00.000Z").toISOString(),
            status: null,
            customer_id: null,
          },
        ],
        error: null,
      });
    },
  };
  return b;
}

vi.mock("@/integrations/supabase/client", () => ({
  supabase: { from: (table: string) => makeBuilder(table) },
}));

vi.mock("sonner", () => ({
  toast: {
    error: vi.fn(),
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

/** The inline list-view error alert (there are other aria-live alerts on screen). */
function errorAlert(): HTMLElement {
  return screen.getByTestId("log-error-alert");
}

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
  fail400 = false;
  window.localStorage.removeItem("temaro-activity-log-types");
});

afterEach(() => cleanup());

describe("inline valid record-type helper on a 400", () => {
  it("lists every valid value next to the Record type filter without opening details", async () => {
    fail400 = true;
    renderLog();

    const help = await waitFor(() => screen.getByTestId("log-filter-allowed-types"));
    // Details disclosure is still collapsed — the helper stands on its own.
    const toggle = screen.getByTestId("log-error-details-toggle");
    expect(toggle.getAttribute("aria-expanded")).toBe("false");

    for (const type of LOG_ACTION_TYPES) {
      expect(help.textContent ?? "").toContain(type);
    }
    expect(help.textContent ?? "").toMatch(/Valid values:/i);
  });

  it("announces the helper and describes the Record type fieldset", async () => {
    fail400 = true;
    renderLog();

    const help = await waitFor(() => screen.getByTestId("log-filter-allowed-types"));
    expect(help.getAttribute("role")).toBe("status");
    expect(help.getAttribute("aria-live")).toBe("polite");

    const fieldset = help.closest("fieldset") as HTMLElement;
    expect(fieldset).toBeTruthy();
    expect(fieldset.getAttribute("aria-describedby") ?? "").toContain("log-filter-allowed-types");
  });

  it("stays hidden while the logs request succeeds", async () => {
    fail400 = false;
    renderLog();

    await waitFor(() => expect(screen.getByText("quote row 1")).toBeTruthy());
    expect(screen.queryByTestId("log-filter-allowed-types")).toBeNull();
  });
});
