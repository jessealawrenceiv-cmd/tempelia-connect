import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { validateSaveOptInPromptSettings } from "./opt-in-prompt-settings";

export const saveOptInPromptSettings = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(validateSaveOptInPromptSettings)
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
