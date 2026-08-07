// @vitest-environment jsdom
/**
 * UI integration test: invalid filter payloads arriving from the URL must
 * surface the friendly validation banner (not a raw Zod error), announce
 * themselves accessibly, and be recoverable with one tap on "Reset filters".
 *
 * The payloads mirror what a shared link or hand-edited query string can carry:
 * an over-long search, an unknown record type, an inverted date range, and a
 * nonsense sort order.
 */
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MAX_LOG_SEARCH_LENGTH } from "@/lib/activity-log-filters.schema";
import { LOG_ACTION_TYPES } from "@/lib/log-action-types.generated";

const GOOD_TYPE = LOG_ACTION_TYPES[0]!;
const ROW_MESSAGE = "dispatch row body";

const rows = () => [
  {
    id: "row-1",
    action_type: GOOD_TYPE,
    message_sent: ROW_MESSAGE,
    created_at: new Date("2026-06-01T12:00:00.000Z").toISOString(),
    status: "sent",
    customer_id: null,
    recipient_phone: null,
  },
];

function makeBuilder(table: string) {
  const isLogs = table === "logs" || table === "logs_archive";
  const result = () => ({ data: isLogs ? rows() : [], error: null });
  const b: Record<string, unknown> = {
    select: () => b,
    order: () => b,
    limit: () => b,
    returns: () => Promise.resolve(result()),
    then: (resolve: (v: unknown) => unknown) => resolve(result()),
  };
  for (const fn of ["gte", "lte", "lt", "gt", "eq", "in", "or"]) b[fn] = () => b;
  return b;
}

vi.mock("@/integrations/supabase/client", () => ({
  supabase: { from: (table: string) => makeBuilder(table) },
}));

vi.mock("sonner", () => ({
  toast: { error: vi.fn(), success: vi.fn(), info: vi.fn(), message: vi.fn(), warning: vi.fn() },
}));

// The rejection reporter round-trips to a server function; stub it out so the
// test stays a pure UI integration test.
const reportFilterRejection = vi.fn();
vi.mock("@/lib/activity-log-validation.reporter", () => ({
  reportFilterRejection: (...args: unknown[]) => reportFilterRejection(...args),
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

function renderLog(search: Record<string, unknown>) {
  searchState = search;
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <DispatchLog limit={25} />
    </QueryClientProvider>,
  );
}

const banner = () => screen.queryByTestId("log-filter-errors");

beforeEach(() => {
  searchState = {};
  reportFilterRejection.mockClear();
  window.localStorage.clear();
});

afterEach(() => cleanup());

describe("invalid filter payloads render the friendly validation banner", () => {
  it("shows a plain-language message for an over-long search and blocks the query", async () => {
    renderLog({ q: "x".repeat(MAX_LOG_SEARCH_LENGTH + 1) });

    const el = await waitFor(() => {
      const found = banner();
      expect(found).toBeTruthy();
      return found!;
    });

    expect(el.textContent).toContain("Fix these filters to load records");
    expect(el.textContent).toContain("Your search is too long");
    expect(el.textContent).toContain(`under ${MAX_LOG_SEARCH_LENGTH} characters`);
    // No raw Zod/technical wording leaks to the user.
    expect(el.textContent).not.toMatch(/zod|ZodError|too_big|String must contain/i);

    // Blocking issue: the request is never sent, and the list says so.
    expect(
      screen.getByText(/We didn’t search yet — fix the highlighted filters above/i),
    ).toBeTruthy();
    expect(screen.queryByText(ROW_MESSAGE)).toBeNull();
  });

  it("names an unknown record type, still loads records, and does not steal focus", async () => {
    renderLog({ logTypes: "not_a_real_type" });

    await waitFor(() => expect(banner()).toBeTruthy());
    const el = banner()!;
    expect(el.textContent).toContain("Some filters were adjusted");
    expect(el.textContent).toContain("not_a_real_type");

    // Correctable issue → records still load and focus is left alone.
    await waitFor(() => expect(screen.getByText(ROW_MESSAGE)).toBeTruthy());
    expect(document.activeElement).not.toBe(el);
  });

  it("explains an inverted date range and an unrecognised sort order", async () => {
    renderLog({ dateFrom: "2026-03-10", dateTo: "2026-03-01", logSort: "sideways" });

    await waitFor(() => expect(banner()).toBeTruthy());
    const text = banner()!.textContent ?? "";
    expect(text).toMatch(/date/i);
    expect(text).toContain("showing newest first");
    expect(text).toContain("swap them");
    expect(screen.getByRole("alert")).toBe(banner());
  });

  it("marks the banner as an assertive live region and focuses it for blocking errors", async () => {
    renderLog({ q: "y".repeat(MAX_LOG_SEARCH_LENGTH + 5) });

    const el = await waitFor(() => {
      const found = banner();
      expect(found).toBeTruthy();
      return found!;
    });

    expect(el.getAttribute("role")).toBe("alert");
    expect(el.getAttribute("aria-live")).toBe("assertive");
    expect(el.getAttribute("aria-atomic")).toBe("true");
    expect(el.getAttribute("tabindex")).toBe("-1");
    await waitFor(() => expect(document.activeElement).toBe(el));
  });

  it("renders a working Reset filters button that clears the bad payload", async () => {
    const user = userEvent.setup();
    renderLog({ q: "z".repeat(MAX_LOG_SEARCH_LENGTH + 1), logTypes: "not_a_real_type" });

    await waitFor(() => expect(banner()).toBeTruthy());
    const reset = screen.getByRole("button", { name: /Reset filters/i });
    expect(banner()!.contains(reset)).toBe(true);

    await user.click(reset);

    // Banner clears, the bad params are gone from the URL, and records load.
    await waitFor(() => expect(banner()).toBeNull());
    expect(searchState["q"]).toBeUndefined();
    expect(searchState["logTypes"]).toBeUndefined();
    await waitFor(() => expect(screen.getByText(ROW_MESSAGE)).toBeTruthy());
  });

  it("reports the rejected payload for tracing", async () => {
    renderLog({ q: "q".repeat(MAX_LOG_SEARCH_LENGTH + 1) });
    await waitFor(() => expect(reportFilterRejection).toHaveBeenCalled());
  });
});
