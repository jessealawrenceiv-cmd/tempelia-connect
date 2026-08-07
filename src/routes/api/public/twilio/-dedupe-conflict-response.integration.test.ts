// @vitest-environment node
/**
 * Consistency check for refused Activity-log writes across the webhook surface.
 *
 * A redelivery that carries a DIFFERENT payload under the same `dedupe_key` is
 * an integrity problem, not a duplicate. Every Twilio endpoint must report it
 * identically: HTTP 409, the `dedupe_key_conflict` code, the differing field
 * names in the response headers, and the stored row left untouched.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEDUPE_CONFLICT_FIELDS_HEADER,
  DEDUPE_CONFLICT_HEADER,
  DEDUPE_CONFLICT_LOG_HEADER,
} from "@/lib/log-dedupe-conflict-response";

type Row = Record<string, unknown>;

const logs: Row[] = [];
const rejections: Row[] = [];
let logSeq = 0;

const TENANT_NUMBER = "+14155559999";
const CALLER = "+14155550123";

const state = {
  tenant: null as Row | null,
  customer: null as Row | null,
};

function adminBuilder(table: string) {
  const eq: Record<string, unknown> = {};
  const matches = (r: Row) =>
    Object.entries(eq).every(([c, v]) => String(r[c] ?? "") === String(v ?? ""));

  const resolve = async () => {
    if (table === "logs") return { data: logs.filter(matches)[0] ?? null, error: null };
    if (table === "profiles") return { data: state.tenant, error: null };
    if (table === "customers") return { data: state.customer, error: null };
    return { data: null, error: null };
  };

  const write = (rows: Row | Row[], ignoreDuplicates = false) => {
    const list = Array.isArray(rows) ? rows : [rows];
    let inserted: Row | null = null;
    if (table === "logs") {
      for (const row of list) {
        const dupe = logs.find(
          (r) => r["dedupe_key"] && r["dedupe_key"] === row["dedupe_key"] && r["user_id"] === row["user_id"],
        );
        if (dupe && ignoreDuplicates) continue;
        logSeq += 1;
        inserted = { id: `log-${logSeq}`, created_at: new Date().toISOString(), ...row };
        logs.push(inserted);
      }
    }
    if (table === "log_write_rejections") rejections.push(...list);
    const result = { data: inserted ? { id: inserted["id"] } : null, error: null };
    const chain = {
      select: () => chain,
      maybeSingle: async () => result,
      single: async () => result,
      then: (res: (v: unknown) => unknown) => Promise.resolve({ error: null }).then(res),
    };
    return chain;
  };

  const api: Record<string, unknown> = {
    select: () => api,
    eq: (c: string, v: unknown) => {
      eq[c] = v;
      return api;
    },
    not: () => api,
    is: () => api,
    order: () => api,
    limit: () => api,
    update: () => ({ eq: async () => ({ error: null }) }),
    maybeSingle: resolve,
    single: resolve,
    then: (res: (v: unknown) => unknown) => resolve().then(res),
    upsert: (rows: Row | Row[]) => write(rows, true),
    insert: (rows: Row | Row[]) => write(rows),
  };
  return api;
}

const deliveries = new Map<string, { id: string; attempts: number }>();

function rpc(fn: string, args: Record<string, unknown>) {
  if (fn === "webhook_delivery_claim") {
    // Simulate the claim failing open (bookkeeping error / concurrent worker):
    // that is exactly the case where the dedupe guard has to do the work.
    const key = String(args["_delivery_key"]);
    const existing = deliveries.get(key);
    if (existing) existing.attempts += 1;
    else deliveries.set(key, { id: `d${deliveries.size + 1}`, attempts: 1 });
    return Promise.resolve({
      data: [
        {
          delivery_id: deliveries.get(key)!.id,
          is_duplicate: false,
          state: "processing",
          attempt_count: deliveries.get(key)!.attempts,
          response_body: null,
          response_content_type: null,
          response_status: null,
        },
      ],
      error: null,
    });
  }
  return Promise.resolve({ data: null, error: null });
}

const completed: Row[] = [];
vi.mock("@/lib/webhook-idempotency.server", async () => {
  const actual = await vi.importActual<typeof import("@/lib/webhook-idempotency.server")>(
    "@/lib/webhook-idempotency.server",
  );
  return {
    ...actual,
    completeWebhookDelivery: async (
      _client: unknown,
      args: { deliveryId: string | null; state?: string; response: Response },
    ) => {
      completed.push({ deliveryId: args.deliveryId, state: args.state ?? "done" });
      return args.response;
    },
  };
});

vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: { from: (t: string) => adminBuilder(t), rpc },
}));

vi.mock("@/lib/twilio-verify.server", () => ({
  verifyTwilioRequest: async (request: Request) => ({
    ok: true,
    form: new URLSearchParams(await request.text()),
  }),
}));

vi.mock("@/lib/webhook-log.server", () => ({
  recordWebhookEvent: async () => "evt-1",
  formToPayload: () => ({}),
}));

vi.mock("@/lib/webhook-correlation.server", () => ({
  markWebhookCorrelated: async () => {},
  markWebhookNotApplicable: async () => {},
}));

vi.mock("@/lib/webhook-delivery-audit.server", () => ({
  WEBHOOK_MAX_ATTEMPTS: 5,
  logWebhookRetryAttempt: async () => {},
  logWebhookFailure: async () => {},
}));

vi.mock("@/lib/twilio.server", () => ({
  PROJECT_PUBLIC_BASE: "https://example.test",
  STOP_SUFFIX: " Reply STOP to opt out.",
  sendTwilioSms: async () => ({ sid: "SMsent" }),
}));

type Handler = (ctx: { request: Request }) => Promise<Response>;

async function post(modPath: string, path: string, fields: Record<string, string>) {
  const mod = (await import(modPath)) as {
    Route: { options: { server: { handlers: { POST: Handler } } } };
  };
  return mod.Route.options.server.handlers.POST({
    request: new Request(`https://example.test${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(fields).toString(),
    }),
  });
}

const sms = (fields: Record<string, string>) =>
  post("./sms", "/api/public/twilio/sms", fields);
const voice = (fields: Record<string, string>) =>
  post("./voice", "/api/public/twilio/voice", fields);
const recording = (fields: Record<string, string>) =>
  post("./recording", "/api/public/twilio/recording", fields);

function expectConflict(res: Response, fields: string[]) {
  expect(res.status).toBe(409);
  expect(res.headers.get(DEDUPE_CONFLICT_HEADER)).toBe("dedupe_key_conflict");
  const reported = (res.headers.get(DEDUPE_CONFLICT_FIELDS_HEADER) ?? "").split(",");
  for (const field of fields) expect(reported).toContain(field);
  expect(res.headers.get(DEDUPE_CONFLICT_LOG_HEADER)).toBeTruthy();
}

beforeEach(() => {
  logs.length = 0;
  rejections.length = 0;
  completed.length = 0;
  logSeq = 0;
  deliveries.clear();
  state.tenant = {
    id: "user-1",
    business_name: "Temaro Test Co",
    twilio_phone_number: TENANT_NUMBER,
    voicemail_enabled: false,
    owner_phone: null,
  };
  state.customer = { id: "cust-1" };
});

describe("webhook responses for dedupe_key payload conflicts", () => {
  it("inbound SMS: same MessageSid, different body → 409 naming message_sent", async () => {
    const first = await sms({
      From: CALLER,
      To: TENANT_NUMBER,
      Body: "on my way",
      MessageSid: "SM-conflict",
    });
    expect(first.status).toBe(200);
    expect(logs).toHaveLength(1);

    const second = await sms({
      From: CALLER,
      To: TENANT_NUMBER,
      Body: "actually cancel please",
      MessageSid: "SM-conflict",
    });
    expectConflict(second, ["message_sent"]);
    // The refusal body is XML for Twilio, and still names the fields.
    expect(second.headers.get("Content-Type")).toBe("text/xml");
    expect(await second.text()).toContain("message_sent");

    // Stored row untouched, no second row, conflict recorded for operators.
    expect(logs).toHaveLength(1);
    expect(logs[0]!["message_sent"]).toBe("on my way");
    expect(rejections).toHaveLength(1);
    expect(rejections[0]!["error_code"]).toBe("dedupe_key_conflict");
    // Not cached as this delivery's successful response.
    expect(completed.at(-1)!["state"]).toBe("failed");
  });

  it("missed call: same CallSid, different customer → 409 naming customer_id", async () => {
    const first = await voice({
      From: CALLER,
      To: TENANT_NUMBER,
      CallSid: "CA-conflict",
      CallStatus: "no-answer",
    });
    expect(first.status).toBe(200);
    const before = logs.length;
    expect(before).toBeGreaterThan(0);

    // Same call redelivered, but the customer lookup now resolves elsewhere.
    state.customer = { id: "cust-999" };
    const second = await voice({
      From: CALLER,
      To: TENANT_NUMBER,
      CallSid: "CA-conflict",
      CallStatus: "no-answer",
    });
    expectConflict(second, ["customer_id"]);
    expect(logs).toHaveLength(before);
    expect(completed.at(-1)!["state"]).toBe("failed");
  });

  it("recording status: same RecordingSid, different recording → 409 naming voicemail_url", async () => {
    const fields = {
      From: CALLER,
      Called: TENANT_NUMBER,
      CallSid: "CA-vm",
      RecordingSid: "RE-conflict",
      RecordingStatus: "completed",
      RecordingDuration: "12",
    };
    const first = await recording({ ...fields, RecordingUrl: "https://api.twilio.com/rec/A" });
    expect(first.status).toBe(200);
    expect(logs).toHaveLength(1);

    const second = await recording({ ...fields, RecordingUrl: "https://api.twilio.com/rec/B" });
    expectConflict(second, ["voicemail_url"]);
    expect(second.headers.get("Content-Type")).toBe("text/plain");
    expect(await second.text()).toContain("voicemail_url");
    expect(logs).toHaveLength(1);
    expect(logs[0]!["voicemail_url"]).toBe("https://api.twilio.com/rec/A.mp3");
    expect(completed.at(-1)!["state"]).toBe("failed");
  });

  it("a faithful redelivery still gets the normal 2xx, not a conflict", async () => {
    const fields = {
      From: CALLER,
      To: TENANT_NUMBER,
      Body: "same text",
      MessageSid: "SM-same",
    };
    const first = await sms(fields);
    const second = await sms(fields);
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(logs).toHaveLength(1);
    expect(rejections).toHaveLength(0);
    expect(completed.every((c) => c["state"] === "done")).toBe(true);
  });
});
