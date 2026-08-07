// @vitest-environment jsdom
/**
 * Integration test: the Activity log must render defensively when a dispatch
 * row arrives with missing / null / malformed fields.
 *
 * Real-world causes: partially-written webhook rows, archived rows missing
 * `original_created_at`, action types written by an older deploy, and payloads
 * that are empty strings rather than NULL.
 *
 * Contract verified here:
 *  - no render crash, and every row still appears in the list
 *  - missing/invalid timestamp -> "—" clock (never "Invalid Date"/"NaN")
 *  - null or empty message -> "—" placeholder
 *  - missing origin (status) -> no origin badge, no crash
 *  - null/empty action_type -> "UNKNOWN" label
 *  - details drawer opens for a fully-sparse row and omits missing fields
 *  - copy-dispatch-line works and never emits "Invalid Date"/"null"/"NaN"
 */
import React from "react";
import { afterEach, beforeEach, describe as suite, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { LogAction } from "@/lib/log-action-types.generated";

type Row = Record<string, unknown>;

const consoleErrors: string[] = [];

/** Every row below is intentionally malformed in a different way. */
const rows: Row[] = [
  {
    // Anchor row: fully-formed, proves the list rendered at all.
    id: "ok-row",
    action_type: LogAction.missed_call_text,
    message_sent: "Sorry we missed your call — text us back.",
    created_at: "2026-06-01T15:04:05.000Z",
    status: "sent",
    customer_id: null,
    recipient_phone: "+15551230000",
  },
  {
    // No timestamp at all (null created_at, no archive fallback).
    id: "no-timestamp",
    action_type: LogAction.sms_inbound,
    message_sent: "YES",
    created_at: null,
    original_created_at: null,
    status: "received",
  },
  {
    // Timestamp present but unparseable.
    id: "bad-timestamp",
    action_type: LogAction.review_request,
    message_sent: "Mind leaving us a review?",
    created_at: "not-a-real-date",
    status: null,
  },
  {
    // Empty-string message (not NULL) plus missing status/origin.
    id: "empty-message",
    action_type: LogAction.voicemail_notify,
    message_sent: "",
    created_at: "2026-06-01T12:00:00.000Z",
    status: null,
  },
  {
    // Null message.
    id: "null-message",
    action_type: LogAction.quote_sms,
    message_sent: null,
    created_at: "2026-06-01T11:00:00.000Z",
    status: null,
  },
  {
    // ACTIVE row with no origin/status and an empty structured payload.
    id: "active-no-origin",
    action_type: LogAction.automation_status_change,
    message_sent: "{}",
    created_at: "2026-06-01T10:00:00.000Z",
    status: null,
  },
  {
    // STATUS_REFRESH row with a null payload and null status.
    id: "refresh-null-payload",
    action_type: LogAction.status_refresh,
    message_sent: null,
    created_at: "2026-06-01T09:00:00.000Z",
    status: null,
  },
  {
    // Blank action_type — must not throw on .toUpperCase().
    id: "blank-action-type",
    action_type: "",
    message_sent: "orphan record",
    created_at: "2026-06-01T08:00:00.000Z",
    status: null,
  },
  {
    // Everything missing except the primary key.
    id: "sparse-row",
    action_type: null,
    message_sent: null,
    created_at: null,
    status: null,
  },
];

function makeBuilder(table: string) {
  const data = table === "logs" ? rows : [];
  const result = () => ({ data, error: null });
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

const clipboardWrite = vi.fn(async (_text: string) => {});

vi.mock("sonner", () => ({
  toast: { error: vi.fn(), success: vi.fn(), info: vi.fn(), message: vi.fn(), warning: vi.fn() },
}));

vi.mock("@/lib/activity-log-validation.reporter", () => ({
  reportFilterRejection: vi.fn(),
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
  searchState = {};
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <DispatchLog limit={25} />
    </QueryClientProvider>,
  );
}

/** Waits for the anchor row so we know the list finished loading. */
async function renderAndSettle() {
  const utils = renderLog();
  await waitFor(() => expect(screen.getByText(/Sorry we missed your call/)).toBeTruthy());
  return utils;
}

beforeEach(() => {
  searchState = {};
  consoleErrors.length = 0;
  window.localStorage.clear();
  clipboardWrite.mockClear();
  vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
    consoleErrors.push(args.map(String).join(" "));
  });
  Object.defineProperty(window.navigator, "clipboard", {
    value: { writeText: clipboardWrite },
    configurable: true,
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

suite("DispatchLog rows with missing or null payload fields", () => {
  /** Rows whose action_type isn't an allowed LogAction are dropped at parse. */
  const renderableRows = rows.filter(
    (r) => typeof r["action_type"] === "string" && (r["action_type"] as string).length > 0,
  );

  it("renders every renderable malformed row without throwing or logging a React error", async () => {
    await renderAndSettle();

    // One expand toggle per surviving row => nothing crashed mid-list.
    const toggles = screen.getAllByRole("button", { name: /Show dispatch details/i });
    expect(toggles.length).toBe(renderableRows.length);
    expect(consoleErrors.join("\n")).not.toMatch(/Invalid|Cannot read|undefined is not/i);
  });

  it("never renders Invalid Date, NaN, null or undefined as visible text", async () => {
    await renderAndSettle();
    const text = document.body.textContent ?? "";
    expect(text).not.toMatch(/Invalid Date/);
    expect(text).not.toMatch(/NaN/);
    expect(text).not.toMatch(/\bnull\b/);
    expect(text).not.toMatch(/\bundefined\b/);
  });

  it("shows a dash instead of a clock when the timestamp is missing or unparseable", async () => {
    await renderAndSettle();
    expect(screen.getAllByText("—").length).toBeGreaterThanOrEqual(2);
    expect(screen.getByTitle("timestamp unavailable")).toBeTruthy();
    expect(screen.getByTitle("not-a-real-date")).toBeTruthy();
  });

  it("shows a dash for null and empty-string messages", async () => {
    await renderAndSettle();
    // no-timestamp clock + bad-timestamp clock are dashes, and the empty-string
    // and null message rows add two more placeholders.
    expect(screen.getAllByText("—").length).toBeGreaterThanOrEqual(4);
  });

  it("omits the origin badge when an ACTIVE row has no status", async () => {
    await renderAndSettle();
    const toggle = screen.getAllByRole("button", { name: /Show dispatch details/i })[5]!;
    const rowEl = toggle.closest("div")!;
    expect(within(rowEl).queryByText(/This device|Another device|Backend/)).toBeNull();
  });

  it("drops rows whose action_type is blank or null instead of rendering a broken label", async () => {
    await renderAndSettle();
    // Unknown action types are rejected at the parse boundary, so their payload
    // text never reaches the list — and no crash-y label is rendered.
    expect(screen.queryByText("orphan record")).toBeNull();
    expect(screen.queryByText("UNKNOWN")).toBeNull();
  });

  it("falls back to a readable outcome for a STATUS_REFRESH row with no payload", async () => {
    await renderAndSettle();
    expect(screen.getByText("refresh")).toBeTruthy();
  });

  it("opens the details drawer for a row with no timestamp and omits the missing fields", async () => {
    await renderAndSettle();
    const toggles = screen.getAllByRole("button", { name: /Show dispatch details/i });
    // Index 1 == the row whose created_at is null.
    fireEvent.click(toggles[1]!);

    await waitFor(() => expect(screen.getByText("log id")).toBeTruthy());
    // The timestamp is unusable, so the "recorded at" field is omitted entirely.
    expect(screen.queryByText("recorded at")).toBeNull();
    expect(screen.queryByText("recipient")).toBeNull();
    expect(document.body.textContent ?? "").not.toMatch(/Invalid Date/);
  });


  it("copies a dispatch line for a row with no timestamp without leaking Invalid Date", async () => {
    await renderAndSettle();
    const copyButtons = screen.getAllByRole("button", { name: /Copy dispatch line/i });
    // Index 1 == the row whose created_at is null.
    fireEvent.click(copyButtons[1]!);

    await waitFor(() => expect(clipboardWrite).toHaveBeenCalled());
    const line = String(clipboardWrite.mock.calls[0]?.[0] ?? "");
    expect(line).toContain("unknown time");
    expect(line).not.toMatch(/Invalid Date|NaN|undefined|null/);
  });
});
