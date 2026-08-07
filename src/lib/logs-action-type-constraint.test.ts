/**
 * Database-level test: public.logs.action_type must stay an explicit whitelist.
 *
 * Inserts a bogus action_type with the service-role client (RLS bypassed, so the
 * only thing that can stop the write is the CHECK constraint) and asserts the
 * database rejects it with Postgres error 23514 (check_violation).
 *
 * Skipped automatically when service-role credentials are not present.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

const url = process.env.SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const hasDb = Boolean(url && serviceKey);

const CONSTRAINT_ERROR = "23514";
const CONSTRAINT_NAME = "logs_action_type_check";


describe.skipIf(!hasDb)("logs.action_type CHECK constraint", () => {
  let supabase: SupabaseClient;
  let userId: string;

  beforeAll(async () => {
    supabase = createClient(url!, serviceKey!, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { data, error } = await supabase.from("profiles").select("id").limit(1).maybeSingle();
    if (error) throw new Error(`could not load a profile for the test: ${error.message}`);
    if (!data) throw new Error("no profiles exist — cannot exercise the logs FK");
    userId = data.id;
  });

  const invalidValues = [
    "totally_made_up_action",
    "MISSED_CALL_TEXT", // wrong case — whitelist is case-sensitive
    "missed_call_text ", // trailing space
    "quote_sms; drop table logs",
    "",
  ];

  it.each(invalidValues)("rejects action_type %j", async (bad) => {
    const { data, error } = await supabase
      .from("logs")
      .insert({ user_id: userId, action_type: bad, status: "test" })
      .select("id");

    expect(data).toBeNull();
    expect(error).not.toBeNull();
    expect(error!.code).toBe(CONSTRAINT_ERROR);
    expect(error!.message).toContain("logs_action_type_check");
  });

  it("returns the constraint name and full 23514 error details", async () => {
    const bad = "not_a_real_action_type";
    const result = await supabase
      .from("logs")
      .insert({ user_id: userId, action_type: bad, status: "test" })
      .select("id");

    // No row written, and PostgREST surfaces the check violation as HTTP 400.
    expect(result.data).toBeNull();
    expect(result.status).toBe(400);
    expect(result.error).not.toBeNull();

    const error = result.error!;
    // Exact Postgres error class for a CHECK violation.
    expect(error.code).toBe(CONSTRAINT_ERROR);
    // The named constraint — not a trigger, not RLS, not a generic 400.
    expect(error.message).toBe(
      'new row for relation "logs" violates check constraint "logs_action_type_check"',
    );
    expect(error.message).toContain(CONSTRAINT_NAME);
    // Details echo the rejected row, including the offending action_type value.
    expect(error.details).toMatch(/^Failing row contains \(/);
    expect(error.details).toContain(bad);
    expect(error.hint).toBeNull();
  });

  it("still accepts a whitelisted action_type", async () => {
    const { data, error } = await supabase
      .from("logs")
      .insert({
        user_id: userId,
        action_type: "status_refresh",
        status: "constraint_test",
        message_sent: "constraint test row",
      })
      .select("id")
      .single();

    expect(error).toBeNull();
    expect(data?.id).toBeTruthy();

    // logs are append-only for users, but service_role can clean up the probe row.
    if (data?.id) await supabase.from("logs").delete().eq("id", data.id);
  });
});

