/**
 * GET|OPTIONS /api/public/log-action-types/token-check
 *
 * Verification-only companion to the constraint endpoint. It answers one
 * question — "does the token CI holds match the one this deployment holds?" —
 * and touches no database at all (no Supabase client is loaded here).
 *
 * Response never contains a secret: only a truncated SHA-256 fingerprint, so
 * the two sides can be compared without either revealing the token.
 */
import { createFileRoute } from "@tanstack/react-router";
import { createHash, timingSafeEqual } from "crypto";

const NO_STORE = { "Cache-Control": "no-store" } as const;

/** First 12 hex chars of sha256(token) — enough to compare, useless to replay. */
function fingerprint(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex").slice(0, 12);
}

function tokenMatches(presented: string, expected: string): boolean {
  // Hash both sides first so lengths always match and length can't leak.
  const a = createHash("sha256").update(presented, "utf8").digest();
  const b = createHash("sha256").update(expected, "utf8").digest();
  try {
    return timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

export const Route = createFileRoute("/api/public/log-action-types/token-check")({
  server: {
    handlers: {
      OPTIONS: async () =>
        new Response(null, {
          status: 204,
          headers: { Allow: "GET, OPTIONS", ...NO_STORE },
        }),
      GET: async ({ request }) => {
        const expected = process.env["CI_ENUM_CHECK_TOKEN"];
        if (!expected) {
          return Response.json(
            {
              ok: false,
              error: "endpoint_not_configured",
              detail: "This deployment has no CI_ENUM_CHECK_TOKEN configured.",
            },
            { status: 503, headers: NO_STORE },
          );
        }

        const header = request.headers.get("authorization") ?? "";
        const presented = header.toLowerCase().startsWith("bearer ") ? header.slice(7).trim() : "";

        if (!presented || !tokenMatches(presented, expected)) {
          return Response.json(
            {
              ok: false,
              error: "token_mismatch",
              detail:
                "The presented token does not match this deployment. Rotate the app secret and the CI_ENUM_CHECK_TOKEN repository secret so both sides match.",
              expected_fingerprint: fingerprint(expected),
              presented_fingerprint: presented ? fingerprint(presented) : null,
            },
            { status: 401, headers: { ...NO_STORE, "WWW-Authenticate": "Bearer" } },
          );
        }

        return Response.json(
          {
            ok: true,
            fingerprint: fingerprint(expected),
            token_length: expected.length,
            scope: "read-only log_action_type constraint whitelist",
            database_access: false,
            checked_at: new Date().toISOString(),
          },
          { headers: NO_STORE },
        );
      },
    },
  },
});
