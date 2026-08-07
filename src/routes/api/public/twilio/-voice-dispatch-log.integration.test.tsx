// @vitest-environment node
/**
 * End-to-end integration coverage: a Twilio missed-call webhook POST lands in
 * the `logs` table, and the Activity log (DispatchLog) renders the resulting
 * missed-call auto-reply entry.
 *
 * Both halves share one in-memory `logs` store: the webhook handler writes
 * through the mocked admin client, and DispatchLog reads through the mocked
 * browser client — so nothing is asserted about a row the webhook did not
 * actually write.
 */
// The route file's server handlers are stripped in the client transform, so this
// suite runs in the server (node) environment and installs a DOM by hand for the
// React rendering half.
import { JSDOM } from "jsdom";

const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  url: "https://example.test/dashboard",
  pretendToBeVisual: true,
});
const g = globalThis as unknown as Record<string, unknown>;
g["window"] = dom.window;
g["document"] = dom.window.document;
g["navigator"] = dom.window.navigator;
for (const key of Object.getOwnPropertyNames(dom.window)) {
  if (key.startsWith("_") || key in g) continue;
  g[key] = (dom.window as unknown as Record<string, unknown>)[key];
}
g["IS_REACT_ACT_ENVIRONMENT"] = true;

import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { LOG_ACTION_TYPES } from "@/lib/log-action-types.generated";

type Row = Record<string, unknown>;

/** Shared table both sides talk to. */
const logs: Row[] = [];
let logSeq = 0;

const state = {
  tenant: null as Row | null,
  excluded: null as Row | null,
  customer: null as Row | null,
  smsShouldFail: false,
};

// ---------------------------------------------------------------- admin side

function adminBuilder(table: string) {
  const single = async () => {
    if (table === "profiles") return { data: state.tenant, error: null };
    if (table === "excluded_numbers") return { data: state.excluded, error: null };
    if (table === "customers") return { data: state.customer, error: null };
    return { data: null, error: null };
  };
  const api: Record<string, unknown> = {
    select: () => api,
    eq: () => api,
    update: () => api,
    maybeSingle: single,
    single,
    insert: (rows: Row | Row[]) => {
      const list = Array.isArray(rows) ? rows : [rows];
      let id = "row-1";
      if (table === "logs") {
        for (const row of list) {
          logSeq += 1;
          id = `log-${logSeq}`;
          logs.push({
            id,
            created_at: new Date(Date.UTC(2026, 7, 7, 12, logSeq)).toISOString(),
            customer_id: null,
            recipient_phone: null,
            ...row,
          });
        }
      }
      const result = { data: { id }, error: null };
      const chain = {
        select: () => chain,
        maybeSingle: async () => result,
        single: async () => result,
        then: (res: (v: unknown) => unknown) => Promise.resolve({ error: null }).then(res),
      };
      return chain;
    },
  };
  return api;
}

type Delivery = {
  id: string;
  state: string;
  attempt_count: number;
  response_body: string | null;
  response_content_type: string | null;
  response_status: number | null;
};
const deliveries = new Map<string, Delivery>();

function rpc(fn: string, args: Record<string, unknown>) {
  if (fn === "webhook_delivery_claim") {
    const key = `${args["_source"]}|${args["_delivery_key"]}`;
    const existing = deliveries.get(key);
    if (!existing) {
      const row: Delivery = {
        id: `d${deliveries.size + 1}`,
        state: "processing",
        attempt_count: 1,
        response_body: null,
        response_content_type: null,
        response_status: null,
      };
      deliveries.set(key, row);
      return Promise.resolve({
        data: [{ delivery_id: row.id, is_duplicate: false, ...row }],
        error: null,
      });
    }
    existing.attempt_count += 1;
    return Promise.resolve({
      data: [{ delivery_id: existing.id, is_duplicate: true, ...existing }],
      error: null,
    });
  }
  return Promise.resolve({ data: null, error: null });
}

vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: { from: (table: string) => adminBuilder(table), rpc },
}));

vi.mock("@/lib/twilio-verify.server", () => ({
  verifyTwilioRequest: async (request: Request) => {
    const text = await request.text();
    return { ok: true, form: new URLSearchParams(text) };
  },
}));

vi.mock("@/lib/webhook-log.server", () => ({
  recordWebhookEvent: async () => null,
  formToPayload: () => ({}),
}));

vi.mock("@/lib/twilio.server", () => ({
  PROJECT_PUBLIC_BASE: "https://example.test",
  STOP_SUFFIX: " Reply STOP to opt out.",
  sendTwilioSms: async () => {
    if (state.smsShouldFail) throw new Error("twilio 500");
    return { sid: "SM123" };
  },
}));

// --------------------------------------------------------------- client side

const PAGE = 10;

function clientBuilder(table: string) {
  const s: {
    limit: number;
    lt?: string;
    gt?: string;
    ascending: boolean;
    actionTypes?: string[];
    eq: Record<string, string>;
  } = { limit: PAGE, ascending: false, eq: {} };

  const run = () => {
    let rows = table === "logs" ? [...logs] : [];
    const at = (r: Row) => String(r["created_at"] ?? "");
    if (s.lt) rows = rows.filter((r) => at(r) < s.lt!);
    if (s.gt) rows = rows.filter((r) => at(r) > s.gt!);
    if (s.actionTypes) rows = rows.filter((r) => s.actionTypes!.includes(String(r["action_type"])));
    for (const [col, value] of Object.entries(s.eq)) {
      rows = rows.filter((r) => String(r[col] ?? "") === value);
    }
    rows.sort((x, y) => (at(x) === at(y) ? 0 : (at(x) < at(y)) === s.ascending ? -1 : 1));
    return Promise.resolve({ data: rows.slice(0, s.limit), error: null });
  };

  const b: Record<string, unknown> = {
    select: () => b,
    order: (_c: string, o?: { ascending?: boolean }) => {
      s.ascending = o?.ascending === true;
      return b;
    },
    limit: (n: number) => {
      s.limit = n;
      return b;
    },
    lt: (_c: string, v: string) => {
      s.lt = v;
      return b;
    },
    gt: (_c: string, v: string) => {
      s.gt = v;
      return b;
    },
    gte: () => b,
    lte: () => b,
    or: () => b,
    in: (_c: string, values: string[]) => {
      s.actionTypes = values;
      return b;
    },
    eq: (col: string, value: string) => {
      s.eq[col] = value;
      return b;
    },
    returns: () => run(),
    then: (resolve: (v: unknown) => unknown) => run().then(resolve),
  };
  return b;
}

vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    from: (table: string) => clientBuilder(table),
    channel: () => {
      const ch: Record<string, unknown> = { on: () => ch, subscribe: () => ch };
      return ch;
    },
    removeChannel: () => Promise.resolve("ok"),
  },
}));

vi.mock("sonner", () => ({
  toast: { error: vi.fn(), success: vi.fn(), info: vi.fn(), message: vi.fn(), warning: vi.fn() },
}));

let searchState: Record<string, unknown> = {};
const subscribers = new Set<() => void>();

vi.mock("@tanstack/react-router", () => ({
  // voice.ts needs createFileRoute; DispatchLog needs the navigation hooks.
  createFileRoute: () => (options: unknown) => ({ options }),
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

const { render, screen, waitFor } = await import("@testing-library/react");
const { DispatchLog } = await import("@/components/DispatchLog");

const CALL = { From: "+14155550123", To: "+14155559999", CallSid: "CA123" };

async function postMissedCall(fields: Record<string, string> = CALL) {
  const { Route } = await import("./voice");
  const handler = (
    Route.options as unknown as {
      server: { handlers: { POST: (c: { request: Request }) => Promise<Response> } };
    }
  ).server.handlers.POST;
  const request = new Request("https://example.test/api/public/twilio/voice", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(fields).toString(),
  });
  return handler({ request });
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
  logs.length = 0;
  logSeq = 0;
  deliveries.clear();
  searchState = {};
  window.localStorage.clear();
  state.tenant = {
    id: "user-1",
    business_name: "Temaro Test Co",
    twilio_phone_number: CALL.To,
    voicemail_enabled: false,
    owner_phone: null,
  };
  state.excluded = null;
  state.customer = { id: "cust-1" };
  state.smsShouldFail = false;
});

describe("Twilio missed-call webhook → Activity log rendering", () => {
  it("renders the missed-call auto-reply entry written by the webhook", async () => {
    const res = await postMissedCall();
    expect(res.status).toBe(200);

    // The webhook wrote exactly one whitelisted row for this call.
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({
      action_type: "missed_call_autotext",
      status: "sent",
      call_sid: "CA123",
      twilio_message_sid: "SM123",
    });
    expect(LOG_ACTION_TYPES).toContain(logs[0]!["action_type"]);

    renderLog();

    await waitFor(() => expect(screen.getByText("1 loaded")).toBeTruthy());
    // Record type badge for the missed-call auto-reply.
    expect(screen.getByText("MISSED_CALL_AUTOTEXT")).toBeTruthy();
    // The auto-reply copy the caller received.
    expect(screen.getByText(/Sorry we missed you/i)).toBeTruthy();
    expect(screen.getByText(/Temaro Test Co/)).toBeTruthy();
    expect(document.querySelector(`#log-row-${logs[0]!["id"]}`)).toBeTruthy();
  }, 30000);

  it("renders a failed auto-reply attempt with the failure reason", async () => {
    state.smsShouldFail = true;
    await postMissedCall();

    expect(logs[0]).toMatchObject({ action_type: "missed_call_autotext", status: "failed" });

    renderLog();
    await waitFor(() => expect(screen.getByText("1 loaded")).toBeTruthy());
    expect(screen.getByText("MISSED_CALL_AUTOTEXT")).toBeTruthy();
    expect(screen.getByText(/twilio 500/)).toBeTruthy();
  }, 30000);

  it("renders the exclusion entry when the caller is on the exclusion list", async () => {
    state.excluded = { id: "ex-1", label: "Spam dialer" };
    await postMissedCall();

    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({ action_type: "missed_call_excluded", status: "skipped" });

    renderLog();
    await waitFor(() => expect(screen.getByText("1 loaded")).toBeTruthy());
    expect(screen.getByText("MISSED_CALL_EXCLUDED")).toBeTruthy();
    expect(screen.getByText(/Spam dialer/)).toBeTruthy();
  }, 30000);

  it("renders one entry per call across several missed calls, newest first", async () => {
    await postMissedCall({ ...CALL, CallSid: "CA-a" });
    await postMissedCall({ ...CALL, CallSid: "CA-b" });
    await postMissedCall({ ...CALL, CallSid: "CA-c" });
    expect(logs).toHaveLength(3);

    renderLog();
    await waitFor(() => expect(screen.getByText("3 loaded")).toBeTruthy());

    const ids = Array.from(document.querySelectorAll<HTMLElement>('[id^="log-row-"]')).map((el) =>
      el.id.replace("log-row-", ""),
    );
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toEqual(["log-3", "log-2", "log-1"]);
  }, 30000);
});
