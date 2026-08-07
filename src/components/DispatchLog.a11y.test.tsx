// @vitest-environment jsdom
/**
 * Accessibility integration coverage for the Activity log's record-type
 * ("action_type") chips:
 *
 * - roles/names: each chip is a real <button> with an accessible name and a
 *   descriptive title, grouped under a named "Record type" group.
 * - ARIA state: aria-pressed tracks selection, hydrates from a deep link, and
 *   flips back on deselect — so screen readers hear toggle state, not colour.
 * - keyboard: Tab reaches the chips in render order, Enter and Space toggle
 *   them, and the chip keeps focus after toggling so keyboard users don't lose
 *   their place while narrowing the log.
 *
 * Supabase and the router are stubbed, so the real component drives every
 * assertion.
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

const FIXTURES: Row[] = [
  {
    id: "r1",
    action_type: "quote_sms",
    message_sent: "quote link sent",
    created_at: "2026-08-06T10:10:00.000Z",
    status: null,
    customer_id: null,
  },
  {
    id: "r2",
    action_type: "invoice_sms",
    message_sent: "invoice link sent",
    created_at: "2026-08-06T10:09:00.000Z",
    status: null,
    customer_id: null,
  },
];

/** Action types the component pushed down on the latest query, for assertions. */
let lastTypes: string[] | null = null;

function makeBuilder(table: string) {
  const state: { types: string[] | null; limit: number } = { types: null, limit: 100 };
  const b: Record<string, unknown> = {
    select: () => b,
    order: () => b,
    limit: (n: number) => {
      state.limit = n;
      return b;
    },
    gte: () => b,
    lte: () => b,
    lt: () => b,
    gt: () => b,
    or: () => b,
    eq: () => b,
    in: (_col: string, values: string[]) => {
      state.types = values;
      return b;
    },
    returns: () => {
      lastTypes = state.types;
      let rows = table === "logs" ? [...FIXTURES] : [];
      if (state.types) rows = rows.filter((r) => state.types!.includes(r.action_type));
      return Promise.resolve({ data: rows.slice(0, state.limit), error: null });
    },
  };
  return b;
}

vi.mock("@/integrations/supabase/client", () => ({
  supabase: { from: (table: string) => makeBuilder(table) },
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

const { LOG_ACTION_FILTER_ORDER, logActionDescription } = await import("@/lib/log-action-presentation");
const { DispatchLog } = await import("./DispatchLog");

function renderLog() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <DispatchLog limit={25} />
    </QueryClientProvider>,
  );
}

/** The "Record type" fieldset that groups the action_type chips. */
function chipGroup(): HTMLElement {
  const legend = screen.getByText("Record type");
  return legend.closest("fieldset") as HTMLElement;
}

/** Every chip in the group, in DOM (tab) order. */
function chips(): HTMLElement[] {
  return within(chipGroup())
    .getAllByRole("button")
    .filter((el) => el.hasAttribute("aria-pressed"));
}

function chipByLabel(label: string): HTMLElement {
  const found = chips().find((el) => el.textContent?.includes(label));
  if (!found) throw new Error(`no chip labelled ${label}`);
  return found;
}

beforeEach(() => {
  searchState = {};
  lastTypes = null;
  window.localStorage.removeItem("temaro-activity-log-types");
});

afterEach(() => cleanup());

describe("action_type chips — roles and ARIA state", () => {
  it("exposes every chip as a named toggle button inside the Record type group", async () => {
    renderLog();
    await waitFor(() => expect(screen.getByText("quote link sent")).toBeTruthy());

    const all = chips();
    // One chip per whitelisted action type, in the canonical filter order.
    expect(all).toHaveLength(LOG_ACTION_FILTER_ORDER.length);

    for (const el of all) {
      // Real buttons: implicit role, keyboard-activatable, focusable.
      expect(el.tagName).toBe("BUTTON");
      expect(el.getAttribute("type")).toBe("button");
      // Non-empty accessible name, so it is announceable.
      expect((el.textContent ?? "").trim().length).toBeGreaterThan(0);
      // Unpressed by default — state is conveyed by ARIA, not just colour.
      expect(el.getAttribute("aria-pressed")).toBe("false");
    }

    // The group itself is named by its <legend>, so chips are announced in
    // context ("Record type ... group").
    expect(chipGroup().tagName).toBe("FIELDSET");
    expect(within(chipGroup()).getByText("Record type")).toBeTruthy();

    // Each chip carries a human-readable description as its title/tooltip.
    const first = LOG_ACTION_FILTER_ORDER[0]!;
    const firstTitle = chips()[0]!.getAttribute("title") ?? "";
    expect(firstTitle).toContain(logActionDescription(first));
  });

  it("flips aria-pressed on select and back on deselect", async () => {
    const user = userEvent.setup();
    renderLog();
    await waitFor(() => expect(screen.getByText("quote link sent")).toBeTruthy());

    const quote = chipByLabel("QUOTE_SMS");
    expect(quote.getAttribute("aria-pressed")).toBe("false");

    await user.click(quote);
    await waitFor(() => expect(chipByLabel("QUOTE_SMS").getAttribute("aria-pressed")).toBe("true"));
    // Every other chip stays unpressed — no ambiguous multi-state.
    expect(
      chips().filter((el) => el.getAttribute("aria-pressed") === "true"),
    ).toHaveLength(1);

    await user.click(chipByLabel("QUOTE_SMS"));
    await waitFor(() => expect(chipByLabel("QUOTE_SMS").getAttribute("aria-pressed")).toBe("false"));
  });

  it("hydrates aria-pressed from a deep-linked ?types= param", async () => {
    searchState = { types: "invoice_sms" };
    renderLog();

    await waitFor(() => expect(chipByLabel("INVOICE_SMS").getAttribute("aria-pressed")).toBe("true"));
    expect(chipByLabel("QUOTE_SMS").getAttribute("aria-pressed")).toBe("false");
    await waitFor(() => expect(lastTypes).toEqual(["invoice_sms"]));
  });
});

describe("action_type chips — keyboard navigation", () => {
  it("reaches the chips with Tab in render order", async () => {
    const user = userEvent.setup();
    renderLog();
    await waitFor(() => expect(screen.getByText("quote link sent")).toBeTruthy());

    const [first, second] = chips();
    first!.focus();
    expect(document.activeElement).toBe(first);

    await user.tab();
    expect(document.activeElement).toBe(second);

    await user.tab({ shift: true });
    expect(document.activeElement).toBe(first);
  });

  it("toggles a focused chip with Enter and with Space, keeping focus on it", async () => {
    const user = userEvent.setup();
    renderLog();
    await waitFor(() => expect(screen.getByText("quote link sent")).toBeTruthy());

    const quote = chipByLabel("QUOTE_SMS");
    quote.focus();

    await user.keyboard("{Enter}");
    await waitFor(() => expect(chipByLabel("QUOTE_SMS").getAttribute("aria-pressed")).toBe("true"));
    // Filter really applied, not just visually toggled.
    await waitFor(() => expect(lastTypes).toEqual(["quote_sms"]));
    // Focus stays put so keyboard users don't lose their position.
    expect(document.activeElement).toBe(chipByLabel("QUOTE_SMS"));

    await user.keyboard(" ");
    await waitFor(() => expect(chipByLabel("QUOTE_SMS").getAttribute("aria-pressed")).toBe("false"));
    expect(document.activeElement).toBe(chipByLabel("QUOTE_SMS"));
  });

  it("supports selecting multiple chips from the keyboard", async () => {
    const user = userEvent.setup();
    renderLog();
    await waitFor(() => expect(screen.getByText("quote link sent")).toBeTruthy());

    chipByLabel("QUOTE_SMS").focus();
    await user.keyboard("{Enter}");
    await waitFor(() => expect(chipByLabel("QUOTE_SMS").getAttribute("aria-pressed")).toBe("true"));

    chipByLabel("INVOICE_SMS").focus();
    await user.keyboard("{Enter}");

    await waitFor(() =>
      expect(chips().filter((el) => el.getAttribute("aria-pressed") === "true")).toHaveLength(2),
    );
    await waitFor(() => expect([...(lastTypes ?? [])].sort()).toEqual(["invoice_sms", "quote_sms"]));
  });
});
