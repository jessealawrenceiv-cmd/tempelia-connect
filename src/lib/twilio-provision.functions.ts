import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

interface ProvisionInput {
  areaCode?: string;
}

type ProvisionResult =
  | { ok: true; phoneNumber: string; alreadyProvisioned: boolean }
  | { ok: false; errorCode: "twilio_setup" | "no_numbers" | "twilio_unavailable"; message: string };

function validateInput(data: unknown): ProvisionInput {
  if (data === undefined || data === null) return {};
  if (typeof data !== "object") throw new Error("Invalid input");
  const { areaCode } = data as { areaCode?: unknown };
  if (areaCode === undefined || areaCode === null || areaCode === "") return {};
  if (typeof areaCode !== "string" || !/^\d{3}$/.test(areaCode)) {
    throw new Error("Area code must be exactly 3 digits.");
  }
  return { areaCode };
}

// Idempotent auto-provisioning: if this tenant already has a number, return it.
// Otherwise buy the first available US local number (optionally scoped to an area code).
export const provisionTenantNumber = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(validateInput)
  .handler(async ({ data, context }): Promise<ProvisionResult> => {
    const { supabase, userId } = context;

    const { data: prof, error: profErr } = await supabase
      .from("profiles").select("twilio_phone_number").eq("id", userId).maybeSingle();
    if (profErr) throw new Error(profErr.message);
    if (prof?.twilio_phone_number) {
      return { ok: true, phoneNumber: prof.twilio_phone_number, alreadyProvisioned: true };
    }

    const { purchaseLocalNumber } = await import("./twilio.server");
    let phoneNumber: string;
    let phoneSid: string;
    try {
      const purchased = await purchaseLocalNumber(data.areaCode);
      phoneNumber = purchased.phoneNumber;
      phoneSid = purchased.phoneSid;
    } catch (error) {
      const rawMessage = error instanceof Error ? error.message : "Twilio provisioning failed.";
      console.error("Twilio provisioning failed", rawMessage);

      if (rawMessage.includes("401") || rawMessage.includes("Policy evaluation failed") || rawMessage.includes("TWILIO_ACCOUNT_SID")) {
        return {
          ok: false,
          errorCode: "twilio_setup",
          message:
            "Tempelia couldn't provision a number because Twilio rejected the saved credentials. Update the Twilio Account SID/Auth Token and make sure the account can buy phone numbers, then retry.",
        };
      }

      if (rawMessage.includes("No numbers available") || rawMessage.includes("Area code")) {
        return { ok: false, errorCode: "no_numbers", message: rawMessage };
      }

      return {
        ok: false,
        errorCode: "twilio_unavailable",
        message: "Tempelia couldn't provision a number right now. Please retry in a moment.",
      };
    }

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
      message_sent: `Auto-provisioned ${phoneNumber} (${phoneSid})`,
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
