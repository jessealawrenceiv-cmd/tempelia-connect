// @vitest-environment jsdom
/**
 * Integration test: the CSV export must describe exactly the same result set as
 * the on-screen Activity log.
 *
 * A recording supabase stub captures every filter pushed down to Postgres, so
 * the test can compare the list query against the export query op-for-op and
 * assert three things:
 *
 * 1. Same table, same time column, same sort, same filters (dates, record
 *    types, free-text search, contact filter) — only the row limit differs.
 * 2. The downloaded file carries the expected header columns and one line per
 *    matching record, with contact name/phone resolved.
 * 3. The export is capped at EXPORT_ROW_CAP rows and says so when it hits it.
 */
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { EXPORT_ROW_CAP } from "@/lib/activity-log-csv";

const PAGE = 25;

type Op = { fn: string; args: unknown[] };
type Recorded = { table: string; select: string; order: unknown[]; limit: number; ops: Op[] };

const recorded: Recorded[] = [];

/** Log rows the stubbed Data API "contains". */
let logRows: Record<string, unknown>[] = [];

const CONTACTS = [
  { id: "c1", first_name: "Dana", phone_number: "+14155550111" },
  { id: "c2", first_name: "Milo", phone_number: "+14155550222" },
];

function makeBuilder(table: string) {
  const entry: Recorded = { table, select: "", order: [], limit: Infinity, ops: [] };
  const isLogs = table === "logs" || table === "logs_archive";
  if (isLogs) recorded.push(entry);

  const rowsFor = () => {
    if (!isLogs) return CONTACTS;
    return logRows.slice(0, Number.isFinite(entry.limit) ? entry.limit : undefined);
  };

  const b: Record<string, unknown> = {
    select: (cols: string) => {
      entry.select = cols;
      return b;
    },
    order: (...args: unknown[]) => {
      entry.order = args;
      return b;
    },
    limit: (n: number) => {
      entry.limit = n;
      return b;
    },
    returns: () => Promise.resolve({ data: rowsFor(), error: null }),
    // Awaiting the builder directly (contact lookup path) resolves the same way.
    then: (resolve: (v: unknown) => unknown) => resolve({ data: rowsFor(), error: null }),
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

const toastSuccess = vi.fn();
const toastInfo = vi.fn();
vi.mock("sonner", () => ({
  toast: {
    error: vi.fn(),
    success: (...a: unknown[]) => toastSuccess(...a),
    info: (...a: unknown[]) => toastInfo(...a),
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

let downloaded: string | null = null;

function row(i: number) {
  return {
    id: `r${i}`,
    action_type: i % 2 === 0 ? "quote_sms" : "missed_call_text",
    message_sent: `roof job ${i}`,
    created_at: new Date(Date.UTC(2026, 5, 1, 12, 0, i % 60)).toISOString(),
    status: "sent",
    customer_id: i % 2 === 0 ? "c1" : "c2",
    recipient_phone: "+14155550999",
  };
}

function renderLog() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <DispatchLog limit={PAGE} />
    </QueryClientProvider>,
  );
}

/** Ops are order-independent for comparison purposes. */
const opKey = (o: Op) => `${o.fn}(${JSON.stringify(o.args)})`;
const sortedOps = (r: Recorded) => r.ops.map(opKey).sort();

beforeEach(() => {
  recorded.length = 0;
  downloaded = null;
  toastSuccess.mockClear();
  toastInfo.mockClear();
  logRows = Array.from({ length: 3 }, (_, i) => row(i));
  searchState = {};
  window.localStorage.removeItem("temaro-activity-log-types");
  Object.defineProperty(URL, "createObjectURL", {
    value: (blob: Blob) => {
      // Capture the file bytes the user would receive.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const parts = (blob as any)._parts ?? null;
      void parts;
      return "blob:captured";
    },
    writable: true,
    configurable: true,
  });
  Object.defineProperty(URL, "revokeObjectURL", { value: () => {}, writable: true, configurable: true });
  // jsdom Blob supports text(); intercept construction to keep a copy.
  const RealBlob = globalThis.Blob;
  vi.stubGlobal(
    "Blob",
    class extends RealBlob {
      constructor(parts: BlobPart[], options?: BlobPropertyBag) {
        super(parts, options);
        downloaded = parts.map(String).join("");
      }
    },
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

async function exportNow(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("button", { name: /Export/i }));
  await waitFor(() => expect(downloaded).toBeTruthy());
}

describe("CSV export mirrors the Activity log filters", () => {
  it("pushes the identical filter set down to Postgres, differing only in row limit", async () => {
    // Filters arrive from the URL exactly as a shared log link would carry them.
    searchState = { logTypes: "quote_sms,missed_call_text", logSort: "oldest", q: "roof" };
    const user = userEvent.setup();
    renderLog();
    await waitFor(() => expect(screen.getByText("roof job 0")).toBeTruthy());

    const listQuery = recorded.filter((r) => r.limit === PAGE).at(-1)!;
    await exportNow(user);
    const exportQuery = recorded.filter((r) => r.limit === EXPORT_ROW_CAP).at(-1)!;

    expect(exportQuery.table).toBe(listQuery.table);
    expect(exportQuery.select).toBe(listQuery.select);
    expect(exportQuery.order).toEqual(listQuery.order);
    // Same sort direction the list is showing.
    expect(listQuery.order[1]).toMatchObject({ ascending: true });
    expect(sortedOps(exportQuery)).toEqual(sortedOps(listQuery));
    // The chosen record types and the search term are both in the pushed-down set.
    expect(sortedOps(exportQuery).join(" ")).toContain("missed_call_text");
    expect(sortedOps(exportQuery).join(" ")).toContain("roof");
    // Only the page size differs, and the export starts from no cursor.
    expect(exportQuery.limit).toBe(EXPORT_ROW_CAP);
    expect(exportQuery.ops.some((o) => o.fn === "lt" || o.fn === "gt")).toBe(false);
  });

  it("carries date range and contact filters into the export query", async () => {
    const user = userEvent.setup();
    renderLog();
    await waitFor(() => expect(screen.getByText("roof job 0")).toBeTruthy());

    // Contact filter: an exact customer id must become an eq(customer_id) clause.
    const contactInput = screen.getByPlaceholderText(/Contact phone or ID/i);
    await user.type(contactInput, "c1c1c1c1-1111-4111-8111-111111111111");
    await waitFor(() =>
      expect(
        recorded.some((r) =>
          r.ops.some(
            (o) => o.fn === "eq" && o.args[0] === "customer_id",
          ),
        ),
      ).toBe(true),
    );

    const listQuery = recorded.filter((r) => r.limit === PAGE).at(-1)!;
    await exportNow(user);
    const exportQuery = recorded.filter((r) => r.limit === EXPORT_ROW_CAP).at(-1)!;
    expect(sortedOps(exportQuery)).toEqual(sortedOps(listQuery));
    expect(exportQuery.ops).toEqual(
      expect.arrayContaining([
        { fn: "eq", args: ["customer_id", "c1c1c1c1-1111-4111-8111-111111111111"] },
      ]),
    );
  });

  it("writes the expected columns and one row per matching record", async () => {
    const user = userEvent.setup();
    renderLog();
    await waitFor(() => expect(screen.getByText("roof job 0")).toBeTruthy());
    await exportNow(user);

    const lines = downloaded!.replace(/^\uFEFF/, "").split("\r\n");
    expect(lines[0]).toBe(
      [
        "timestamp_utc",
        "timestamp_local",
        "action_type",
        "label",
        "status",
        "message",
        "customer_id",
        "customer_first_name",
        "customer_phone_number",
      ].join(","),
    );
    expect(lines).toHaveLength(1 + logRows.length);
    // Contact name and number are resolved from the customers lookup.
    expect(lines[1]).toContain("Dana");
    expect(lines[1]).toContain("+14155550111");
    expect(lines[2]).toContain("Milo");
    expect(toastSuccess).toHaveBeenCalledWith(expect.stringContaining("Exported 3 records"));
  });

  it("caps the export at EXPORT_ROW_CAP rows and says so", async () => {
    logRows = Array.from({ length: EXPORT_ROW_CAP + 250 }, (_, i) => row(i));
    const user = userEvent.setup();
    renderLog();
    await waitFor(() => expect(screen.getByText("roof job 0")).toBeTruthy());
    await exportNow(user);

    const lines = downloaded!.replace(/^\uFEFF/, "").split("\r\n");
    expect(lines).toHaveLength(1 + EXPORT_ROW_CAP);
    expect(toastSuccess).toHaveBeenCalledWith(
      expect.stringContaining(`first ${EXPORT_ROW_CAP} matching records`),
    );
  });

  it("does not download anything when no records match", async () => {
    logRows = [];
    const user = userEvent.setup();
    renderLog();
    await waitFor(() => expect(recorded.length).toBeGreaterThan(0));
    await user.click(screen.getByRole("button", { name: /Export/i }));

    await waitFor(() => expect(toastInfo).toHaveBeenCalled());
    expect(downloaded).toBeNull();
    expect(toastSuccess).not.toHaveBeenCalled();
  });
});
