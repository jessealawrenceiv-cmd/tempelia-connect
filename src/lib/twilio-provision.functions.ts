import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

interface ProvisionInput {
  areaCode: string;
}

function validateInput(data: unknown): ProvisionInput {
  if (!data || typeof data !== "object") throw new Error("Invalid input");
  const { areaCode } = data as { areaCode?: unknown };
  if (typeof areaCode !== "string" || !/^\d{3}$/.test(areaCode)) {
    throw new Error("Area code must be exactly 3 digits.");
  }
  return { areaCode };
}

export const provisionTenantNumber = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(validateInput)
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;

    // Refuse if this tenant already has a number.
    const { data: prof, error: profErr } = await supabase
      .from("profiles").select("twilio_phone_number").eq("id", userId).maybeSingle();
    if (profErr) throw new Error(profErr.message);
    if (prof?.twilio_phone_number) {
      return { ok: true, phoneNumber: prof.twilio_phone_number, alreadyProvisioned: true };
    }

    const { purchaseLocalNumber } = await import("./twilio.server");
    const { phoneNumber, phoneSid } = await purchaseLocalNumber(data.areaCode);

    const { error: updErr } = await supabase
      .from("profiles")
      .update({
        twilio_phone_number: phoneNumber,
        twilio_phone_sid: phoneSid,
        twilio_provisioned_at: new Date().toISOString(),
      })
      .eq("id", userId);
    if (updErr) throw new Error(updErr.message);

    await supabase.from("logs").insert({
      user_id: userId,
      action_type: "number_provisioned",
      status: "sent",
      message_sent: `Provisioned ${phoneNumber} (${phoneSid})`,
    });

    return { ok: true, phoneNumber, alreadyProvisioned: false };
  });

export const getTenantNumber = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { supabase, userId } = context;
    const { data } = await supabase
      .from("profiles")
      .select("twilio_phone_number, twilio_provisioned_at")
      .eq("id", userId)
      .maybeSingle();
    return {
      phoneNumber: data?.twilio_phone_number ?? null,
      provisionedAt: data?.twilio_provisioned_at ?? null,
    };
  });
