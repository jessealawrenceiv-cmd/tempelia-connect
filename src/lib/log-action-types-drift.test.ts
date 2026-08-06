/**
 * Drift guard: the generated action_type enum must match the live CHECK constraint.
 * Skipped when service-role credentials are absent.
 */
import { describe, it, expect } from "vitest";
import { createClient } from "@supabase/supabase-js";
import { LOG_ACTION_TYPES, LOGS_ACTION_TYPE_CONSTRAINT } from "./log-action-types.generated";

const url = process.env.SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

describe.skipIf(!(url && serviceKey))("generated log action types", () => {
  it("matches the database constraint values in order", async () => {
    const supabase = createClient(url!, serviceKey!, {
      auth: { persistSession: false, autoRefreshToken: false },
    });

    // Probe every generated value: the DB accepts whitelisted ones, so a rejected
    // value (23514) means the generated file drifted from the constraint.
    const { data: profile } = await supabase.from("profiles").select("id").limit(1).maybeSingle();
    if (!profile) throw new Error("no profiles exist — cannot exercise the logs FK");

    for (const actionType of LOG_ACTION_TYPES) {
      const { data, error } = await supabase
        .from("logs")
        .insert({ user_id: profile.id, action_type: actionType, status: "success" })
        .select("id")
        .maybeSingle();
      expect(error, `${actionType} rejected by ${LOGS_ACTION_TYPE_CONSTRAINT}`).toBeNull();
      if (data?.id) await supabase.from("logs").delete().eq("id", data.id);
    }
  }, 60_000);
});
