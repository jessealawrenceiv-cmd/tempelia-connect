/**
 * GET /api/public/log-action-types/constraint
 *
 * Token-gated, read-only mirror of the LIVE `logs_action_type_check` CHECK
 * constraint on public.logs. This is the authoritative source CI compares
 * `src/lib/log-action-types.generated.ts` against — unlike the sibling public
 * endpoint, whose payload is derived from the generated file itself (comparing
 * that to the file would compare the file to itself and always pass).
 *
 * Security envelope, deliberately narrow:
 *   - requires `Authorization: Bearer $CI_ENUM_CHECK_TOKEN` (timing-safe compare)
 *   - GET/OPTIONS only; no write path of any kind
 *   - the only data reachable is the constraint's allowed value list — the
 *     handler calls one SECURITY DEFINER function that reads `pg_constraint`
 *     and returns nothing else. No table rows, no PII, no arbitrary SQL.
 */
import { createFileRoute } from "@tanstack/react-router";
import { timingSafeEqual } from "crypto";

const NO_STORE = { "Cache-Control": "no-store" } as const;

function tokenMatches(presented: string, expected: string): boolean {
  const a = Buffer.from(presented);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  try {
    return timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

type WhitelistRow = {
  constraint_name: string | null;
  constraint_def: string | null;
  allowed_values: string[] | null;
};

export const Route = createFileRoute("/api/public/log-action-types/constraint")({
  server: {
    handlers: {
      OPTIONS: async () =>
        new Response(null, {
          status: 204,
          headers: { Allow: "GET, OPTIONS", ...NO_STORE },
        }),
      GET: async ({ request }) => {
        // Read the secret at call time: env is injected per request.
        const expected = process.env["CI_ENUM_CHECK_TOKEN"];
        if (!expected) {
          return Response.json(
            { error: "endpoint_not_configured", detail: "CI_ENUM_CHECK_TOKEN is not set." },
            { status: 503, headers: NO_STORE },
          );
        }

        const header = request.headers.get("authorization") ?? "";
        const presented = header.toLowerCase().startsWith("bearer ") ? header.slice(7).trim() : "";
        if (!presented || !tokenMatches(presented, expected)) {
          return Response.json(
            { error: "unauthorized", detail: "Send Authorization: Bearer <CI_ENUM_CHECK_TOKEN>." },
            { status: 401, headers: { ...NO_STORE, "WWW-Authenticate": "Bearer" } },
          );
        }

        const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
        const { data, error } = await supabaseAdmin.rpc("logs_action_type_whitelist");
        if (error) {
          return Response.json(
            { error: "constraint_read_failed", detail: error.message },
            { status: 502, headers: NO_STORE },
          );
        }

        const row = (Array.isArray(data) ? data[0] : data) as WhitelistRow | undefined;
        const allowed = row?.allowed_values ?? [];
        if (!row || allowed.length === 0) {
          return Response.json(
            {
              error: "constraint_not_found",
              detail: "logs_action_type_check returned no allowed values.",
            },
            { status: 502, headers: NO_STORE },
          );
        }

        // Exactly one thing is exposed: the live whitelist, in constraint order.
        return Response.json(
          {
            constraint: row.constraint_name ?? "logs_action_type_check",
            allowed_values: allowed,
            count: allowed.length,
            source: "pg_constraint",
            read_at: new Date().toISOString(),
          },
          { headers: NO_STORE },
        );
      },
    },
  },
});
