import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import type {
  ActionTypeCoverageReport,
  BusinessCoverage,
} from "@/lib/log-action-coverage.server";

export type { ActionTypeCoverageReport, BusinessCoverage };

export const getActionTypeCoverage = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }): Promise<ActionTypeCoverageReport> => {
    const { supabase, userId } = context;

    const { data: isAdmin, error: roleErr } = await supabase.rpc("has_role", { _role: "admin" });
    if (roleErr) throw new Error(roleErr.message);
    if (!isAdmin) throw new Error("Forbidden");

    const { recordAdminAccess, checkAdminRateLimit } = await import("@/lib/admin-audit.server");
    const rate = await checkAdminRateLimit(userId, "getActionTypeCoverage");
    if (!rate.allowed) {
      await recordAdminAccess({
        actorUserId: userId,
        functionName: "getActionTypeCoverage",
        outcome: "rate_limited",
        detail: `${rate.recentCalls} calls in the last 60s (limit ${rate.limit})`,
      });
      throw new Error(
        `Rate limit exceeded: ${rate.limit} calls/minute for getActionTypeCoverage. Try again in a minute.`,
      );
    }

    const { computeCoverageReport } = await import("@/lib/log-action-coverage.server");
    const report = await computeCoverageReport();

    await recordAdminAccess({
      actorUserId: userId,
      functionName: "getActionTypeCoverage",
      rowCount: report.businesses.length,
      outcome: "allowed",
    });

    return report;
  });
