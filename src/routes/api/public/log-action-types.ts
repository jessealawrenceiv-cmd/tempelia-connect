/**
 * GET /api/public/log-action-types
 *
 * Read-only metadata endpoint: the allowed `logs.action_type` whitelist with
 * labels and dot colors, so UIs can render safe dropdowns. No PII, no writes,
 * no database access — the payload is derived from the generated enum that
 * mirrors the `logs_action_type_check` constraint.
 */
import { createFileRoute } from "@tanstack/react-router";

import { buildLogActionTypesResponse } from "@/lib/log-action-types.dto";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
} as const;

export const Route = createFileRoute("/api/public/log-action-types")({
  server: {
    handlers: {
      OPTIONS: async () => new Response(null, { status: 204, headers: CORS_HEADERS }),
      GET: async () => {
        const payload = buildLogActionTypesResponse();
        return Response.json(payload, {
          headers: {
            ...CORS_HEADERS,
            "Cache-Control": "public, max-age=300, stale-while-revalidate=3600",
          },
        });
      },
    },
  },
});
