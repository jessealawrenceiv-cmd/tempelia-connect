// @vitest-environment node
/**
 * Integration coverage for the token-gated constraint endpoint.
 *
 * Two guarantees are load-bearing for CI:
 *   1. Auth — the endpoint is unusable without the exact CI_ENUM_CHECK_TOKEN.
 *   2. Truth — when authorized, it returns the LIVE `logs_action_type_check`
 *      allowed values, in constraint order, and nothing else. CI compares that
 *      payload against src/lib/log-action-types.generated.ts, so the endpoint
 *      must agree with the constraint the database actually holds.
 *
 * The Supabase admin client is stubbed with a fake `pg_constraint` read whose
 * definition string is built the way Postgres renders a CHECK constraint.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LOG_ACTION_TYPES, LOGS_ACTION_TYPE_CONSTRAINT } from "@/lib/log-action-types.generated";

const TOKEN = "ciek_integration_test_token_value";
const ENDPOINT = "http://localhost/api/public/log-action-types/constraint";

/** Values the fake database "constraint" holds; mutated by individual tests. */
let constraintValues: string[] = [...LOG_ACTION_TYPES];
let rpcError: { message: string } | null = null;
const rpcCalls: string[] = [];

/** Mirrors how Postgres renders `action_type = ANY (ARRAY[...]::text[])`. */
function renderCheckDefinition(values: string[]): string {
  const list = values.map((v) => `'${v}'::text`).join(", ");
  return `CHECK ((action_type = ANY (ARRAY[${list}])))`;
}

vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: {
    rpc: async (fn: string) => {
      rpcCalls.push(fn);
      if (rpcError) return { data: null, error: rpcError };
      return {
        data: [
          {
            constraint_name: LOGS_ACTION_TYPE_CONSTRAINT,
            constraint_def: renderCheckDefinition(constraintValues),
            allowed_values: constraintValues,
          },
        ],
        error: null,
      };
    },
  },
}));

type Handler = (ctx: { request: Request }) => Promise<Response>;
type RouteShape = { options: { server: { handlers: Record<string, Handler> } } };

async function getHandler(): Promise<Record<string, Handler>> {
  const mod = await import("./constraint");
  return (mod.Route as unknown as RouteShape).options.server.handlers;
}

function request(token?: string) {
  const headers = new Headers({ Accept: "application/json" });
  if (token !== undefined) headers.set("Authorization", `Bearer ${token}`);
  return new Request(ENDPOINT, { method: "GET", headers });
}

describe("GET /api/public/log-action-types/constraint", () => {
  beforeEach(() => {
    constraintValues = [...LOG_ACTION_TYPES];
    rpcError = null;
    rpcCalls.length = 0;
    process.env["CI_ENUM_CHECK_TOKEN"] = TOKEN;
  });

  afterEach(() => {
    delete process.env["CI_ENUM_CHECK_TOKEN"];
  });

  describe("requires a valid Bearer token", () => {
    it("rejects a request with no Authorization header", async () => {
      const { GET } = await getHandler();
      const res = await GET({ request: request() });

      expect(res.status).toBe(401);
      expect(res.headers.get("WWW-Authenticate")).toBe("Bearer");
      expect(await res.json()).toMatchObject({ error: "unauthorized" });
      // No database read is attempted for an unauthenticated caller.
      expect(rpcCalls).toEqual([]);
    });

    it("rejects a wrong token", async () => {
      const { GET } = await getHandler();
      const res = await GET({ request: request("ciek_not_the_right_token_value") });

      expect(res.status).toBe(401);
      expect(rpcCalls).toEqual([]);
    });

    it("rejects a token that is a prefix of the real one", async () => {
      const { GET } = await getHandler();
      const res = await GET({ request: request(TOKEN.slice(0, -1)) });

      expect(res.status).toBe(401);
      expect(rpcCalls).toEqual([]);
    });

    it("rejects a non-Bearer scheme", async () => {
      const { GET } = await getHandler();
      const res = await GET({
        request: new Request(ENDPOINT, { headers: { Authorization: `Token ${TOKEN}` } }),
      });

      expect(res.status).toBe(401);
      expect(rpcCalls).toEqual([]);
    });

    it("reports 503 (not 200) when the deployment has no token configured", async () => {
      delete process.env["CI_ENUM_CHECK_TOKEN"];
      const { GET } = await getHandler();
      const res = await GET({ request: request(TOKEN) });

      expect(res.status).toBe(503);
      expect(await res.json()).toMatchObject({ error: "endpoint_not_configured" });
      expect(rpcCalls).toEqual([]);
    });

    it("accepts the exact token", async () => {
      const { GET } = await getHandler();
      const res = await GET({ request: request(TOKEN) });

      expect(res.status).toBe(200);
      expect(rpcCalls).toEqual(["logs_action_type_whitelist_ci"]);
    });
  });

  describe("returns the same enum values as logs_action_type_check", () => {
    it("matches the generated enum exactly, in order", async () => {
      const { GET } = await getHandler();
      const res = await GET({ request: request(TOKEN) });
      const body = (await res.json()) as { allowed_values: string[]; count: number; constraint: string };

      expect(body.constraint).toBe(LOGS_ACTION_TYPE_CONSTRAINT);
      expect(body.allowed_values).toEqual([...LOG_ACTION_TYPES]);
      expect(body.count).toBe(LOG_ACTION_TYPES.length);
      // The payload agrees with the rendered CHECK definition, i.e. the values
      // really came from the constraint and not from some other list.
      const fromDefinition = [...renderCheckDefinition(constraintValues).matchAll(/'([^']+)'::text/g)].map(
        (m) => m[1],
      );
      expect(body.allowed_values).toEqual(fromDefinition);
    });

    it("surfaces a drifted constraint rather than the generated file", async () => {
      // Simulates a migration that added a value without regenerating the file:
      // the endpoint must report the DATABASE truth so CI can fail the drift check.
      constraintValues = [...LOG_ACTION_TYPES, "brand_new_action"];
      const { GET } = await getHandler();
      const res = await GET({ request: request(TOKEN) });
      const body = (await res.json()) as { allowed_values: string[]; count: number };

      expect(body.allowed_values).toContain("brand_new_action");
      expect(body.count).toBe(LOG_ACTION_TYPES.length + 1);
      expect(body.allowed_values).not.toEqual([...LOG_ACTION_TYPES]);
    });

    it("exposes only whitelist metadata — no rows, no PII", async () => {
      const { GET } = await getHandler();
      const res = await GET({ request: request(TOKEN) });
      const body = (await res.json()) as Record<string, unknown>;

      expect(Object.keys(body).sort()).toEqual(
        ["allowed_values", "constraint", "count", "read_at", "source"].sort(),
      );
      expect(body["source"]).toBe("pg_constraint");
      expect(res.headers.get("Cache-Control")).toBe("no-store");
    });

    it("fails loudly when the constraint cannot be read", async () => {
      rpcError = { message: "permission denied for function" };
      const { GET } = await getHandler();
      const res = await GET({ request: request(TOKEN) });

      expect(res.status).toBe(502);
      expect(await res.json()).toMatchObject({ error: "constraint_read_failed" });
    });

    it("fails when the constraint returns an empty whitelist", async () => {
      constraintValues = [];
      const { GET } = await getHandler();
      const res = await GET({ request: request(TOKEN) });

      expect(res.status).toBe(502);
      expect(await res.json()).toMatchObject({ error: "constraint_not_found" });
    });
  });

  it("exposes no write handlers", async () => {
    const handlers = await getHandler();
    expect(Object.keys(handlers).sort()).toEqual(["GET", "OPTIONS"]);
  });
});
