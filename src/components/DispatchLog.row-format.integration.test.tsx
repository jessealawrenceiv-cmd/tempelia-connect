// @vitest-environment jsdom
/**
 * UI integration test: every Activity log row must render its timestamp and
 * dispatch message correctly.
 *
 * Timestamps  -> local HH:MM:SS (locale time, seconds included)
 * Plain rows  -> message_sent verbatim
 * Missing text-> em dash placeholder
 * Structured  -> STATUS_REFRESH / ACTIVE payload JSON rendered as readable text
 * Copy line   -> full date + label + description (+ origin, affected)
 */
import React from "react";
import { afterEach, beforeEach, describe as suite, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { LogAction } from "@/lib/log-action-types.generated";
import { logActionLabel } from "@/lib/log-action-presentation";

type Row = {
  id: string;
  action_type: string;
  message_sent: string | null;
  created_at: string;
  status: string | null;
  customer_id: string | null;
  recipient_phone: string | null;
};

const AT = "2026-06-01T15:04:05.000Z";

/** Expected on-row clock text, computed the same way the component does. */
function expectedClock(iso: string): string {
  return new Date(iso).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

const rows: Row[] = [
  {
    id: "r-plain",
    action_type: LogAction.missed_call_text,
    message_sent: "Sorry we missed your call — text us back and we'll reply.",
    created_at: AT,
    status: "sent",
    customer_id: null,
    recipient_phone: "+15551230000",
  },
  {
    id: "r-empty",
    action_type: LogAction.missed_call_text,
    message_sent: null,
    created_at: "2026-06-01T09:00:01.000Z",
    status: "failed",
    customer_id: null,
    recipient_phone: null,
  },
  {
    id: "r-refresh-ok",
    action_type: LogAction.status_refresh,
    message_sent: JSON.stringify({ duration_ms: 412 }),
    created_at: "2026-06-01T08:30:00.000Z",
    status: "updated",
    customer_id: null,
    recipient_phone: null,
  },
  {
    id: "r-refresh-fail",
    action_type: LogAction.status_refresh,
    message_sent: JSON.stringify({ error_code: "TIMEOUT", error: "upstream timed out" }),
    created_at: "2026-06-01T08:00:00.000Z",
    status: "failed",
    customer_id: null,
    recipient_phone: null,
  },
  {
    id: "r-refresh-bad-json",
    action_type: LogAction.status_refresh,
    message_sent: "not-json-at-all",
    created_at: "2026-06-01T07:45:00.000Z",
    status: "updated",
    customer_id: null,
    recipient_phone: null,
  },
  {
    id: "r-active",
    action_type: LogAction.automation_status_change,
    message_sent: JSON.stringify({ changes: ["missed-call ON", "reviews OFF"], trigger: "manual" }),
    created_at: "2026-06-01T07:00:00.000Z",
    status: "other-device",
    customer_id: null,
    recipient_phone: null,
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

beforeEach(() => {
  searchState = {};
  window.localStorage.clear();
  clipboardWrite.mockClear();
  Object.defineProperty(window.navigator, "clipboard", {
    value: { writeText: clipboardWrite },
    configurable: true,
  });
});

afterEach(() => cleanup());

suite("DispatchLog row timestamp and message formatting", () => {
  it("renders each row's timestamp as local HH:MM:SS", async () => {
    renderLog();
    await waitFor(() => expect(screen.getByText(rows[0]!.message_sent!)).toBeTruthy());

    for (const row of rows) {
      const clock = expectedClock(row.created_at);
      expect(clock).toMatch(/\d{1,2}:\d{2}:\d{2}/);
      expect(screen.getAllByText(clock).length).toBeGreaterThan(0);
    }
  });

  it("renders plain rows with their message text verbatim", async () => {
    renderLog();
    await waitFor(() => expect(screen.getByText(rows[0]!.message_sent!)).toBeTruthy());
    // Raw JSON is never leaked for structured rows.
    expect(screen.queryByText(/"duration_ms"/)).toBeNull();
    expect(screen.queryByText(/"changes"/)).toBeNull();
  });

  it("falls back to an em dash when a row has no message text", async () => {
    renderLog();
    await waitFor(() => expect(screen.getByText("—")).toBeTruthy());
  });

  it("renders STATUS_REFRESH payloads as readable outcome text", async () => {
    renderLog();
    await waitFor(() => expect(screen.getByText(/statuses updated — 412ms/)).toBeTruthy());
    expect(screen.getByText(/refresh failed — TIMEOUT — upstream timed out/)).toBeTruthy();
  });

  it("falls back to the raw text when a structured payload is not valid JSON", async () => {
    renderLog();
    await waitFor(() => expect(screen.getByText("not-json-at-all")).toBeTruthy());
  });

  it("renders ACTIVE changes joined with a middot plus the trigger and origin badge", async () => {
    renderLog();
    await waitFor(() => expect(screen.getByText(rows[0]!.message_sent!)).toBeTruthy());
    expect(screen.getByText("missed-call ON · reviews OFF — manual")).toBeTruthy();
    // Origin badge on the row (the origin quick-filter chip shares the label).
    expect(screen.getAllByText(/Another device/i).length).toBeGreaterThan(1);
  });

  it("labels every row with its action type", async () => {
    renderLog();
    await waitFor(() => expect(screen.getByText(rows[0]!.message_sent!)).toBeTruthy());
    for (const type of new Set(rows.map((r) => r.action_type))) {
      expect(screen.getAllByText(logActionLabel(type)).length).toBeGreaterThan(0);
    }
  });

  it("copies a full dispatch line with date, label and description", async () => {
    renderLog();
    await waitFor(() => expect(screen.getByText(rows[0]!.message_sent!)).toBeTruthy());

    const copyButtons = screen.getAllByRole("button", { name: /Copy dispatch line/i });
    // fireEvent, not userEvent: userEvent.setup() swaps in its own clipboard stub.
    fireEvent.click(copyButtons[0]!);

    await waitFor(() => expect(clipboardWrite).toHaveBeenCalled());
    const line = String(clipboardWrite.mock.calls[0]?.[0] ?? "");
    expect(line).toContain(logActionLabel(rows[0]!.action_type));
    expect(line).toContain(rows[0]!.message_sent!);
    // Full timestamp (not just the clock) with seconds.
    expect(line).toMatch(/\d{1,2}:\d{2}:\d{2}/);
    expect(line).toContain("2026");
  });
});
