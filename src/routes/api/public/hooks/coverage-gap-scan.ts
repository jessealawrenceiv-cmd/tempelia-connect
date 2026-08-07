import { createFileRoute } from "@tanstack/react-router";

/**
 * Scheduled coverage-gap scan (pg_cron -> this endpoint).
 *
 * Persists every high-severity activity-log coverage gap, escalates gaps that
 * have now persisted for more than 24 hours, and resolves the ones that cleared.
 * Callers authenticate with the project's publishable key in the `apikey`
 * header; the response contains counts only, never tenant PII.
 */
export const Route = createFileRoute("/api/public/hooks/coverage-gap-scan")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const expected =
          process.env["SUPABASE_PUBLISHABLE_KEY"] ?? process.env["VITE_SUPABASE_PUBLISHABLE_KEY"];
        const presented =
          request.headers.get("apikey") ??
          request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ??
          "";

        if (!expected || presented !== expected) {
          return new Response(JSON.stringify({ error: "Unauthorized" }), {
            status: 401,
            headers: { "Content-Type": "application/json" },
          });
        }

        try {
          const { syncCoverageGapAlerts } = await import("@/lib/coverage-gap-alerts.server");
          const summary = await syncCoverageGapAlerts({ scope: "scheduled" });
          return Response.json({ success: true, ...summary });
        } catch (err) {
          const message = err instanceof Error ? err.message : "Scan failed";
          console.error("coverage-gap-scan failed:", message);
          return new Response(JSON.stringify({ success: false, error: message }), {
            status: 500,
            headers: { "Content-Type": "application/json" },
          });
        }
      },
    },
  },
});
