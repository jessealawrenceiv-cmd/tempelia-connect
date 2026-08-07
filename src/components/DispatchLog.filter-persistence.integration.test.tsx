// @vitest-environment jsdom
/**
 * Integration test: Activity log filters must survive leaving the page and
 * coming back.
 *
 * Filters live in the URL (?logTypes, ?q, ?logCustomer, ?dateFrom/?dateTo,
 * ?logSort, ?logScope, ?logFailed, ?logStatusOnly, ?logOrigin), and the
 * record-type selection is additionally mirrored into localStorage so a fresh
 * visit without params reopens the last-used view. This test drives the real
 * component through the full loop:
 *
 *   set filters -> unmount (navigate away) -> remount (come back)
 *
 * and asserts nothing resets unexpectedly: the controls rehydrate, the query
 * pushed down to Postgres carries the same filters, and editing one filter
 * never clears the others.
 */
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

type Op = { fn: string; args: unknown[] };
type Recorded = { table: string; order: unknown[]; ops: Op[] };

/** Every logs/logs_archive query issued, in order. */
let recorded: Recorded[] = [];

const ROWS = [
  {
    id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    action_type: "quote_sms",
    message_sent: "quote link sent",
    created_at: "2026-08-05T10:00:00.000Z",
    status: "sent",
    customer_id: null,
    recipient_phone: "+14155550111",
  },
];

function makeBuilder(table: string) {
  const isLogs = table === "logs" || table === "logs_archive";
  const entry: Recorded = { table, order: [], ops: [] };
  if (isLogs) recorded.push(entry);

  const b: Record<string, unknown> = {
    select: () => b,
    order: (...args: unknown[]) => {
      entry.order = args;
      return b;
    },
    limit: () => b,
    returns: () => Promise.resolve({ data: isLogs ? ROWS : [], error: null }),
    then: (resolve: (v: unknown) => unknown) => resolve({ data: [], error: null }),
  };
  for (const fn of ["gte", "lte", "lt", "gt", "eq", "in", "or"]) {
    b[fn] = (...args: unknown[]) => {
      entry.ops.push({ fn, args });
      return b;
    };
  }
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

// --- Router stub: the search-param store stands in for the URL and, like the
// real address bar, survives unmounting the component. ----------------------
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

const TYPES_STORAGE_KEY = "temaro-activity-log-types";

function renderLog() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <DispatchLog limit={25} />
    </QueryClientProvider>,
  );
}

/** Leaves the page and comes back — the URL store persists, React state does not. */
async function navigateAwayAndBack() {
  cleanup();
  recorded = [];
  renderLog();
  await waitFor(() => expect(screen.getByLabelText(/Search activity by phone number/i)).toBeTruthy());
}

const searchBox = () => screen.getByLabelText(/Search activity by phone number/i) as HTMLInputElement;
const contactBox = () =>
  screen.getByLabelText(/Filter activity by customer phone number or customer ID/i) as HTMLInputElement;
const typePicker = () => screen.getByLabelText("Add a record type filter") as HTMLSelectElement;
const sortButton = (name: RegExp) => screen.getByRole("button", { name });

function chip(label: string) {
  return screen
    .getAllByRole("button")
    .find((el) => el.textContent?.includes(label) && el.hasAttribute("aria-pressed"))!;
}

/** The most recent logs query, i.e. the one the visible list was built from. */
const lastLogQuery = () => recorded[recorded.length - 1]!;
const opArgs = (fn: string, col: string) =>
  lastLogQuery()
    .ops.filter((o) => o.fn === fn && o.args[0] === col)
    .map((o) => o.args[1]);

beforeEach(() => {
  searchState = {};
  recorded = [];
  window.localStorage.clear();
});

afterEach(() => cleanup());

describe("Activity log — filters persist across navigation", () => {
  it("restores record types, search text, contact filter, sort and date range after leaving and returning", async () => {
    const user = userEvent.setup();
    // A date range is already in the URL, as it would be after using the picker.
    searchState = { dateFrom: "2026-08-01", dateTo: "2026-08-06" };
    renderLog();
    await waitFor(() => expect(chip("QUOTE_SMS")).toBeTruthy());

    await user.selectOptions(typePicker(), "quote_sms");
    await user.type(searchBox(), "roof");
    await user.type(contactBox(), "+14155550111");
    await user.click(sortButton(/oldest/i));

    await waitFor(() => expect(searchState["logTypes"]).toBe("quote_sms"));
    await waitFor(() => expect(searchState["q"]).toBe("roof"));
    await waitFor(() => expect(searchState["logCustomer"]).toBe("+14155550111"));
    expect(searchState["logSort"]).toBe("oldest");
    // Setting the later filters did not drop the date range already in the URL.
    expect(searchState["dateFrom"]).toBe("2026-08-01");
    expect(searchState["dateTo"]).toBe("2026-08-06");

    const before = { ...searchState };
    await navigateAwayAndBack();

    // Nothing was rewritten on the way back in.
    expect(searchState).toEqual(before);

    // Every control shows the restored value.
    await waitFor(() => expect(chip("QUOTE_SMS").getAttribute("aria-pressed")).toBe("true"));
    expect(searchBox().value).toBe("roof");
    expect(contactBox().value).toBe("+14155550111");
    expect(sortButton(/oldest/i).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByLabelText(/^Date range: /)).toBeTruthy();

    // …and the query behind the list still carries all of them.
    await waitFor(() => expect(recorded.length).toBeGreaterThan(0));
    expect(lastLogQuery().table).toBe("logs");
    expect(opArgs("in", "action_type")).toEqual([["quote_sms"]]);
    expect(lastLogQuery().order[1]).toMatchObject({ ascending: true });
    expect(opArgs("gte", "created_at")).toHaveLength(1);
    expect(opArgs("lte", "created_at")).toHaveLength(1);
    expect(lastLogQuery().ops.some((o) => o.fn === "or")).toBe(true);
  });

  it("keeps the archive scope and the toggle filters after leaving and returning", async () => {
    searchState = { logScope: "archive", logFailed: "1", logStatusOnly: "1", logOrigin: "backend" };
    renderLog();
    await waitFor(() => expect(recorded.length).toBeGreaterThan(0));
    expect(lastLogQuery().table).toBe("logs_archive");

    await navigateAwayAndBack();

    expect(searchState).toEqual({
      logScope: "archive",
      logFailed: "1",
      logStatusOnly: "1",
      logOrigin: "backend",
    });
    await waitFor(() => expect(recorded.length).toBeGreaterThan(0));
    expect(lastLogQuery().table).toBe("logs_archive");
    expect(screen.getByRole("button", { name: /archive/i }).getAttribute("aria-pressed")).toBe("true");
  });

  it("reopens the last-used record types from storage when returning without ?logTypes", async () => {
    const user = userEvent.setup();
    renderLog();
    await waitFor(() => expect(chip("QUOTE_SMS")).toBeTruthy());
    await user.selectOptions(typePicker(), "quote_sms");
    await waitFor(() => expect(searchState["logTypes"]).toBe("quote_sms"));
    expect(JSON.parse(window.localStorage.getItem(TYPES_STORAGE_KEY) ?? "[]")).toEqual(["quote_sms"]);

    // Returning through a plain nav link, i.e. no filter params in the URL.
    searchState = {};
    await navigateAwayAndBack();

    await waitFor(() => expect(searchState["logTypes"]).toBe("quote_sms"));
    await waitFor(() => expect(chip("QUOTE_SMS").getAttribute("aria-pressed")).toBe("true"));
    await waitFor(() => expect(opArgs("in", "action_type")).toEqual([["quote_sms"]]));
  });

  it("lets the URL win over stored record types", async () => {
    window.localStorage.setItem(TYPES_STORAGE_KEY, JSON.stringify(["quote_sms"]));
    searchState = { logTypes: "invoice_sms" };
    renderLog();

    await waitFor(() => expect(chip("INVOICE_SMS").getAttribute("aria-pressed")).toBe("true"));
    expect(chip("QUOTE_SMS").getAttribute("aria-pressed")).toBe("false");
    expect(searchState["logTypes"]).toBe("invoice_sms");
    await waitFor(() => expect(opArgs("in", "action_type")).toEqual([["invoice_sms"]]));
  });

  it("clears everything only when the user asks, and the cleared state also persists", async () => {
    const user = userEvent.setup();
    searchState = { logTypes: "quote_sms", q: "roof", dateFrom: "2026-08-01", dateTo: "2026-08-06" };
    renderLog();
    await waitFor(() => expect(chip("QUOTE_SMS").getAttribute("aria-pressed")).toBe("true"));

    await user.click(screen.getByLabelText("Clear all filters and reset sort"));

    await waitFor(() => expect(searchState["logTypes"]).toBeUndefined());
    expect(searchState["q"]).toBeUndefined();
    expect(searchState["dateFrom"]).toBeUndefined();
    expect(searchState["dateTo"]).toBeUndefined();

    await navigateAwayAndBack();

    // A cleared view stays cleared — storage does not resurrect the old types.
    expect(searchState["logTypes"]).toBeUndefined();
    expect(searchBox().value).toBe("");
    await waitFor(() => expect(chip("QUOTE_SMS").getAttribute("aria-pressed")).toBe("false"));
  });
});
