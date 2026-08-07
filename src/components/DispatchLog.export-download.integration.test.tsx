// @vitest-environment jsdom
/**
 * End-to-end check of the Export CSV button: clicks it, captures the Blob that
 * would have been downloaded, and asserts the file matches what the list view
 * shows — header row, ISO + local timestamps, and phone numbers (contact on
 * file, with the record's recipient number as the fallback).
 */
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { logActionLabel } from "@/lib/log-action-presentation";

const PAGE = 25;

const CUST_A = "11111111-1111-4111-8111-111111111111";
const CUST_GONE = "22222222-2222-4222-8222-222222222222";

const ROWS = [
  {
    id: "r1",
    action_type: "quote_sms",
    message_sent: "Quote #1 sent, total $450",
    created_at: "2026-06-01T12:34:56.000Z",
    status: "sent",
    customer_id: CUST_A,
    recipient_phone: "+15550001111",
  },
  {
    // Contact row is gone: the export must fall back to recipient_phone.
    id: "r2",
    action_type: "missed_call_autotext",
    message_sent: 'Missed call, "auto-text" fired',
    created_at: "2026-06-02T00:05:00.000Z",
    status: "sent",
    customer_id: CUST_GONE,
    recipient_phone: "+15550002222",
  },
  {
    // No contact at all: phone and name cells stay empty, not "null".
    id: "r3",
    action_type: "review_request",
    message_sent: null,
    created_at: "2026-06-03T18:00:00.000Z",
    status: "failed",
    customer_id: null,
    recipient_phone: null,
  },
];

const CONTACTS = [{ id: CUST_A, first_name: "Dana", phone_number: "+15551234567" }];

function makeBuilder(table: string) {
  const result =
    table === "customers"
      ? { data: CONTACTS, error: null }
      : table === "logs"
        ? { data: ROWS, error: null }
        : { data: [], error: null };
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
    returns: () => Promise.resolve(result),
    // customers lookup awaits the builder itself (no .returns()).
    then: (onFulfilled: (v: unknown) => unknown) => Promise.resolve(result).then(onFulfilled),
  };
  return b;
}

vi.mock("@/integrations/supabase/client", () => ({
  supabase: { from: (table: string) => makeBuilder(table) },
}));

vi.mock("sonner", () => ({
  toast: { error: vi.fn(), success: vi.fn(), info: vi.fn(), message: vi.fn(), warning: vi.fn() },
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

/** Captures the Blob handed to the anchor download, plus the filename used. */
let downloaded: { text: string; filename: string } | null = null;

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
  downloaded = null;
  window.localStorage.removeItem("temaro-activity-log-types");

  Object.defineProperty(URL, "createObjectURL", { value: () => "blob:mock", writable: true });
  Object.defineProperty(URL, "revokeObjectURL", { value: () => {}, writable: true });

  // Intercept the synthetic <a download> click so nothing tries to navigate.
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (
    this: HTMLAnchorElement,
  ) {
    const blob = (this as unknown as { __blob?: Blob }).__blob;
    if (blob) void 0;
  });
  // Blob.text() is available in jsdom; capture at Blob construction time.
  const RealBlob = globalThis.Blob;
  vi.stubGlobal(
    "Blob",
    class extends RealBlob {
      constructor(parts: BlobPart[], opts?: BlobPropertyBag) {
        super(parts, opts);
        downloaded = { text: String(parts[0]), filename: "" };
      }
    },
  );
  vi.spyOn(HTMLElement.prototype, "remove");
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  cleanup();
});

const EXPECTED_HEADER =
  "timestamp_utc,timestamp_local,action_type,label,status,message,customer_id,customer_first_name,customer_phone_number";

/** Split a CSV line, honouring quoted cells. */
function parseLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') {
        cur += '"';
        i += 1;
      } else if (ch === '"') quoted = false;
      else cur += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") {
      out.push(cur);
      cur = "";
    } else cur += ch;
  }
  out.push(cur);
  return out;
}

describe("Export CSV download contents", () => {
  it("writes the expected header row and formats timestamps and phone numbers like the UI", async () => {
    const user = userEvent.setup();
    renderLog();
    await waitFor(() => expect(screen.getByText("Quote #1 sent, total $450")).toBeTruthy());

    await user.click(screen.getByRole("button", { name: /Export/i }));
    await waitFor(() => expect(downloaded).not.toBeNull());

    // The file is BOM-prefixed (Excel) and CRLF-delimited.
    const raw = downloaded!.text;
    expect(raw.startsWith("\uFEFF")).toBe(true);
    const lines = raw.slice(1).split("\r\n");

    // 1. Header row, exact order.
    expect(lines[0]).toBe(EXPECTED_HEADER);
    expect(lines).toHaveLength(1 + ROWS.length);

    const cells = lines.slice(1).map(parseLine);
    expect(cells.every((c) => c.length === 9)).toBe(true);

    // 2. Timestamps: raw ISO for machines, viewer-local string for humans —
    //    the local column matches what the row renders on screen.
    cells.forEach((row, i) => {
      const source = ROWS[i]!;
      expect(row[0]).toBe(source.created_at);
      expect(row[1]).toBe(new Date(source.created_at).toLocaleString());
      expect(row[2]).toBe(source.action_type);
      expect(row[3]).toBe(logActionLabel(source.action_type as never));
      expect(row[4]).toBe(source.status);
    });

    // 3. Phone numbers: contact on file wins, then the record's recipient,
    //    then an empty cell — never the string "null".
    expect(cells[0]![7]).toBe("Dana");
    expect(cells[0]![8]).toBe("+15551234567");
    expect(cells[1]![7]).toBe("");
    expect(cells[1]![8]).toBe("+15550002222");
    expect(cells[2]![6]).toBe("");
    expect(cells[2]![8]).toBe("");
    expect(raw).not.toMatch(/(^|,)null(,|$)/m);

    // 4. Commas and quotes inside message text survive the round trip.
    expect(cells[0]![5]).toBe("Quote #1 sent, total $450");
    expect(cells[1]![5]).toBe('Missed call, "auto-text" fired');
    expect(cells[2]![5]).toBe("");
  });
});
