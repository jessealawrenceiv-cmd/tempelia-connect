// @vitest-environment jsdom
/**
 * Integration test: an unknown `action_type` sitting in storage must never
 * reach a client.
 *
 * Storage is forced into that state two ways:
 *
 * 1. Against a real database (service-role creds present) the CHECK constraint
 *    is the first line of defence — the write is rejected with 23514, so an
 *    unknown value can only appear if the constraint drifts.
 * 2. In every environment, the Data API response itself is forced to contain a
 *    row whose action_type is outside the generated whitelist — simulating that
 *    drift — and the read path must drop the row, warn once with the offending
 *    value, and never surface it in the list, the record-type filters, or the
 *    CSV export.
 */
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { parseLogRowsResponse, parseLogRowsResponseStrict } from "@/lib/log-action-types.schema";
import { LOG_ACTION_TYPES } from "@/lib/log-action-types.generated";

const PAGE = 25;
/** Value that is deliberately NOT in the generated whitelist. */
const GHOST = "ghost_broadcast";
const GOOD = LOG_ACTION_TYPES[0]!;

const KNOWN_MESSAGE = "known record body";
const GHOST_MESSAGE = "ghost record body";

const stored = () => [
  {
    id: "ok-1",
    action_type: GOOD,
    message_sent: KNOWN_MESSAGE,
    created_at: new Date("2026-06-01T12:00:00.000Z").toISOString(),
    status: "sent",
    customer_id: null,
    recipient_phone: null,
  },
  {
    id: "ghost-1",
    action_type: GHOST,
    message_sent: GHOST_MESSAGE,
    created_at: new Date("2026-06-01T11:59:00.000Z").toISOString(),
    status: "sent",
    customer_id: null,
    recipient_phone: null,
  },
];

/* ------------------------------------------------------------------ *
 * Read path: what the UI does with a poisoned response
 * ------------------------------------------------------------------ */

function makeBuilder(table: string) {
  const isLogs = table === "logs" || table === "logs_archive";
  const b: Record<string, unknown> = {
    select: () => b,
    order: () => b,
    limit: () => b,
    returns: () => Promise.resolve({ data: isLogs ? stored() : [], error: null }),
    then: (resolve: (v: unknown) => unknown) =>
      resolve({ data: isLogs ? stored() : [], error: null }),
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

let warn: ReturnType<typeof vi.spyOn>;
let downloaded: string | null = null;

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
  warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  window.localStorage.removeItem("temaro-activity-log-types");
  Object.defineProperty(URL, "createObjectURL", {
    value: () => "blob:captured",
    writable: true,
    configurable: true,
  });
  Object.defineProperty(URL, "revokeObjectURL", {
    value: () => {},
    writable: true,
    configurable: true,
  });
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
  warn.mockRestore();
});

describe("unknown action_type in storage never reaches clients", () => {
  it("drops the row at the parse boundary and names the offender", () => {
    const parsed = parseLogRowsResponse(stored());
    expect(parsed.rows).toHaveLength(1);
    expect(parsed.rows[0]!.action_type).toBe(GOOD);
    expect(parsed.droppedCount).toBe(1);
    expect(parsed.unknownActionTypes).toEqual([GHOST]);
    // Boundaries that must fail loudly still throw with the value + whitelist.
    expect(() => parseLogRowsResponseStrict(stored())).toThrow(new RegExp(GHOST));
  });

  it("renders the known record, hides the unknown one, and logs a warning", async () => {
    renderLog();
    await waitFor(() => expect(screen.getByText(KNOWN_MESSAGE)).toBeTruthy());

    expect(screen.queryByText(GHOST_MESSAGE)).toBeNull();
    // Nothing anywhere in the rendered tree mentions the unknown value.
    expect(document.body.textContent ?? "").not.toContain(GHOST);

    await waitFor(() => expect(warn).toHaveBeenCalled());
    const messages = (warn.mock.calls as unknown[][]).map((c) => String(c[0]));
    const dropWarning = messages.find((m: string) => m.includes("unknown action_type"));
    expect(dropWarning).toBeTruthy();
    expect(dropWarning).toContain("[activity-log]");
    expect(dropWarning).toContain(GHOST);
    expect(dropWarning).toContain("dropped 1");
  });

  it("keeps the unknown value out of the record-type filters", async () => {
    renderLog();
    await waitFor(() => expect(screen.getByText(KNOWN_MESSAGE)).toBeTruthy());

    // The picker is enum-derived, so a stored-but-unknown value is unselectable.
    expect(screen.queryByRole("option", { name: new RegExp(GHOST, "i") })).toBeNull();
    expect(screen.queryByRole("button", { name: new RegExp(GHOST, "i") })).toBeNull();
  });

  it("excludes the unknown row from the CSV export", async () => {
    const user = userEvent.setup();
    renderLog();
    await waitFor(() => expect(screen.getByText(KNOWN_MESSAGE)).toBeTruthy());

    await user.click(screen.getByRole("button", { name: /Export/i }));
    await waitFor(() => expect(downloaded).toBeTruthy());

    const lines = downloaded!.replace(/^\uFEFF/, "").split("\r\n");
    expect(lines).toHaveLength(2); // header + the one valid record
    expect(downloaded).not.toContain(GHOST);
    expect(downloaded).toContain(KNOWN_MESSAGE);
  });
});

/* ------------------------------------------------------------------ *
 * Write path: storage refuses the unknown value in the first place
 * ------------------------------------------------------------------ */

const url = process.env.SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const hasDb = Boolean(url && serviceKey);

describe.skipIf(!hasDb)("storage rejects the unknown action_type outright", () => {
  it("returns 23514 logs_action_type_check and writes nothing", async () => {
    const headers = {
      apikey: serviceKey!,
      Authorization: `Bearer ${serviceKey}`,
      "Content-Type": "application/json",
    };
    const users = await fetch(`${url}/rest/v1/profiles?select=id&limit=1`, { headers });
    const [profile] = (await users.json()) as { id: string }[];
    if (!profile) return;

    const res = await fetch(`${url}/rest/v1/logs`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        user_id: profile.id,
        action_type: GHOST,
        status: "unknown_action_type_probe",
        message_sent: GHOST_MESSAGE,
      }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code: string; message: string };
    expect(body.code).toBe("23514");
    expect(body.message).toContain("logs_action_type_check");

    const check = await fetch(
      `${url}/rest/v1/logs?select=id&action_type=eq.${GHOST}`,
      { headers: { apikey: serviceKey!, Authorization: `Bearer ${serviceKey}` } },
    );
    expect((await check.json()) as unknown[]).toHaveLength(0);
  });
});
