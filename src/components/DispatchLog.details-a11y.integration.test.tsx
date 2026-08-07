// @vitest-environment jsdom
/**
 * Screen-reader and keyboard behaviour for the HTTP 400 alert's collapsible
 * "Technical details" disclosure: labelled alert region, aria-expanded /
 * aria-controls wiring, hidden-until-opened content, Enter/Space activation,
 * and Escape collapsing with focus returned to the toggle.
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

describe("400 alert technical-details accessibility", () => {
  beforeEach(() => {
    fail400 = true;
  });

  it("labels the alert region with its headline", async () => {
    renderLog();
    const alert = await waitFor(() => errorAlert());
    const labelId = alert.getAttribute("aria-labelledby");
    expect(labelId).toBeTruthy();
    const label = document.getElementById(labelId!);
    expect(label?.textContent ?? "").toMatch(/That record type isn’t one we track/i);
    expect(alert.getAttribute("aria-live")).toBe("polite");
  });

  it("exposes a collapsed disclosure button wired to the details region", async () => {
    renderLog();
    const toggle = await waitFor(() => screen.getByTestId("log-error-details-toggle"));
    // A real <button>, so Enter/Space and screen-reader activation work natively.
    expect(toggle.tagName).toBe("BUTTON");
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    const region = document.getElementById(toggle.getAttribute("aria-controls")!);
    expect(region).toBeTruthy();
    // Collapsed content is hidden from the accessibility tree, not just visually.
    expect((region as HTMLElement).hidden).toBe(true);
  });

  it("opens on keyboard activation and announces the expanded state", async () => {
    renderLog();
    const toggle = await waitFor(() => screen.getByTestId("log-error-details-toggle"));
    toggle.focus();
    expect(document.activeElement).toBe(toggle);

    // Enter on a native button fires click; assert the resulting state.
    fireEvent.keyDown(toggle, { key: "Enter" });
    fireEvent.click(toggle);
    await waitFor(() => expect(toggle.getAttribute("aria-expanded")).toBe("true"));

    const region = document.getElementById(toggle.getAttribute("aria-controls")!) as HTMLElement;
    expect(region.hidden).toBe(false);
    expect(within(region).getByTestId("log-error-details-text").textContent ?? "").toContain(
      'check constraint "logs_action_type_check"',
    );
  });

  it("collapses on Escape and returns focus to the toggle", async () => {
    renderLog();
    const toggle = await waitFor(() => screen.getByTestId("log-error-details-toggle"));
    fireEvent.click(toggle);
    await waitFor(() => expect(toggle.getAttribute("aria-expanded")).toBe("true"));

    const region = document.getElementById(toggle.getAttribute("aria-controls")!) as HTMLElement;
    fireEvent.keyDown(region, { key: "Escape" });

    await waitFor(() => expect(toggle.getAttribute("aria-expanded")).toBe("false"));
    expect(region.hidden).toBe(true);
    // Focus must never be left on a hidden node.
    expect(document.activeElement).toBe(toggle);
  });

  it("keeps the Retry and Clear filters controls reachable while details are open", async () => {
    searchState = { logTypes: "quote_sms" };
    renderLog();
    const toggle = await waitFor(() => screen.getByTestId("log-error-details-toggle"));
    fireEvent.click(toggle);

    const alert = errorAlert();
    expect(within(alert).getByTestId("log-error-clear-filters")).toBeTruthy();
    expect(within(alert).getByRole("button", { name: /retry/i })).toBeTruthy();
  });
});
