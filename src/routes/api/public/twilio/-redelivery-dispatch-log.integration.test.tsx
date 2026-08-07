// @vitest-environment node
/**
 * Redelivery integration coverage across *every* Twilio webhook type.
 *
 * Twilio re-POSTs a webhook whenever our response is slow, non-2xx, or the
 * connection drops — often several times for one real-world event. Each webhook
 * type here is delivered once and then re-delivered repeatedly, and after every
 * burst we assert the same three invariants:
 *
 *   1. no duplicate rows — each dispatch id renders exactly once
 *   2. newest-first ordering holds
 *   3. the row count (and the "N loaded" counter) stays stable
 *
 * Both halves share one in-memory `logs` table: the route handlers write through
 * the mocked admin client (which enforces the real `(user_id, dedupe_key)`
 * uniqueness *and* the webhook_delivery_claim dedupe), and DispatchLog reads
 * through the mocked browser client. Nothing is asserted about a row a webhook
 * did not actually write.
 */
// Route server handlers are stripped by the client transform, so this suite runs
// in the node environment and installs a DOM by hand for the rendering half.
// @ts-expect-error -- no type declarations for "jsdom"
import { JSDOM } from "jsdom";

const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  url: "https://example.test/dashboard",
  pretendToBeVisual: true,
});
const g = globalThis as unknown as Record<string, unknown>;
const define = (key: string, value: unknown) => {
  Object.defineProperty(g, key, { value, configurable: true, writable: true });
};
define("window", dom.window);
define("document", dom.window.document);
define("navigator", dom.window.navigator);
for (const key of Object.getOwnPropertyNames(dom.window)) {
  if (key.startsWith("_") || key in g) continue;
  define(key, (dom.window as unknown as Record<string, unknown>)[key]);
}
g["IS_REACT_ACT_ENVIRONMENT"] = true;

import { createHmac } from "crypto";
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { LOG_ACTION_TYPES } from "@/lib/log-action-types.generated";

type Row = Record<string, unknown>;

/** Shared `logs` table. */
const logs: Row[] = [];
let logSeq = 0;
const rejections: Row[] = [];

// Signature verification runs for real (no module mock): every request below is
// signed the way Twilio signs it. Mocking `verifyTwilioRequest` is not an option
// here — concurrent dynamic imports of a mocked module can race and resolve the
// unmocked original, which would fail the parallel-redelivery suites.
process.env["TWILIO_AUTH_TOKEN"] = "test-auth-token";

function twilioSignature(url: string, fields: Record<string, string>) {
  let data = new URL(url).toString();
  for (const key of Object.keys(fields).sort()) data += key + fields[key];
  return createHmac("sha1", process.env["TWILIO_AUTH_TOKEN"]!).update(data).digest("base64");
}

const TENANT_NUMBER = "+14155559999";
const CALLER = "+14155550123";

const state = {
  tenant: null as Row | null,
  excluded: null as Row | null,
  customer: null as Row | null,
  pendingQuote: null as Row | null,
};

// ---------------------------------------------------------------- admin side

const dedupeIndex = () =>
  new Map(
    logs
      .filter((r) => r["dedupe_key"])
      .map((r) => [`${String(r["user_id"])}|${String(r["dedupe_key"])}`, r]),
  );

function pushLog(row: Row): Row {
  logSeq += 1;
  const stored: Row = {
    id: `log-${logSeq}`,
    // Deterministic, strictly increasing timestamps so ordering is assertable.
    created_at: new Date(Date.UTC(2026, 7, 7, 12, logSeq)).toISOString(),
    customer_id: null,
    recipient_phone: null,
    voicemail_url: null,
    recording_sid: null,
    call_sid: null,
    twilio_message_sid: null,
    dedupe_key: null,
    ...row,
  };
  logs.push(stored);
  return stored;
}

function adminBuilder(table: string) {
  const eq: Record<string, unknown> = {};
  let ascending = false;
  let updatePatch: Row | null = null;

  const matches = (r: Row) =>
    Object.entries(eq).every(([col, value]) => String(r[col] ?? "") === String(value ?? ""));

  const logRows = () => {
    const rows = logs.filter(matches);
    rows.sort((a, b) => {
      const x = String(a["created_at"]);
      const y = String(b["created_at"]);
      return x === y ? 0 : (x < y) === ascending ? -1 : 1;
    });
    return rows;
  };

  const resolve = async () => {
    if (table === "logs") {
      if (updatePatch) {
        for (const r of logs.filter(matches)) Object.assign(r, updatePatch);
        return { data: null, error: null };
      }
      return { data: logRows()[0] ?? null, error: null };
    }
    if (table === "profiles") return { data: state.tenant, error: null };
    if (table === "excluded_numbers") return { data: state.excluded, error: null };
    if (table === "customers") return { data: state.customer, error: null };
    if (table === "quotes") return { data: state.pendingQuote, error: null };
    return { data: null, error: null };
  };

  const api: Record<string, unknown> = {
    select: () => api,
    eq: (col: string, value: unknown) => {
      eq[col] = value;
      return api;
    },
    not: () => api,
    is: () => api,
    order: (_c: string, o?: { ascending?: boolean }) => {
      ascending = o?.ascending === true;
      return api;
    },
    limit: () => api,
    update: (patch: Row) => {
      updatePatch = patch;
      return api;
    },
    maybeSingle: resolve,
    single: resolve,
    then: (res: (v: unknown) => unknown) => resolve().then(res),
    /** Idempotent write: honours the partial unique index on (user_id, dedupe_key). */
    upsert: (rows: Row | Row[]) => {
      const list = Array.isArray(rows) ? rows : [rows];
      const index = dedupeIndex();
      let inserted: Row | null = null;
      for (const row of list) {
        const key = `${String(row["user_id"])}|${String(row["dedupe_key"])}`;
        if (row["dedupe_key"] && index.has(key)) continue; // ignoreDuplicates
        inserted = pushLog(row);
        index.set(key, inserted);
      }
      const result = { data: inserted ? { id: inserted["id"] } : null, error: null };
      const chain = {
        select: () => chain,
        maybeSingle: async () => result,
        single: async () => result,
        then: (res: (v: unknown) => unknown) => Promise.resolve({ error: null }).then(res),
      };
      return chain;
    },
    insert: (rows: Row | Row[]) => {
      const list = Array.isArray(rows) ? rows : [rows];
      let inserted: Row | null = null;
      if (table === "logs") for (const row of list) inserted = pushLog(row);
      if (table === "log_write_rejections") rejections.push(...list);
      const result = { data: inserted ? { id: inserted["id"] } : null, error: null };
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
/** Stands in for public.webhook_deliveries. */
const deliveries = new Map<string, Delivery>();

function rpc(fn: string, args: Record<string, unknown>) {
  if (fn === "webhook_delivery_claim") {
    const key = `${args["_source"]}|${args["_event_kind"]}|${args["_delivery_key"]}`;
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
  if (fn === "webhook_delivery_complete") {
    for (const row of deliveries.values()) {
      if (row.id !== args["_delivery_id"]) continue;
      row.state = String(args["_state"] ?? "done");
      row.response_body = (args["_response_body"] as string) ?? null;
      row.response_content_type = (args["_response_content_type"] as string) ?? null;
      row.response_status = (args["_response_status"] as number) ?? null;
    }
    return Promise.resolve({ data: null, error: null });
  }
  return Promise.resolve({ data: null, error: null });
}

vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: { from: (table: string) => adminBuilder(table), rpc },
}));

vi.mock("@/lib/webhook-log.server", () => ({
  recordWebhookEvent: async () => "evt-1",
  formToPayload: () => ({}),
}));

vi.mock("@/lib/webhook-correlation.server", () => ({
  markWebhookCorrelated: async () => {},
  markWebhookNotApplicable: async () => {},
}));

vi.mock("@/lib/twilio.server", () => ({
  PROJECT_PUBLIC_BASE: "https://example.test",
  STOP_SUFFIX: " Reply STOP to opt out.",
  sendTwilioSms: async () => ({ sid: `SM${Math.random().toString(36).slice(2, 8)}` }),
}));

// --------------------------------------------------------------- client side

const PAGE = 25;

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

/** Realtime stub: every webhook-written row can also arrive over the socket. */
const socket = {
  handlers: [] as ((payload: { new: Row }) => void)[],
  push(row: Row) {
    for (const handler of [...this.handlers]) handler({ new: row });
  },
  reset() {
    this.handlers = [];
  },
};

vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    from: (table: string) => clientBuilder(table),
    channel: () => {
      const ch: Record<string, unknown> = {
        on: (_e: string, _cfg: unknown, cb: (payload: { new: Row }) => void) => {
          socket.handlers.push(cb);
          return ch;
        },
        subscribe: () => ch,
      };
      return ch;
    },
    removeChannel: () => {
      socket.handlers = [];
      return Promise.resolve("ok");
    },
  },
}));

vi.mock("sonner", () => ({
  toast: { error: vi.fn(), success: vi.fn(), info: vi.fn(), message: vi.fn(), warning: vi.fn() },
}));

let searchState: Record<string, unknown> = {};
const subscribers = new Set<() => void>();

vi.mock("@tanstack/react-router", () => ({
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

const { cleanup, render, screen, waitFor } = await import("@testing-library/react");
const { DispatchLog } = await import("@/components/DispatchLog");

// ------------------------------------------------------------ webhook posting

type Handler = (ctx: { request: Request }) => Promise<Response>;

async function postHandler(mod: { Route: unknown }, url: string, fields: Record<string, string>) {
  const handler = (
    mod.Route as unknown as { options: { server: { handlers: { POST: Handler } } } }
  ).options.server.handlers.POST;
  return handler({
    request: new Request(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "x-twilio-signature": twilioSignature(url, fields),
      },
      body: new URLSearchParams(fields).toString(),
    }),
  });
}

const missedCall = (fields: Record<string, string>) =>
  import("./voice").then((m) =>
    postHandler(m, "https://example.test/api/public/twilio/voice", fields),
  );

const inboundSms = (fields: Record<string, string>) =>
  import("./sms").then((m) => postHandler(m, "https://example.test/api/public/twilio/sms", fields));

const recordingStatus = (fields: Record<string, string>) =>
  import("./recording").then((m) =>
    postHandler(m, "https://example.test/api/public/twilio/recording", fields),
  );

/** Every Twilio webhook type this app exposes, with a stable provider id. */
const WEBHOOK_TYPES = [
  {
    name: "missed call (voice)",
    post: () =>
      missedCall({
        From: CALLER,
        To: TENANT_NUMBER,
        CallSid: "CA-redelivery",
        CallStatus: "no-answer",
      }),
  },
  {
    name: "inbound SMS",
    post: () =>
      inboundSms({
        From: CALLER,
        To: TENANT_NUMBER,
        Body: "Are you free Thursday?",
        MessageSid: "SM-redelivery",
      }),
  },
  {
    name: "inbound SMS opt-out (STOP)",
    post: () =>
      inboundSms({
        From: CALLER,
        To: TENANT_NUMBER,
        Body: "STOP",
        MessageSid: "SM-stop",
      }),
  },
  {
    name: "inbound SMS opt-in (YES)",
    post: () =>
      inboundSms({
        From: CALLER,
        To: TENANT_NUMBER,
        Body: "YES",
        MessageSid: "SM-yes",
      }),
  },
  {
    name: "recording status (voicemail)",
    post: () =>
      recordingStatus({
        From: CALLER,
        Called: TENANT_NUMBER,
        CallSid: "CA-voicemail",
        RecordingSid: "RE-redelivery",
        RecordingStatus: "completed",
        RecordingUrl: "https://api.twilio.com/rec/RE-redelivery",
        RecordingDuration: "18",
      }),
  },
] as const;

// ------------------------------------------------------------------ assertions

function renderLog() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <DispatchLog limit={PAGE} />
    </QueryClientProvider>,
  );
}

const rowIds = () =>
  Array.from(document.querySelectorAll<HTMLElement>('[id^="log-row-"]')).map((el) =>
    el.id.replace("log-row-", ""),
  );

const loadedCount = () =>
  Number((screen.getByText(/\d+ loaded/).textContent ?? "").match(/(\d+) loaded/)?.[1] ?? -1);

const settle = async () => {
  await new Promise((r) => setTimeout(r, 200));
  await waitFor(() => expect(screen.queryByText(/Loading…/)).toBeNull());
};

const waitForLoaded = (n: number) =>
  waitFor(() => expect(screen.getByText(`${n} loaded`)).toBeTruthy(), { timeout: 8000 });

function expectNoDuplicates() {
  const ids = rowIds();
  expect(new Set(ids).size).toBe(ids.length);
}

function expectNewestFirst() {
  const byId = new Map(logs.map((r) => [String(r["id"]), r]));
  const times = rowIds()
    .map((id) => byId.get(id))
    .filter((r): r is Row => Boolean(r))
    .map((r) => new Date(String(r["created_at"])).getTime());
  expect(times).toEqual([...times].sort((a, b) => b - a));
}

function expectWhitelistedTypes() {
  for (const row of logs) expect(LOG_ACTION_TYPES).toContain(String(row["action_type"]));
}

beforeEach(() => {
  logs.length = 0;
  logSeq = 0;
  rejections.length = 0;
  deliveries.clear();
  socket.reset();
  searchState = {};
  window.localStorage.clear();
  state.tenant = {
    id: "user-1",
    business_name: "Temaro Test Co",
    twilio_phone_number: TENANT_NUMBER,
    voicemail_enabled: false,
    owner_phone: "+14155551111",
  };
  state.excluded = null;
  state.customer = { id: "cust-1" };
  state.pendingQuote = null;
});

afterEach(() => cleanup());

describe("Twilio webhook redelivery → DispatchLog stays deduped and ordered", () => {
  for (const type of WEBHOOK_TYPES) {
    it(`writes one set of rows for ${type.name} no matter how often it is re-delivered`, async () => {
      const first = await type.post();
      expect(first.status).toBe(200);
      const afterFirst = logs.length;
      expect(afterFirst).toBeGreaterThan(0);
      const idsAfterFirst = logs.map((r) => String(r["id"]));

      // Twilio hammers the same event four more times.
      for (let i = 0; i < 4; i += 1) {
        const retry = await type.post();
        expect(retry.status).toBe(200);
      }

      // No new rows, and the original ids are untouched.
      expect(logs).toHaveLength(afterFirst);
      expect(logs.map((r) => String(r["id"]))).toEqual(idsAfterFirst);
      expectWhitelistedTypes();
      expect(rejections).toHaveLength(0);

      renderLog();
      await waitForLoaded(afterFirst);
      expect(rowIds()).toHaveLength(afterFirst);
      expectNoDuplicates();
      expectNewestFirst();
      expect(loadedCount()).toBe(rowIds().length);
    }, 30000);
  }

  it("keeps a stable, newest-first, duplicate-free list when every webhook type is re-delivered", async () => {
    // First pass: one delivery of each type.
    for (const type of WEBHOOK_TYPES) await type.post();
    const total = logs.length;
    expect(total).toBeGreaterThanOrEqual(WEBHOOK_TYPES.length);

    renderLog();
    await waitForLoaded(total);
    const baseline = rowIds();
    expect(baseline).toHaveLength(total);

    // Three more full redelivery rounds, interleaved across types, while the
    // log is already on screen — including the socket replaying each write.
    for (let round = 0; round < 3; round += 1) {
      for (const type of WEBHOOK_TYPES) {
        await type.post();
        for (const row of logs) socket.push(row);
      }
      await settle();

      expect(logs).toHaveLength(total);
      expect(rowIds()).toEqual(baseline);
      expectNoDuplicates();
      expectNewestFirst();
      expect(loadedCount()).toBe(rowIds().length);
    }

    expectWhitelistedTypes();
    expect(rejections).toHaveLength(0);
  }, 45000);

  it("still separates genuinely distinct events after the redeliveries", async () => {
    // Two real missed calls, each delivered three times.
    for (const callSid of ["CA-1", "CA-2"]) {
      for (let i = 0; i < 3; i += 1) {
        await missedCall({
          From: CALLER,
          To: TENANT_NUMBER,
          CallSid: callSid,
          CallStatus: "no-answer",
        });
      }
    }
    // Two real inbound messages, each delivered three times.
    for (const sid of ["SM-1", "SM-2"]) {
      for (let i = 0; i < 3; i += 1) {
        await inboundSms({
          From: CALLER,
          To: TENANT_NUMBER,
          Body: `message ${sid}`,
          MessageSid: sid,
        });
      }
    }

    // Four distinct events → four rows, not twelve.
    expect(logs).toHaveLength(4);
    const total = logs.length;

    renderLog();
    await waitForLoaded(total);
    expect(rowIds()).toHaveLength(total);
    expectNoDuplicates();
    expectNewestFirst();
    // Newest-first means the last event written renders first.
    expect(rowIds()[0]).toBe(String(logs[logs.length - 1]!["id"]));
    expect(loadedCount()).toBe(total);
  }, 45000);
});

// ---------------------------------------------------------------------------
// 1) Concurrency: simultaneous redeliveries, not just sequential ones.
//
// The sequential suites above prove the guard works when attempt N finishes
// before attempt N+1 starts. Twilio does not guarantee that: a slow response
// can leave several attempts for the SAME event in flight at once, so the
// duplicate check and the insert can interleave. These tests fire the bursts
// in parallel and assert the same invariants hold.
// ---------------------------------------------------------------------------
describe("concurrent redeliveries stay idempotent", () => {
  /**
   * Test-harness warm-up, not app behaviour: Vitest resolves a mocked module on
   * first import, and six handler invocations racing that very first resolution
   * can observe the unmocked signature verifier. One throwaway delivery per
   * handler warms the module graph; the shared tables are then reset so each
   * test still starts from an empty log.
   */
  beforeEach(async () => {
    await missedCall({
      From: CALLER,
      To: TENANT_NUMBER,
      CallSid: "CA-warmup",
      CallStatus: "no-answer",
    });
    await inboundSms({
      From: CALLER,
      To: TENANT_NUMBER,
      Body: "warmup",
      MessageSid: "SM-warmup",
    });
    await recordingStatus({
      From: CALLER,
      Called: TENANT_NUMBER,
      CallSid: "CA-warmup-rec",
      RecordingSid: "RE-warmup",
      RecordingStatus: "completed",
      RecordingUrl: "https://api.twilio.com/rec/RE-warmup",
      RecordingDuration: "5",
    });
    logs.length = 0;
    logSeq = 0;
    rejections.length = 0;
    deliveries.clear();
  });

  for (const type of WEBHOOK_TYPES) {
    it(`writes one set of rows for ${type.name} when 6 attempts race`, async () => {
      const responses = await Promise.all(Array.from({ length: 6 }, () => type.post()));
      // Racing attempts are still answered, never dropped or 500'd.
      for (const res of responses) expect(res.status).toBe(200);


      const total = logs.length;
      expect(total).toBeGreaterThan(0);
      expectWhitelistedTypes();
      expect(rejections).toHaveLength(0);

      // Exactly one attempt won the claim; the rest were recognised as repeats.
      const claims = [...deliveries.values()];
      expect(claims).toHaveLength(1);
      expect(claims[0]!.attempt_count).toBe(6);

      // A sequential replay after the race adds nothing either.
      await type.post();
      expect(logs).toHaveLength(total);

      renderLog();
      await waitForLoaded(total);
      expect(rowIds()).toHaveLength(total);
      expectNoDuplicates();
      expectNewestFirst();
    }, 30000);
  }

  it("keeps distinct concurrent events separate while collapsing their repeats", async () => {
    // Four real events, each delivered three times, all interleaved at once.
    const bursts = [
      ...["CA-race-1", "CA-race-2"].flatMap((CallSid) =>
        Array.from({ length: 3 }, () => () =>
          missedCall({ From: CALLER, To: TENANT_NUMBER, CallSid, CallStatus: "no-answer" }),
        ),
      ),
      ...["SM-race-1", "SM-race-2"].flatMap((MessageSid) =>
        Array.from({ length: 3 }, () => () =>
          inboundSms({ From: CALLER, To: TENANT_NUMBER, Body: `race ${MessageSid}`, MessageSid }),
        ),
      ),
    ];
    await Promise.all(bursts.map((post) => post()));

    // Four events → four rows out of twelve deliveries.
    expect(logs).toHaveLength(4);
    expect(deliveries.size).toBe(4);
    expect([...deliveries.values()].every((d) => d.attempt_count === 3)).toBe(true);
    expect(rejections).toHaveLength(0);

    renderLog();
    await waitForLoaded(4);
    expectNoDuplicates();
    expectNewestFirst();
    expect(loadedCount()).toBe(4);
  }, 45000);

  it("collapses repeats that race while the log is already on screen", async () => {
    await missedCall({
      From: CALLER,
      To: TENANT_NUMBER,
      CallSid: "CA-onscreen",
      CallStatus: "no-answer",
    });
    const total = logs.length;

    renderLog();
    await waitForLoaded(total);
    const baseline = rowIds();

    // Parallel redelivery rounds with the socket replaying every write.
    for (let round = 0; round < 3; round += 1) {
      await Promise.all(
        Array.from({ length: 4 }, () =>
          missedCall({
            From: CALLER,
            To: TENANT_NUMBER,
            CallSid: "CA-onscreen",
            CallStatus: "no-answer",
          }),
        ),
      );
      for (const row of logs) socket.push(row);
      await settle();

      expect(logs).toHaveLength(total);
      expect(rowIds()).toEqual(baseline);
      expectNoDuplicates();
      expect(loadedCount()).toBe(rowIds().length);
    }
  }, 45000);
});

// ---------------------------------------------------------------------------
// 2) Conflict rejection audit.
//
// A repeat that carries a DIFFERENT payload under the same dedupe_key is an
// integrity problem, not a duplicate. It must be refused (409), audited in
// log_write_rejections with the differing field names, and must leave the
// stored row and the rendered log untouched.
// ---------------------------------------------------------------------------
describe("conflicting redeliveries are refused and audited", () => {
  /**
   * The delivery-claim layer replays the cached response for a repeated
   * delivery key, so it short-circuits before any log write. To exercise the
   * *second* line of defense — the dedupe_key payload guard — the bookkeeping
   * row is dropped first, exactly as pruning/expiry does in production.
   */
  const expireDeliveryCache = () => deliveries.clear();

  it("audits an inbound SMS whose body changed under the same MessageSid", async () => {
    const first = await inboundSms({
      From: CALLER,
      To: TENANT_NUMBER,
      Body: "on my way",
      MessageSid: "SM-audit",
    });
    expect(first.status).toBe(200);
    expect(logs).toHaveLength(1);
    const storedId = String(logs[0]!["id"]);

    expireDeliveryCache();
    const conflicting = await inboundSms({
      From: CALLER,
      To: TENANT_NUMBER,
      Body: "actually cancel please",
      MessageSid: "SM-audit",
    });
    expect(conflicting.status).toBe(409);


    // Audited exactly once, with the field that disagreed.
    expect(rejections).toHaveLength(1);
    const audit = rejections[0]!;
    expect(audit["error_code"]).toBe("dedupe_key_conflict");
    expect(audit["blocked_at"]).toBeTruthy();
    expect(String(audit["error_message"])).toContain("message_sent");
    expect(String(audit["rejected_action_type"] ?? "")).toBe("sms_inbound");
    // The attempted (refused) payload is captured for the operator.
    expect(JSON.stringify(audit["attempted_row"])).toContain("actually cancel please");

    // Stored row untouched: same id, original body, no extra row.
    expect(logs).toHaveLength(1);
    expect(String(logs[0]!["id"])).toBe(storedId);
    expect(logs[0]!["message_sent"]).toBe("on my way");

    renderLog();
    await waitForLoaded(1);
    expect(rowIds()).toEqual([storedId]);
  }, 30000);

  it("audits every conflicting attempt without ever growing the log", async () => {
    await inboundSms({
      From: CALLER,
      To: TENANT_NUMBER,
      Body: "original",
      MessageSid: "SM-audit-many",
    });
    const baselineLogs = logs.length;

    renderLog();
    await waitForLoaded(baselineLogs);
    const baseline = rowIds();

    for (let i = 0; i < 3; i += 1) {
      expireDeliveryCache();
      const res = await inboundSms({
        From: CALLER,
        To: TENANT_NUMBER,
        Body: `mutated ${i}`,
        MessageSid: "SM-audit-many",
      });
      expect(res.status).toBe(409);

      for (const row of logs) socket.push(row);
      await settle();

      // One audit row per refused attempt; zero new log rows.
      expect(rejections).toHaveLength(i + 1);
      expect(logs).toHaveLength(baselineLogs);
      expect(rowIds()).toEqual(baseline);
      expectNoDuplicates();
    }

    // Every audit names the offending field, so the cause is never ambiguous.
    for (const audit of rejections) {
      expect(audit["error_code"]).toBe("dedupe_key_conflict");
      expect(String(audit["error_message"])).toContain("message_sent");
    }
    expectWhitelistedTypes();
  }, 45000);

  it("a faithful repeat is deduped silently, with nothing written to the audit", async () => {
    const fields = {
      From: CALLER,
      To: TENANT_NUMBER,
      Body: "identical text",
      MessageSid: "SM-no-audit",
    };
    for (let i = 0; i < 4; i += 1) expect((await inboundSms(fields)).status).toBe(200);

    expect(logs).toHaveLength(1);
    // Deduping is not an error: the audit table stays empty.
    expect(rejections).toHaveLength(0);
  }, 30000);
});

// ---------------------------------------------------------------------------
// 3) Pagination ordering across keyset pages.
//
// Redeliveries and dedupe interact with the keyset cursor: a page boundary is
// a `created_at` value, so a duplicate row or a mis-ordered page would either
// repeat a dispatch or silently skip one. These tests build more rows than one
// page holds, then walk every page and assert the concatenation is strictly
// ordered, gap-free and duplicate-free.
// ---------------------------------------------------------------------------
describe("keyset pagination ordering survives redelivery", () => {
  /** Distinct inbound messages, each delivered `repeats` times. */
  async function seedMessages(count: number, repeats: number) {
    for (let i = 0; i < count; i += 1) {
      for (let r = 0; r < repeats; r += 1) {
        await inboundSms({
          From: CALLER,
          To: TENANT_NUMBER,
          Body: `paged message ${i}`,
          MessageSid: `SM-page-${i}`,
        });
      }
    }
  }

  const loadMore = async () => {
    const button = screen.getByRole("button", { name: new RegExp(`Load ${PAGE} older`, "i") });
    const { fireEvent } = await import("@testing-library/react");
    fireEvent.click(button);
  };

  it("walks every page in strict newest-first order with no repeats or gaps", async () => {
    // 3 pages worth of distinct events, each delivered twice.
    const distinct = PAGE * 2 + 7;
    await seedMessages(distinct, 2);
    expect(logs).toHaveLength(distinct);

    renderLog();
    await waitForLoaded(PAGE);
    // First page is exactly one page long and newest-first.
    expect(rowIds()).toHaveLength(PAGE);
    expectNewestFirst();

    const seen = [...rowIds()];
    while (screen.queryByRole("button", { name: new RegExp(`Load ${PAGE} older`, "i") })) {
      const before = rowIds().length;
      await loadMore();
      await waitFor(() => expect(rowIds().length).toBeGreaterThan(before), { timeout: 8000 });
      const ids = rowIds();
      // Each page appends below what was already shown — earlier rows never move.
      expect(ids.slice(0, before)).toEqual(seen);
      seen.length = 0;
      seen.push(...ids);
      expectNoDuplicates();
      expectNewestFirst();
    }

    // Every row surfaced exactly once across all pages, in the exact order the
    // full table would give newest-first.
    expect(seen).toHaveLength(distinct);
    expect(new Set(seen).size).toBe(distinct);
    const expected = [...logs]
      .sort((a, b) => String(b["created_at"]).localeCompare(String(a["created_at"])))
      .map((r) => String(r["id"]));
    expect(seen).toEqual(expected);
    expect(loadedCount()).toBe(distinct);
  }, 60000);

  it("keeps paged ordering stable when redeliveries arrive mid-pagination", async () => {
    const distinct = PAGE + 9;
    await seedMessages(distinct, 1);

    renderLog();
    await waitForLoaded(PAGE);
    const firstPage = [...rowIds()];

    // Re-deliver every event (and replay each write over the socket) *between*
    // page loads — the cursor must not shift, duplicate, or skip a row.
    for (let i = 0; i < distinct; i += 1) {
      await inboundSms({
        From: CALLER,
        To: TENANT_NUMBER,
        Body: `paged message ${i}`,
        MessageSid: `SM-page-${i}`,
      });
    }
    for (const row of logs) socket.push(row);
    await settle();

    expect(logs).toHaveLength(distinct);
    expect(rowIds().slice(0, PAGE)).toEqual(firstPage);

    await loadMore();
    await waitFor(() => expect(rowIds().length).toBe(distinct), { timeout: 8000 });
    expect(rowIds().slice(0, PAGE)).toEqual(firstPage);
    expectNoDuplicates();
    expectNewestFirst();
    expect(loadedCount()).toBe(distinct);
  }, 60000);

  it("paginates the same way in oldest-first order", async () => {
    const distinct = PAGE + 5;
    await seedMessages(distinct, 2);

    // Sort order lives in the URL search state the component reads.
    searchState = { logSort: "oldest" };
    renderLog();
    await waitForLoaded(PAGE);

    const ids = rowIds();
    const byId = new Map(logs.map((r) => [String(r["id"]), r]));
    const times = ids.map((id) => new Date(String(byId.get(id)?.["created_at"])).getTime());
    // Oldest-first: ascending, and the first row is the oldest row in the table.
    expect(times).toEqual([...times].sort((a, b) => a - b));

    const button = screen.getByRole("button", { name: new RegExp(`Load ${PAGE} newer`, "i") });
    const { fireEvent } = await import("@testing-library/react");
    fireEvent.click(button);
    await waitFor(() => expect(rowIds().length).toBe(distinct), { timeout: 8000 });

    const all = rowIds();
    expect(all.slice(0, PAGE)).toEqual(ids);
    expect(new Set(all).size).toBe(distinct);
    const ascending = [...logs]
      .sort((a, b) => String(a["created_at"]).localeCompare(String(b["created_at"])))
      .map((r) => String(r["id"]));
    expect(all).toEqual(ascending);
  }, 60000);
});

