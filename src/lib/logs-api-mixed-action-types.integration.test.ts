/**
 * Integration test: batches that MIX valid and invalid action_type values.
 *
 * Goes over real HTTP to the Data API (raw fetch, service-role key so RLS
 * cannot mask the result) and asserts three things about a mixed payload:
 *
 * 1. The whole request is rejected with HTTP 400 and the full
 *    `logs_action_type_check` payload (code 23514, exact message, Failing row
 *    details naming the offending value, null hint).
 * 2. Rejection is position-independent — invalid first, middle, or last.
 * 3. Nothing is written: the valid sibling rows must not land.
 *
 * It also documents the read side: a GET filter mixing valid and invalid values
 * is NOT constrained by the CHECK (it returns 200 with only the valid matches),
 * which is exactly why client-side filter validation exists.
 *
 * Skipped automatically when service-role credentials are not present.
 */
import { describe, it, expect, beforeAll, afterEach } from "vitest";
import { LOG_ACTION_TYPES } from "@/lib/log-action-types.generated";

const url = process.env.SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const hasDb = Boolean(url && serviceKey);

const CHECK_VIOLATION = "23514";
const CONSTRAINT_NAME = "logs_action_type_check";
const EXPECTED_MESSAGE = `new row for relation "logs" violates check constraint "${CONSTRAINT_NAME}"`;
/** Marker so the probe rows are easy to find and clean up. */
const MARKER = "api_test_mixed";

type PostgrestError = {
  code: string;
  message: string;
  details: string | null;
  hint: string | null;
};

const authHeaders = () => ({
  apikey: serviceKey!,
  Authorization: `Bearer ${serviceKey}`,
});

async function postLogs(body: unknown): Promise<{ status: number; json: PostgrestError }> {
  const res = await fetch(`${url}/rest/v1/logs`, {
    method: "POST",
    headers: { ...authHeaders(), "Content-Type": "application/json", Prefer: "return=representation" },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json()) as PostgrestError };
}

async function markerRowCount(): Promise<number> {
  const res = await fetch(`${url}/rest/v1/logs?select=id&status=eq.${MARKER}`, {
    headers: authHeaders(),
  });
  return ((await res.json()) as unknown[]).length;
}

describe.skipIf(!hasDb)("logs API rejects mixed valid/invalid action_type batches", () => {
  let userId: string;
  /** Two known-good values taken straight from the generated whitelist. */
  const [validA, validB] = [LOG_ACTION_TYPES[0]!, LOG_ACTION_TYPES[1] ?? LOG_ACTION_TYPES[0]!];

  const row = (action_type: string) => ({
    user_id: userId,
    action_type,
    status: MARKER,
    message_sent: "mixed action_type batch probe",
  });

  beforeAll(async () => {
    const res = await fetch(`${url}/rest/v1/profiles?select=id&limit=1`, { headers: authHeaders() });
    const rows = (await res.json()) as { id: string }[];
    if (!Array.isArray(rows) || rows.length === 0) {
      throw new Error("no profiles exist — cannot exercise the logs API");
    }
    userId = rows[0]!.id;
  });

  // Any row that somehow lands must not leak into later assertions or the app.
  afterEach(async () => {
    await fetch(`${url}/rest/v1/logs?status=eq.${MARKER}`, { method: "DELETE", headers: authHeaders() });
  });

  it("returns the full logs_action_type_check payload for a mixed batch", async () => {
    const bad = "mixed_batch_not_a_type";
    const { status, json } = await postLogs([row(validA), row(bad), row(validB)]);

    expect(status).toBe(400);
    expect(json.code).toBe(CHECK_VIOLATION);
    expect(json.message).toBe(EXPECTED_MESSAGE);
    expect(json.message).toContain(CONSTRAINT_NAME);
    expect(json.details).toMatch(/^Failing row contains \(/);
    // The details name the offending value only — never the valid siblings.
    expect(json.details).toContain(bad);
    expect(json.hint).toBeNull();
  });

  it.each([
    ["first", 0],
    ["middle", 1],
    ["last", 2],
  ])("rejects the batch when the invalid value is %s and writes nothing", async (_label, index) => {
    const bad = `mixed_position_${index}_not_a_type`;
    const rows = [row(validA), row(validB), row(validA)];
    rows[index] = row(bad);

    const { status, json } = await postLogs(rows);

    expect(status).toBe(400);
    expect(json.code).toBe(CHECK_VIOLATION);
    expect(json.message).toContain(CONSTRAINT_NAME);
    expect(json.details).toContain(bad);

    // Single statement, all-or-nothing: the two valid rows must be absent.
    expect(await markerRowCount()).toBe(0);
  });

  it("writes every row when the same batch contains only valid values", async () => {
    const { status, json } = await postLogs([row(validA), row(validB)]);

    expect(status).toBe(201);
    expect((json as unknown as { id: string }[]).length).toBe(2);
    expect(await markerRowCount()).toBe(2);
  });

  it("does NOT reject a read filter that mixes valid and invalid values", async () => {
    // The CHECK constraint guards writes only. A GET with a bogus value in the
    // IN list is a valid query that simply matches nothing for that value, so
    // bad filters fail silently at the API — hence the client-side guards.
    const res = await fetch(
      `${url}/rest/v1/logs?select=action_type&action_type=in.(${validA},read_filter_not_a_type)&limit=5`,
      { headers: authHeaders() },
    );

    expect(res.status).toBe(200);
    const rows = (await res.json()) as { action_type: string }[];
    expect(Array.isArray(rows)).toBe(true);
    for (const r of rows) expect(r.action_type).toBe(validA);
  });
});
