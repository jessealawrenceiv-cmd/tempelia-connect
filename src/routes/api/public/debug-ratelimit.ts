// TEMPORARY DEBUG ENDPOINT — mirrors the two-tier rate-limit check in submitIntake. Remove after verification.
import { createFileRoute } from "@tanstack/react-router";
import { getRequestHeader } from "@tanstack/react-start/server";
import { createHash } from "crypto";
import { INTAKE_LIMITS } from "@/lib/intake.functions";

function clientIp(): string {
  const cf = getRequestHeader("cf-connecting-ip");
  if (cf) return cf.trim();
  const real = getRequestHeader("x-real-ip");
  if (real) return real.trim();
  const fwd = getRequestHeader("x-forwarded-for") || "";
  const parts = fwd.split(",").map((s) => s.trim()).filter(Boolean);
  return parts[parts.length - 1] || "0.0.0.0";
}
const hashIp = (ip: string) => createHash("sha256").update(ip).digest("hex").slice(0, 32);

export const Route = createFileRoute("/api/public/debug-ratelimit")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const { userId } = (await request.json()) as { userId: string };
        const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

        const ipHash = hashIp(clientIp());
        const perIpWindow = new Date(
          Date.now() - INTAKE_LIMITS.RATE_LIMIT_WINDOW_MIN * 60_000,
        ).toISOString();
        const bizWindow = new Date(
          Date.now() - INTAKE_LIMITS.BUSINESS_CEILING_WINDOW_MIN * 60_000,
        ).toISOString();

        const { count: perIpCount } = await supabaseAdmin
          .from("intake_rate_limits")
          .select("id", { count: "exact", head: true })
          .eq("user_id", userId)
          .eq("ip_hash", ipHash)
          .gte("submitted_at", perIpWindow);
        if ((perIpCount ?? 0) >= INTAKE_LIMITS.RATE_LIMIT_MAX) {
          return Response.json(
            { ok: false, blocked_by: "per_ip", error: "Too many submissions. Please try again later.", perIpCount },
            { status: 429 },
          );
        }

        const { count: perBizCount } = await supabaseAdmin
          .from("intake_rate_limits")
          .select("id", { count: "exact", head: true })
          .eq("user_id", userId)
          .gte("submitted_at", bizWindow);
        if ((perBizCount ?? 0) >= INTAKE_LIMITS.BUSINESS_CEILING_MAX) {
          return Response.json(
            {
              ok: false,
              blocked_by: "per_business_ceiling",
              error: "This form is temporarily paused due to unusual traffic. Try again later.",
              perBizCount,
              ceiling: INTAKE_LIMITS.BUSINESS_CEILING_MAX,
            },
            { status: 429 },
          );
        }

        return Response.json({ ok: true, perIpCount, perBizCount });
      },
    },
  },
});
