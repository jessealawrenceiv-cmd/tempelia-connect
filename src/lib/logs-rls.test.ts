/**
 * RLS tests for public.logs.
 *
 * Confirms tenant isolation at the database level:
 *  - an authenticated business CAN insert log rows for itself
 *  - it CANNOT insert log rows carrying another business's user_id
 *  - it cannot read the other business's rows
 *  - anonymous (unauthenticated) inserts are rejected
 *
 * Two throwaway users are created with the service-role client, then all
 * assertions run through publishable-key clients signed in as those users, so
 * the policies (not app code) are what is under test.
 *
 * Skipped automatically when backend credentials are absent.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

const url = process.env.SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const publishableKey =
  process.env.SUPABASE_PUBLISHABLE_KEY ?? process.env.VITE_SUPABASE_PUBLISHABLE_KEY;
const hasDb = Boolean(url && serviceKey && publishableKey);

/** Postgres/PostgREST code for "new row violates row-level security policy". */
const RLS_VIOLATION = "42501";

const clientOpts = {
  auth: { persistSession: false, autoRefreshToken: false },
} as const;

type Tenant = { id: string; email: string; client: SupabaseClient };

describe.skipIf(!hasDb)("logs RLS — tenant isolation", () => {
  let admin: SupabaseClient;
  let anon: SupabaseClient;
  let a: Tenant;
  let b: Tenant;
  const createdUserIds: string[] = [];

  async function makeTenant(label: string): Promise<Tenant> {
    const email = `rls-logs-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@temaro.test`;
    const password = `Pw-${Math.random().toString(36).slice(2)}-${Date.now()}`;
    const { data, error } = await admin.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      user_metadata: { business_name: `RLS ${label}` },
    });
    if (error || !data.user) throw new Error(`could not create test user: ${error?.message}`);
    createdUserIds.push(data.user.id);

    const client = createClient(url!, publishableKey!, clientOpts);
    const { error: signInError } = await client.auth.signInWithPassword({ email, password });
    if (signInError) throw new Error(`could not sign in test user: ${signInError.message}`);
    return { id: data.user.id, email, client };
  }

  beforeAll(async () => {
    admin = createClient(url!, serviceKey!, clientOpts);
    anon = createClient(url!, publishableKey!, clientOpts);
    a = await makeTenant("a");
    b = await makeTenant("b");
  }, 60_000);

  afterAll(async () => {
    for (const id of createdUserIds) {
      await admin.from("logs").delete().eq("user_id", id);
      await admin.auth.admin.deleteUser(id);
    }
  });

  it("allows a business to insert a log row for itself", async () => {
    const { data, error } = await a.client
      .from("logs")
      .insert({ user_id: a.id, action_type: "status_refresh", status: "success" })
      .select("id, user_id")
      .maybeSingle();

    expect(error).toBeNull();
    expect(data?.user_id).toBe(a.id);
  });

  it("blocks inserting a log row owned by another business", async () => {
    const { data, error } = await a.client
      .from("logs")
      .insert({ user_id: b.id, action_type: "status_refresh", status: "success" })
      .select("id");

    expect(data).toBeNull();
    expect(error).not.toBeNull();
    expect(error!.code).toBe(RLS_VIOLATION);
    expect(error!.message.toLowerCase()).toContain("row-level security");

    // Nothing landed for tenant B.
    const { count } = await admin
      .from("logs")
      .select("id", { count: "exact", head: true })
      .eq("user_id", b.id);
    expect(count ?? 0).toBe(0);
  });

  it("blocks a mixed batch that smuggles another business's user_id", async () => {
    const { error } = await a.client.from("logs").insert([
      { user_id: a.id, action_type: "quote_sms", status: "success" },
      { user_id: b.id, action_type: "quote_sms", status: "success" },
    ]);

    expect(error).not.toBeNull();
    expect(error!.code).toBe(RLS_VIOLATION);

    // The whole statement is rejected — tenant A gains no row from this batch.
    const { count } = await admin
      .from("logs")
      .select("id", { count: "exact", head: true })
      .eq("user_id", a.id)
      .eq("action_type", "quote_sms");
    expect(count ?? 0).toBe(0);
  });

  it("hides another business's log rows from reads", async () => {
    const { data: seeded, error: seedError } = await admin
      .from("logs")
      .insert({ user_id: b.id, action_type: "review_request", status: "success" })
      .select("id")
      .maybeSingle();
    expect(seedError).toBeNull();

    const { data: crossRead, error: crossError } = await a.client
      .from("logs")
      .select("id")
      .eq("user_id", b.id);
    expect(crossError).toBeNull();
    expect(crossRead).toEqual([]);

    const { data: ownRead } = await b.client.from("logs").select("id").eq("user_id", b.id);
    expect(ownRead?.some((r) => r.id === seeded?.id)).toBe(true);
  });

  it("blocks anonymous log inserts entirely", async () => {
    const { data, error } = await anon
      .from("logs")
      .insert({ user_id: a.id, action_type: "status_refresh", status: "success" })
      .select("id");

    expect(data).toBeNull();
    expect(error).not.toBeNull();
    expect(error!.code).toBe(RLS_VIOLATION);
  });
});
