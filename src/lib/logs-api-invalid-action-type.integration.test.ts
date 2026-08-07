/**
 * Integration test: posting an invalid action_type through the logs API.
 *
 * Unlike the unit tests (which stop bad values in app code) this goes over real
 * HTTP to the Data API exactly as a client would — raw fetch, no supabase-js —
 * and asserts the client receives HTTP 400 carrying the
 * `logs_action_type_check` constraint details.
 *
 * The service-role key is used so RLS cannot mask the result: the ONLY thing
 * that can reject the write is the CHECK constraint itself.
 *
 * Skipped automatically when service-role credentials are not present.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { insertLog } from "@/lib/log-action-types";

const url = process.env.SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const hasDb = Boolean(url && serviceKey);

const CHECK_VIOLATION = "23514";
const CONSTRAINT_NAME = "logs_action_type_check";

type PostgrestError = {
  code: string;
  message: string;
  details: string | null;
  hint: string | null;
};

async function postLog(body: unknown): Promise<{ status: number; json: PostgrestError }> {
  const res = await fetch(`${url}/rest/v1/logs`, {
    method: "POST",
    headers: {
      apikey: serviceKey!,
      Authorization: `Bearer ${serviceKey}`,
      "Content-Type": "application/json",
      Prefer: "return=representation",
    },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json()) as PostgrestError };
}

describe.skipIf(!hasDb)("logs API rejects invalid action_type over HTTP", () => {
  let userId: string;

  beforeAll(async () => {
    const res = await fetch(`${url}/rest/v1/profiles?select=id&limit=1`, {
      headers: { apikey: serviceKey!, Authorization: `Bearer ${serviceKey}` },
    });
    const rows = (await res.json()) as { id: string }[];
    if (!Array.isArray(rows) || rows.length === 0) {
      throw new Error("no profiles exist — cannot exercise the logs API");
    }
    userId = rows[0]!.id;
  });

  it("returns HTTP 400 with the logs_action_type_check details", async () => {
    const bad = "definitely_not_an_action_type";
    const { status, json } = await postLog({ user_id: userId, action_type: bad, status: "api_test" });

    expect(status).toBe(400);
    expect(json.code).toBe(CHECK_VIOLATION);
    expect(json.message).toBe(
      'new row for relation "logs" violates check constraint "logs_action_type_check"',
    );
    expect(json.message).toContain(CONSTRAINT_NAME);
    expect(json.details).toMatch(/^Failing row contains \(/);
    expect(json.details).toContain(bad);
    expect(json.hint).toBeNull();
  });

  it.each([
    "MISSED_CALL_TEXT", // whitelist is case-sensitive
    "missed_call_text ", // trailing space
    "quote_sms; drop table logs",
    "",
  ])("returns 400 with the constraint violation for %j", async (bad) => {
    const { status, json } = await postLog({ user_id: userId, action_type: bad, status: "api_test" });
    expect(status).toBe(400);
    expect(json.code).toBe(CHECK_VIOLATION);
    expect(json.message).toContain(CONSTRAINT_NAME);
  });

  it("rejects a batch where only one row is invalid, writing nothing", async () => {
    const { status, json } = await postLog([
      { user_id: userId, action_type: "status_refresh", status: "api_test" },
      { user_id: userId, action_type: "bogus_batch_action", status: "api_test" },
    ]);

    expect(status).toBe(400);
    expect(json.code).toBe(CHECK_VIOLATION);

    // The valid sibling row must not have landed (single statement, all-or-nothing).
    const check = await fetch(`${url}/rest/v1/logs?select=id&status=eq.api_test`, {
      headers: { apikey: serviceKey!, Authorization: `Bearer ${serviceKey}` },
    });
    expect((await check.json()) as unknown[]).toHaveLength(0);
  });

  it("app-side insertLog blocks the value before any HTTP request is made", async () => {
    let called = false;
    const spyClient = {
      from: () => ({
        insert: () => {
          called = true;
          return Promise.resolve({ error: null });
        },
      }),
    };

    const res = (await insertLog(spyClient as never, {
      user_id: userId,
      action_type: "definitely_not_an_action_type" as never,
      status: "api_test",
    })) as unknown as { error: { code: string; constraint: string; rejectedActionType: string } };

    expect(called).toBe(false);
    expect(res.error.code).toBe("23514");
    expect(res.error.constraint).toBe("logs_action_type_check");
    expect(res.error.rejectedActionType).toBe("definitely_not_an_action_type");

  });

  it("accepts a whitelisted action_type through the same API path", async () => {
    const { status, json } = await postLog({
      user_id: userId,
      action_type: "status_refresh",
      status: "api_test_ok",
      message_sent: "logs API integration probe",
    });

    expect(status).toBe(201);
    const rows = json as unknown as { id: string }[];
    expect(rows[0]?.id).toBeTruthy();

    await fetch(`${url}/rest/v1/logs?id=eq.${rows[0]!.id}`, {
      method: "DELETE",
      headers: { apikey: serviceKey!, Authorization: `Bearer ${serviceKey}` },
    });
  });
});
