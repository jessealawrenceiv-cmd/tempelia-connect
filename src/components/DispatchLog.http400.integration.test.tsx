// @vitest-environment jsdom
/**
 * Simulates an HTTP 400 coming back from the logs API (the Postgres
 * `logs_action_type_check` constraint violation) and asserts the inline alert
 * renders the friendly headline, the full allowed record-type list, a working
 * "Clear filters" shortcut, and the exact constraint text under Technical
 * details — nothing swallowed, nothing paraphrased.
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
  const match = screen
    .getAllByRole("alert")
    .find((el) => /record type isn’t one we track|Couldn’t load activity/i.test(el.textContent ?? ""));
  if (!match) throw new Error("error alert not rendered");
  return match;
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

describe("HTTP 400 from the logs API", () => {
  it("shows the friendly headline instead of a raw error dump", async () => {
    fail400 = true;
    renderLog();

    const alert = await waitFor(() => errorAlert());
    expect(screen.getByText(/That record type isn’t one we track/i)).toBeTruthy();
    // The raw constraint text is never the headline.
    expect(alert.textContent ?? "").not.toMatch(/^new row for relation/);
    expect(alert.textContent ?? "").toMatch(/Clear your filters to get back to the full log/i);
  });

  it("lists every allowed record type from the shared enum", async () => {
    fail400 = true;
    renderLog();

    const allowed = await waitFor(() => screen.getByText(/^Allowed:/));
    for (const type of LOG_ACTION_TYPES) {
      expect(allowed.textContent ?? "").toContain(type);
    }
    expect(allowed.textContent).toBe(`Allowed: ${LOG_ACTION_TYPES.join(", ")}`);
  });

  it("renders the exact logs_action_type_check message under Technical details", async () => {
    fail400 = true;
    renderLog();

    await waitFor(() => errorAlert());
    expect(screen.getByText(/Technical details \(HTTP 400\)/i)).toBeTruthy();
    const detail = screen.getByText(new RegExp(CONSTRAINT_MESSAGE.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    expect(detail.textContent ?? "").toContain('check constraint "logs_action_type_check"');
    expect(detail.textContent ?? "").toContain(API_400.details);
  });

  it("offers a Clear filters shortcut that drops the offending filters and recovers", async () => {
    // An active record-type filter is what makes the shortcut meaningful.
    searchState = { logTypes: "quote_sms" };
    fail400 = true;
    renderLog();

    const clear = await waitFor(() => screen.getByTestId("log-error-clear-filters"));
    // The alert keeps a stable identity, so the button we found is still live.
    expect(document.body.contains(clear)).toBe(true);
    fail400 = false;
    // Single click on the rendered button must be enough: the alert no longer
    // remounts between render passes, so the node is still attached.
    fireEvent.click(clear);
    expect(searchState.logTypes).toBeUndefined();
    await waitFor(() => expect(screen.getByText("quote row 1")).toBeTruthy());
    expect(screen.queryByText(/That record type isn’t one we track/i)).toBeNull();
  });

  it("hides the Clear filters shortcut when no filters are active", async () => {
    fail400 = true;
    renderLog();

    const alert = await waitFor(() => errorAlert());
    expect(alert.querySelector("button")?.textContent ?? "").toMatch(/Retry/i);
    expect(
      Array.from(alert.querySelectorAll("button")).some((b) => /Clear filters/i.test(b.textContent ?? "")),
    ).toBe(false);
  });
});
