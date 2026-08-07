// @vitest-environment jsdom
/**
 * Integration coverage for the Activity log's record-type ("action_type") chips:
 * selection wiring through the URL, live counts from the paginated server rows,
 * and the violet NEW markers on the highlighted types.
 *
 * Supabase and the router are stubbed so the whole filter -> query -> render
 * loop runs exactly as it does in the app, against fixture log rows.
 */
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

type Row = {
  id: string;
  action_type: string;
  message_sent: string | null;
  created_at: string;
  status: string | null;
  customer_id: string | null;
};

function row(id: string, action_type: string, minute: number, status: string | null = null): Row {
  return {
    id,
    action_type,
    message_sent: action_type === "quote_sms" ? "quote link sent" : null,
    created_at: `2026-08-06T10:${String(minute).padStart(2, "0")}:00.000Z`,
    status,
    customer_id: null,
  };
}

const FIXTURES: Row[] = [
  row("r1", "status_refresh", 59, "updated"),
  row("r2", "status_refresh", 58, "already_current"),
  row("r3", "status_refresh", 57, "failed"),
  row("r4", "automation_status_change", 56, "this-device"),
  row("r5", "automation_status_change", 55, "backend"),
  row("r6", "quote_sms", 54),
  row("r7", "invoice_sms", 53),
];

// --- Supabase stub: applies the pushed-down filters so counts are real ------
function makeBuilder(table: string) {
  const state: { types: string[] | null; lt: string | null; limit: number } = {
    types: null,
    lt: null,
    limit: 100,
  };
  const b: Record<string, unknown> = {
    select: () => b,
    order: () => b,
    limit: (n: number) => {
      state.limit = n;
      return b;
    },
    gte: () => b,
    lte: () => b,
    or: () => b,
    eq: () => b,
    lt: (_col: string, value: string) => {
      state.lt = value;
      return b;
    },
    in: (_col: string, values: string[]) => {
      state.types = values;
      return b;
    },
    returns: () => {
      let rows = table === "logs" ? [...FIXTURES] : [];
      if (state.types) rows = rows.filter((r) => state.types!.includes(r.action_type));
      if (state.lt) rows = rows.filter((r) => r.created_at < state.lt!);
      return Promise.resolve({ data: rows.slice(0, state.limit), error: null });
    },
  };
  return b;
}

vi.mock("@/integrations/supabase/client", () => ({
  supabase: { from: (table: string) => makeBuilder(table) },
}));

// --- Router stub: a tiny observable search-param store ---------------------
let searchState: Record<string, unknown> = {};
const subscribers = new Set<() => void>();

vi.mock("@tanstack/react-router", () => ({
  Link: ({ children }: { children?: React.ReactNode }) => React.createElement("a", null, children),
  useNavigate: () => (opts: { search?: unknown }) => {
    const next =
      typeof opts.search === "function"
        ? (opts.search as (p: Record<string, unknown>) => Record<string, unknown>)(searchState)
        : ((opts.search as Record<string, unknown>) ?? {});
    searchState = { ...next };
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

/** Finds a record-type chip by its rendered label. */
function chip(label: string) {
  return screen
    .getAllByRole("button")
    .find((el) => el.textContent?.includes(label) && el.hasAttribute("aria-pressed"))!;
}

beforeEach(() => {
  searchState = {};
});

afterEach(() => cleanup());

describe("Activity log record-type chips", () => {
  it("renders live counts from the loaded rows for each action_type", async () => {
    renderLog();

    await waitFor(() => expect(chip("STATUS_REFRESH")).toBeTruthy());
    await waitFor(() => expect(chip("STATUS_REFRESH").textContent).toMatch(/3$/));

    expect(chip("STATUS_CHANGE").textContent).toMatch(/2$/);
    expect(chip("QUOTE_SMS").textContent).toMatch(/1$/);
    // Types with no matching rows show no count badge at all.
    expect(chip("VOICEMAIL").textContent).not.toMatch(/\d/);
  });

  it("selects a chip, records it in the URL, and narrows counts to that type", async () => {
    const user = userEvent.setup();
    renderLog();
    await waitFor(() => expect(chip("STATUS_REFRESH").textContent).toMatch(/3$/));

    await user.click(chip("STATUS_REFRESH"));

    // Selection is pressed and persisted to ?logTypes=
    await waitFor(() => expect(chip("STATUS_REFRESH").getAttribute("aria-pressed")).toBe("true"));
    expect(searchState["logTypes"]).toBe("status_refresh");

    // The server query re-ran with the filter, so counts reflect only that type.
    await waitFor(() => expect(chip("STATUS_CHANGE").textContent).not.toMatch(/\d/));
    expect(chip("STATUS_REFRESH").textContent).toMatch(/3$/);
    expect(screen.getByText(/Clear 1 selected/i)).toBeTruthy();

    // Multi-select adds to the same param.
    await user.click(chip("STATUS_CHANGE"));
    await waitFor(() => expect(searchState["logTypes"]).toBe("status_refresh,automation_status_change"));
    await waitFor(() => expect(chip("STATUS_CHANGE").textContent).toMatch(/2$/));

    // Toggling off removes it again.
    await user.click(chip("STATUS_REFRESH"));
    await waitFor(() => expect(searchState["logTypes"]).toBe("automation_status_change"));
    expect(chip("STATUS_REFRESH").getAttribute("aria-pressed")).toBe("false");
  });

  it("shows violet New markers only on the highlighted types", async () => {
    const user = userEvent.setup();
    renderLog();
    await waitFor(() => expect(chip("STATUS_REFRESH")).toBeTruthy());

    for (const label of ["STATUS_REFRESH", "STATUS_CHANGE"]) {
      const marker = within(chip(label)).getByText("New");
      expect(marker.className).toContain("bg-primary/20");
      expect(marker.className).toContain("text-primary");
      expect(chip(label).className).toContain("border-primary/60");
    }

    // Non-highlighted types carry neither the marker nor the violet treatment.
    for (const label of ["QUOTE_SMS", "VOICEMAIL", "INVOICE_SMS"]) {
      expect(within(chip(label)).queryByText("New")).toBeNull();
      expect(chip(label).className).toContain("bg-muted");
    }

    // When selected, the marker switches to the on-violet paper variant.
    await user.click(chip("STATUS_REFRESH"));
    await waitFor(() => expect(chip("STATUS_REFRESH").getAttribute("aria-pressed")).toBe("true"));
    const selectedMarker = within(chip("STATUS_REFRESH")).getByText("New");
    expect(selectedMarker.className).toContain("bg-paper/20");
    expect(selectedMarker.className).toContain("text-paper");
  });
});

describe("Activity log row copy action", () => {
  it("copies a formatted dispatch line to the clipboard", async () => {
    const user = userEvent.setup();
    const writeText = vi.fn().mockResolvedValue(undefined);
    const original = Object.getOwnPropertyDescriptor(navigator, "clipboard");
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
      writable: true,
    });

    renderLog();
    await waitFor(() => expect(screen.getByText("quote link sent")).toBeTruthy());

    const copyBtn = screen.getAllByRole("button", { name: /Copy dispatch line/i })[0];
    expect(copyBtn).toBeTruthy();

    await user.click(copyBtn);

    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
    const copied = writeText.mock.calls[0][0] as string;
    expect(copied).toMatch(/quote link sent/);
    expect(copied).toMatch(/QUOTE_SMS/);
    expect(copied).toMatch(/\d{1,2}:\d{2}:\d{2}/);
  });
});
