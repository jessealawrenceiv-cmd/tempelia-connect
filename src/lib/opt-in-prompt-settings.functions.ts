import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import {
  OPT_IN_PROMPT_TEMPLATE_MAX_LENGTH,
  clampCooldownMinutes,
  validateOptInPromptTemplate,
} from "./opt-in-prompt";

export type SaveOptInPromptSettingsInput = {
  template: string | null;
  cooldownMinutes: number;
};

/**
 * Server-side gatekeeper for the opt-in prompt settings. Applies the exact
 * same {business} placeholder rules as the settings UI, so an invalid template
 * cannot be stored through a direct API call. The database trigger
 * profiles_validate_opt_in_prompt enforces the same rules as a final backstop.
 */
function validateInput(data: unknown): SaveOptInPromptSettingsInput {
  const { template, cooldownMinutes } = (data ?? {}) as {
    template?: unknown;
    cooldownMinutes?: unknown;
  };

  if (template !== null && template !== undefined && typeof template !== "string") {
    throw new Error("Template must be a string.");
  }
  const raw = typeof template === "string" ? template.trim() : "";
  if (raw.length > OPT_IN_PROMPT_TEMPLATE_MAX_LENGTH) {
    throw new Error(
      `Lead-in must be ${OPT_IN_PROMPT_TEMPLATE_MAX_LENGTH} characters or fewer (currently ${raw.length}).`,
    );
  }

  const blocking = validateOptInPromptTemplate(raw).filter((i) => i.level === "error");
  if (blocking.length > 0) throw new Error(blocking[0]!.message);

  return {
    template: raw || null,
    cooldownMinutes: clampCooldownMinutes(cooldownMinutes),
  };
}

export const saveOptInPromptSettings = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(validateInput)
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    const { error } = await supabase
      .from("profiles")
      .update({
        opt_in_prompt_template: data.template,
        opt_in_prompt_cooldown_minutes: data.cooldownMinutes,
      })
      .eq("id", userId);
    if (error) throw new Error(error.message);
    return { template: data.template, cooldownMinutes: data.cooldownMinutes };
  });
