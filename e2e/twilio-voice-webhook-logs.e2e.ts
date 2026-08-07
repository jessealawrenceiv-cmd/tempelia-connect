/**
 * End-to-end test for the Twilio inbound VOICE (missed call) webhook.
 *
 * Unlike the unit/integration test (which mocks Twilio + Supabase), this test
 * posts a real, correctly signed form-encoded webhook to the running server and
 * then reads public.logs from the live database to confirm:
 *   - the expected rows are written for each branch
 *   - every written action_type is inside the generated CHECK whitelist
 *
 * No SMS reaches a real handset:
 *   - the excluded-caller branch never calls Twilio
 *   - the auto-text branch targets Twilio's invalid test number
 *     (+1 500 555 0001), which the API rejects, exercising the "failed" row
 *
 * A throwaway tenant (auth user + profile + Temaro number) is created for the
 * run and deleted afterwards. Skipped when backend credentials are absent.
 */
import { test, expect } from "@playwright/test";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { createHmac } from "node:crypto";
import { LOG_ACTION_TYPES } from "../src/lib/log-action-types.generated";

const WEBHOOK_PATH = "/api/public/twilio/voice";

const supabaseUrl = process.env["SUPABASE_URL"];
const serviceKey = process.env["SUPABASE_SERVICE_ROLE_KEY"];
const authToken = process.env["TWILIO_AUTH_TOKEN"];
const canRun = Boolean(supabaseUrl && serviceKey && authToken);

/** Rebuild Twilio's signature: base64(HMAC-SHA1(url + sorted k+v pairs)). */
function sign(url: string, params: Record<string, string>) {
  let data = url;
  for (const key of Object.keys(params).sort()) data += key + params[key];
  return createHmac("sha1", authToken!).update(data).digest("base64");
}

const ALLOWED = new Set<string>(LOG_ACTION_TYPES);

type LogRow = { action_type: string; status: string; message_sent: string | null };

test.describe("Twilio missed-call webhook writes whitelisted log rows", () => {
  test.skip(!canRun, "backend or Twilio credentials unavailable");

  let admin: SupabaseClient;
  let tenantId = "";
  let tenantNumber = "";
  const excludedCaller = "+15005550009";
  /** Twilio rejects this as an invalid destination — the send fails, nothing is delivered. */
  const invalidCaller = "+15005550001";

  test.beforeAll(async () => {
    admin = createClient(supabaseUrl!, serviceKey!, {
      auth: { persistSession: false, autoRefreshToken: false },
    });

    const stamp = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
    const email = `voice-e2e-${stamp}@temaro.test`;
    const { data, error } = await admin.auth.admin.createUser({
      email,
      password: `Pw-${stamp}-${Math.random().toString(36).slice(2)}`,
      email_confirm: true,
      user_metadata: { business_name: "Voice E2E Co" },
    });
    if (error || !data.user) throw new Error(`could not create tenant: ${error?.message}`);
    tenantId = data.user.id;

    // Unique, non-routable Temaro number so this tenant only matches our posts.
    tenantNumber = `+1500555${stamp.slice(-4)}`;
    const { error: profileError } = await admin
      .from("profiles")
      .update({
        business_name: "Voice E2E Co",
        twilio_phone_number: tenantNumber,
        voicemail_enabled: false,
      })
      .eq("id", tenantId);
    if (profileError) throw new Error(`could not set tenant number: ${profileError.message}`);

    await admin
      .from("excluded_numbers")
      .insert({ user_id: tenantId, phone_number: excludedCaller, label: "E2E excluded" });
  });

  test.afterAll(async () => {
    if (!tenantId) return;
    await admin.from("logs").delete().eq("user_id", tenantId);
    await admin.from("excluded_numbers").delete().eq("user_id", tenantId);
    await admin.from("customers").delete().eq("user_id", tenantId);
    await admin.auth.admin.deleteUser(tenantId);
  });

  async function postWebhook(
    request: import("@playwright/test").APIRequestContext,
    baseURL: string,
    params: Record<string, string>,
    opts: { validSignature?: boolean } = {},
  ) {
    const url = new URL(WEBHOOK_PATH, baseURL).toString();
    return request.post(url, {
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "X-Twilio-Signature": opts.validSignature === false ? "bogus" : sign(url, params),
      },
      form: params,
    });
  }

  async function logsFor(callSid: string): Promise<LogRow[]> {
    const { data, error } = await admin
      .from("logs")
      .select("action_type, status, message_sent")
      .eq("user_id", tenantId)
      .eq("call_sid", callSid)
      .order("created_at", { ascending: true });
    if (error) throw new Error(error.message);
    return (data ?? []) as LogRow[];
  }

  test("excluded caller: logs missed_call_excluded and sends no text", async ({
    request,
    baseURL,
  }) => {
    const callSid = `CAexcl${Date.now()}`;
    const res = await postWebhook(request, baseURL!, {
      From: excludedCaller,
      To: tenantNumber,
      CallSid: callSid,
      CallStatus: "no-answer",
    });

    expect(res.status()).toBe(200);
    expect(await res.text()).toContain("<Response>");

    const rows = await logsFor(callSid);
    expect(rows).toHaveLength(1);
    expect(rows[0].action_type).toBe("missed_call_excluded");
    expect(rows[0].status).toBe("skipped");
    expect(ALLOWED.has(rows[0].action_type)).toBe(true);
  });

  test("normal caller: logs a missed_call_autotext row", async ({ request, baseURL }) => {
    const callSid = `CAauto${Date.now()}`;
    const res = await postWebhook(request, baseURL!, {
      From: invalidCaller,
      To: tenantNumber,
      CallSid: callSid,
      CallStatus: "no-answer",
    });

    expect(res.status()).toBe(200);
    expect(await res.text()).toContain("Thanks for calling");

    const rows = await logsFor(callSid);
    expect(rows).toHaveLength(1);
    expect(rows[0].action_type).toBe("missed_call_autotext");
    expect(["sent", "failed"]).toContain(rows[0].status);
    expect(ALLOWED.has(rows[0].action_type)).toBe(true);
  });

  test("every row written for this tenant uses a whitelisted action_type", async () => {
    const { data, error } = await admin
      .from("logs")
      .select("action_type")
      .eq("user_id", tenantId);
    expect(error).toBeNull();
    expect((data ?? []).length).toBeGreaterThan(0);
    for (const row of data ?? []) expect(ALLOWED.has(row.action_type)).toBe(true);
  });

  test("invalid signature is rejected and writes no log row", async ({ request, baseURL }) => {
    const callSid = `CAbad${Date.now()}`;
    const res = await postWebhook(
      request,
      baseURL!,
      { From: invalidCaller, To: tenantNumber, CallSid: callSid, CallStatus: "no-answer" },
      { validSignature: false },
    );

    expect(res.status()).toBe(403);
    expect(await logsFor(callSid)).toHaveLength(0);
  });

  test("unknown Temaro number writes no log row", async ({ request, baseURL }) => {
    const callSid = `CAunk${Date.now()}`;
    const res = await postWebhook(request, baseURL!, {
      From: invalidCaller,
      To: "+15005559999",
      CallSid: callSid,
      CallStatus: "no-answer",
    });

    expect(res.status()).toBe(200);
    expect(await res.text()).toContain("not configured");
    expect(await logsFor(callSid)).toHaveLength(0);
  });
});
