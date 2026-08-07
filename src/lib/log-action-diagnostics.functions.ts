import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import {
  LOG_ACTION_TYPES,
  LOGS_ACTION_TYPE_CONSTRAINT,
} from "@/lib/log-action-types.generated";

export interface DriftRun {
  id: string;
  matched: boolean;
  ranAt: string;
  detail: string | null;
  dbValues: string[];
  generatedValues: string[];
}

export interface LogActionDiagnostics {
  constraintName: string;
  constraintDef: string | null;
  generatedValues: string[];
  dbValues: string[];
  matched: boolean;
  missingInDb: string[];
  missingInGenerated: string[];
  orderDiffers: boolean;
  lastSuccessfulRun: DriftRun | null;
  lastRun: DriftRun | null;
}

interface WhitelistRow {
  constraint_name: string;
  constraint_def: string | null;
  allowed_values: string[] | null;
}

const mapRun = (r: {
  id: string;
  matched: boolean;
  ran_at: string;
  detail: string | null;
  db_values: string[];
  generated_values: string[];
}): DriftRun => ({
  id: r.id,
  matched: r.matched,
  ranAt: r.ran_at,
  detail: r.detail,
  dbValues: r.db_values ?? [],
  generatedValues: r.generated_values ?? [],
});

export const getLogActionDiagnostics = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }): Promise<LogActionDiagnostics> => {
    const { supabase } = context;

    const { data: isAdmin, error: roleErr } = await supabase.rpc("has_role", { _role: "admin" });
    if (roleErr) throw new Error(roleErr.message);
    if (!isAdmin) throw new Error("Forbidden");

    const { data: whitelist, error: wlErr } = await supabase.rpc("logs_action_type_whitelist");
    if (wlErr) throw new Error(wlErr.message);

    const row = (Array.isArray(whitelist) ? whitelist[0] : whitelist) as WhitelistRow | undefined;
    const dbValues = row?.allowed_values ?? [];
    const generatedValues = [...LOG_ACTION_TYPES];

    const dbSet = new Set(dbValues);
    const genSet = new Set(generatedValues);
    const missingInDb = generatedValues.filter((v) => !dbSet.has(v));
    const missingInGenerated = dbValues.filter((v) => !genSet.has(v));
    const orderDiffers =
      missingInDb.length === 0 &&
      missingInGenerated.length === 0 &&
      dbValues.join("|") !== generatedValues.join("|");
    const matched = missingInDb.length === 0 && missingInGenerated.length === 0 && !orderDiffers;

    const { data: runs, error: runsErr } = await supabase
      .from("log_action_type_drift_runs")
      .select("id, matched, ran_at, detail, db_values, generated_values")
      .order("ran_at", { ascending: false })
      .limit(25);
    if (runsErr) throw new Error(runsErr.message);

    const mapped = (runs ?? []).map(mapRun);

    return {
      constraintName: row?.constraint_name ?? LOGS_ACTION_TYPE_CONSTRAINT,
      constraintDef: row?.constraint_def ?? null,
      generatedValues,
      dbValues,
      matched,
      missingInDb,
      missingInGenerated,
      orderDiffers,
      lastRun: mapped[0] ?? null,
      lastSuccessfulRun: mapped.find((r) => r.matched) ?? null,
    };
  });

export const runLogActionDriftCheck = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }): Promise<LogActionDiagnostics> => {
    const { supabase, userId } = context;

    const { data: isAdmin, error: roleErr } = await supabase.rpc("has_role", { _role: "admin" });
    if (roleErr) throw new Error(roleErr.message);
    if (!isAdmin) throw new Error("Forbidden");

    const { data: whitelist, error: wlErr } = await supabase.rpc("logs_action_type_whitelist");
    if (wlErr) throw new Error(wlErr.message);

    const row = (Array.isArray(whitelist) ? whitelist[0] : whitelist) as WhitelistRow | undefined;
    const dbValues = row?.allowed_values ?? [];
    const generatedValues = [...LOG_ACTION_TYPES];

    const dbSet = new Set(dbValues);
    const genSet = new Set(generatedValues);
    const missingInDb = generatedValues.filter((v) => !dbSet.has(v));
    const missingInGenerated = dbValues.filter((v) => !genSet.has(v));
    const sameSet = missingInDb.length === 0 && missingInGenerated.length === 0;
    const orderDiffers = sameSet && dbValues.join("|") !== generatedValues.join("|");
    const matched = sameSet && !orderDiffers;

    const detail = matched
      ? `${dbValues.length} values match exactly, in order`
      : [
          missingInDb.length ? `in code but not in database: ${missingInDb.join(", ")}` : null,
          missingInGenerated.length
            ? `in database but not in code: ${missingInGenerated.join(", ")}`
            : null,
          orderDiffers ? "same values, different order" : null,
        ]
          .filter(Boolean)
          .join(" · ");

    const { error: insErr } = await supabase.from("log_action_type_drift_runs").insert({
      actor_user_id: userId,
      matched,
      constraint_name: row?.constraint_name ?? LOGS_ACTION_TYPE_CONSTRAINT,
      db_values: dbValues,
      generated_values: generatedValues,
      detail,
    });
    if (insErr) throw new Error(insErr.message);

    const { data: runs, error: runsErr } = await supabase
      .from("log_action_type_drift_runs")
      .select("id, matched, ran_at, detail, db_values, generated_values")
      .order("ran_at", { ascending: false })
      .limit(25);
    if (runsErr) throw new Error(runsErr.message);

    const mapped = (runs ?? []).map(mapRun);

    return {
      constraintName: row?.constraint_name ?? LOGS_ACTION_TYPE_CONSTRAINT,
      constraintDef: row?.constraint_def ?? null,
      generatedValues,
      dbValues,
      matched,
      missingInDb,
      missingInGenerated,
      orderDiffers,
      lastRun: mapped[0] ?? null,
      lastSuccessfulRun: mapped.find((r) => r.matched) ?? null,
    };
  });
