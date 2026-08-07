// @vitest-environment jsdom
/**
 * Deep linking one Activity log dispatch (?logId=<uuid>).
 *
 * A shared link must open the exact record it points at, with its details drawer
 * already expanded — even when the recipient's filters or scope exclude that row.
 * In that case the row is looked up by id alone and pinned above the list.
 *
 * The per-row link button is the other half of the contract: it writes the id
 * into the URL and copies an absolute link back to the same view.
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
  recipient_phone?: string | null;
};

let FIXTURES: Row[] = [];
/** Rows only reachable by id (outside the current filtered view). */
let BY_ID: Row[] = [];

function makeBuilder(table: string) {
  const state: { id: string | null; limit: number } = { id: null, limit: 100 };
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
    in: () => b,
    eq: (col: string, value: string) => {
      if (col === "id") state.id = value;
      return b;
    },
    returns: () => {
      if (table !== "logs" && table !== "logs_archive") {
        return Promise.resolve({ data: [], error: null });
      }
      if (state.id) {
        const pool = table === "logs" ? [...FIXTURES, ...BY_ID] : [];
        return Promise.resolve({ data: pool.filter((r) => r.id === state.id), error: null });
      }
      const rows = table === "logs" ? [...FIXTURES] : [];
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

const clipboard: string[] = [];
Object.assign(navigator, {
  clipboard: {
    writeText: (text: string) => {
      clipboard.push(text);
      return Promise.resolve();
    },
  },
});

const { LogAction } = await import("@/lib/log-action-types");
const { DispatchLog } = await import("./DispatchLog");

const VISIBLE_ID = "11111111-1111-4111-8111-111111111111";
const HIDDEN_ID = "22222222-2222-4222-8222-222222222222";

function row(id: string, message: string): Row {
  return {
    id,
    action_type: LogAction.opt_in_prompt,
    message_sent: message,
    created_at: "2026-08-06T15:04:05.000Z",
    status: "sent",
    customer_id: null,
    recipient_phone: "+14155550123",
  };
}

function renderLog() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <DispatchLog limit={100} />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  searchState = {};
  clipboard.length = 0;
  window.localStorage.clear();
  FIXTURES = [row(VISIBLE_ID, "prompt in the current view")];
  BY_ID = [row(HIDDEN_ID, "prompt outside the current view")];
});

afterEach(() => cleanup());

describe("Activity log — dispatch deep links", () => {
  it("opens the details drawer for a linked row that is in the list", async () => {
    searchState = { logId: VISIBLE_ID };
    renderLog();

    await waitFor(() => expect(screen.getByText("1 loaded")).toBeTruthy());
    const rowEl = document.getElementById(`log-row-${VISIBLE_ID}`);
    expect(rowEl).toBeTruthy();
    // Details drawer is expanded without the user clicking anything.
    await waitFor(() => expect(document.getElementById(`log-details-${VISIBLE_ID}`)).toBeTruthy());
    expect(within(rowEl as HTMLElement).getByText(VISIBLE_ID)).toBeTruthy();
    // And the shared row is visually marked.
    expect(rowEl?.getAttribute("data-shared")).toBe("true");
  });

  it("pins and expands a linked row the current view excludes", async () => {
    searchState = { logId: HIDDEN_ID };
    renderLog();

    await waitFor(() => expect(screen.getByText("Shared dispatch")).toBeTruthy());
    await waitFor(() => expect(document.getElementById(`log-details-${HIDDEN_ID}`)).toBeTruthy());
    expect(screen.getAllByText("prompt outside the current view").length).toBeGreaterThan(0);
  });

  it("explains when a linked dispatch can't be read", async () => {
    BY_ID = [];
    searchState = { logId: HIDDEN_ID };
    renderLog();

    await waitFor(() =>
      expect(screen.getByText(/no longer available, or you don’t have access/i)).toBeTruthy(),
    );
  });

  it("clears the deep link from the URL", async () => {
    searchState = { logId: HIDDEN_ID };
    renderLog();
    await waitFor(() => expect(screen.getByText("Shared dispatch")).toBeTruthy());

    await userEvent.click(screen.getByRole("button", { name: "Clear" }));
    await waitFor(() => expect(searchState['logId']).toBeUndefined());
    expect(screen.queryByText("Shared dispatch")).toBeNull();
  });

  it("copies an absolute link and records the id in the URL", async () => {
    renderLog();
    await waitFor(() => expect(screen.getByText("1 loaded")).toBeTruthy());

    await userEvent.click(screen.getByRole("button", { name: "Copy link to this dispatch" }));
    await waitFor(() => expect(searchState['logId']).toBe(VISIBLE_ID));
    expect(clipboard).toHaveLength(1);
    const copied = new URL(clipboard[0]!);
    expect(copied.searchParams.get("logId")).toBe(VISIBLE_ID);
    // Clicking the link button also opens that row's details.
    await waitFor(() => expect(document.getElementById(`log-details-${VISIBLE_ID}`)).toBeTruthy());
  });
});
