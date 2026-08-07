/**
 * Integration test for the Twilio inbound-voice (missed call) webhook.
 *
 * Simulates a signed Twilio POST and asserts the handler writes logs rows whose
 * action_type is always a value from the generated whitelist
 * (logs_action_type_check), for all three branches: excluded caller, successful
 * auto-text, and failed auto-text.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { LOG_ACTION_TYPES } from "@/lib/log-action-types";

type Row = Record<string, unknown>;

const state = {
  tenant: null as Row | null,
  excluded: null as Row | null,
  customer: null as Row | null,
  smsShouldFail: false,
};

const logInserts: Row[] = [];
const recordedEvents: Row[] = [];

function builder(table: string) {
  const single = async () => {
    if (table === "profiles") return { data: state.tenant, error: null };
    if (table === "excluded_numbers") return { data: state.excluded, error: null };
    if (table === "customers") return { data: state.customer, error: null };
    return { data: null, error: null };
  };
  const api: Record<string, unknown> = {
    select: () => api,
    eq: () => api,
    maybeSingle: single,
    single,
    insert: (rows: Row | Row[]) => {
      const list = Array.isArray(rows) ? rows : [rows];
      if (table === "logs") logInserts.push(...list);
      const result = {
        data: table === "logs" ? { id: "log-1" } : { id: "cust-1" },
        error: null,
      };
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

vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: { from: (table: string) => builder(table) },
}));

vi.mock("@/lib/twilio-verify.server", () => ({
  verifyTwilioRequest: async (request: Request) => {
    const text = await request.text();
    return { ok: true, form: new URLSearchParams(text) };
  },
}));

vi.mock("@/lib/webhook-log.server", () => ({
  recordWebhookEvent: async (e: Row) => {
    recordedEvents.push(e);
  },
}));

vi.mock("@/lib/twilio.server", () => ({
  PROJECT_PUBLIC_BASE: "https://example.test",
  STOP_SUFFIX: " Reply STOP to opt out.",
  sendTwilioSms: async () => {
    if (state.smsShouldFail) throw new Error("twilio 500");
    return { sid: "SM123" };
  },
}));

async function postWebhook(fields: Record<string, string>) {
  const { Route } = await import("./voice");
  const handler = (
    Route.options as unknown as {
      server: { handlers: { POST: (c: { request: Request }) => Promise<Response> } };
    }
  ).server.handlers.POST;
  const body = new URLSearchParams(fields).toString();
  const request = new Request("https://example.test/api/public/twilio/voice", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  return handler({ request });
}

const CALL = { From: "+14155550123", To: "+14155559999", CallSid: "CA123" };

describe("Twilio missed-call webhook → logs.action_type", () => {
  beforeEach(() => {
    logInserts.length = 0;
    recordedEvents.length = 0;
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

  it("writes missed_call_autotext with status sent on a successful auto-text", async () => {
    const res = await postWebhook(CALL);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("Temaro Test Co");

    expect(logInserts).toHaveLength(1);
    expect(logInserts[0]).toMatchObject({
      user_id: "user-1",
      action_type: "missed_call_autotext",
      status: "sent",
      twilio_message_sid: "SM123",
      call_sid: "CA123",
    });
    expect(LOG_ACTION_TYPES).toContain(logInserts[0]!["action_type"]);
    expect(recordedEvents[0]).toMatchObject({ eventKind: "missed_call", signatureValid: true });
  });

  it("writes missed_call_autotext with status failed when Twilio send throws", async () => {
    state.smsShouldFail = true;
    const res = await postWebhook(CALL);
    expect(res.status).toBe(200);

    expect(logInserts).toHaveLength(1);
    expect(logInserts[0]).toMatchObject({
      action_type: "missed_call_autotext",
      status: "failed",
    });
    expect(String(logInserts[0]!["message_sent"])).toContain("twilio 500");
    expect(LOG_ACTION_TYPES).toContain(logInserts[0]!["action_type"]);
  });

  it("writes missed_call_excluded and skips the auto-text for excluded callers", async () => {
    state.excluded = { id: "ex-1", label: "Spam dialer" };
    const res = await postWebhook(CALL);
    expect(res.status).toBe(200);

    expect(logInserts).toHaveLength(1);
    expect(logInserts[0]).toMatchObject({
      action_type: "missed_call_excluded",
      status: "skipped",
      call_sid: "CA123",
    });
    expect(String(logInserts[0]!["message_sent"])).toContain("Spam dialer");
    expect(LOG_ACTION_TYPES).toContain(logInserts[0]!["action_type"]);
  });

  it("records a voicemail recording callback URL when voicemail is enabled", async () => {
    state.tenant = { ...(state.tenant as Row), voicemail_enabled: true };
    const res = await postWebhook(CALL);
    const xml = await res.text();
    expect(xml).toContain("recordingStatusCallback=");
    expect(xml).toContain("log_id=log-1");
    expect(logInserts[0]!["action_type"]).toBe("missed_call_autotext");
  });

  it("every action_type the webhook can write is on the generated whitelist", async () => {
    const seen = new Set<unknown>();
    await postWebhook(CALL);
    state.smsShouldFail = true;
    await postWebhook(CALL);
    state.smsShouldFail = false;
    state.excluded = { id: "ex-1", label: null };
    await postWebhook(CALL);
    for (const row of logInserts) seen.add(row["action_type"]);

    expect(seen).toEqual(new Set(["missed_call_autotext", "missed_call_excluded"]));
    for (const t of seen) expect(LOG_ACTION_TYPES).toContain(t);
  });

  it("writes no logs rows when the number belongs to no tenant", async () => {
    state.tenant = null;
    const res = await postWebhook(CALL);
    expect(await res.text()).toContain("not configured");
    expect(logInserts).toHaveLength(0);
  });
});
