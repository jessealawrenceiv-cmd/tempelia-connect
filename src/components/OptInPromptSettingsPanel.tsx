import { useEffect, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import {
  DEFAULT_OPT_IN_PROMPT_TEMPLATE,
  OPT_IN_PROMPT_COOLDOWN_MAX,
  OPT_IN_PROMPT_COOLDOWN_MIN,
  OPT_IN_PROMPT_COOLDOWN_MINUTES,
  OPT_IN_PROMPT_TEMPLATE_MAX_LENGTH,
  buildOptInPrompt,
  clampCooldownMinutes,
} from "@/lib/opt-in-prompt";

type Props = {
  businessName?: string | null;
  template?: string | null;
  cooldownMinutes?: number | null;
};

/**
 * Owner-configurable lead-in and cooldown for the missed-call opt-in prompt.
 * The compliant YES-to-opt-in / STOP body is fixed and always appended.
 */
export function OptInPromptSettingsPanel({ businessName, template, cooldownMinutes }: Props) {
  const qc = useQueryClient();
  const [draft, setDraft] = useState("");
  const [cooldown, setCooldown] = useState(String(OPT_IN_PROMPT_COOLDOWN_MINUTES));

  useEffect(() => {
    setDraft(template ?? DEFAULT_OPT_IN_PROMPT_TEMPLATE);
  }, [template]);

  useEffect(() => {
    setCooldown(String(cooldownMinutes ?? OPT_IN_PROMPT_COOLDOWN_MINUTES));
  }, [cooldownMinutes]);

  const save = useMutation({
    mutationFn: async () => {
      const { data: u } = await supabase.auth.getUser();
      if (!u.user) throw new Error("Not signed in");
      const trimmed = draft.trim();
      if (trimmed.length > OPT_IN_PROMPT_TEMPLATE_MAX_LENGTH) {
        throw new Error(`Lead-in must be ${OPT_IN_PROMPT_TEMPLATE_MAX_LENGTH} characters or fewer.`);
      }
      const { error } = await supabase
        .from("profiles")
        .update({
          opt_in_prompt_template: trimmed || null,
          opt_in_prompt_cooldown_minutes: clampCooldownMinutes(cooldown),
        })
        .eq("id", u.user.id);
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Opt-in prompt settings saved.");
      qc.invalidateQueries({ queryKey: ["profile"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const preview = buildOptInPrompt(businessName ?? "", draft);

  return (
    <div className="panel p-6 md:col-span-2">
      <div className="label-eyebrow">Missed-call automation</div>
      <h2 className="mt-1 text-xl">Opt-in prompt & cooldown</h2>
      <p className="mt-2 text-xs text-muted-foreground">
        You control the lead-in only. The compliant YES-to-opt-in and STOP-to-unsubscribe language is
        always appended automatically and cannot be edited.
      </p>

      <div className="mt-4 grid gap-4 md:grid-cols-2">
        <label className="block">
          <span className="label-eyebrow">Lead-in template</span>
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            rows={3}
            maxLength={OPT_IN_PROMPT_TEMPLATE_MAX_LENGTH}
            placeholder={DEFAULT_OPT_IN_PROMPT_TEMPLATE}
            className="mono mt-1 block w-full rounded-sm border border-border bg-background px-3 py-2 text-sm"
          />
          <span className="mono mt-1 block text-[10px] uppercase tracking-widest text-muted-foreground">
            {"{business}"} is replaced with your business name · {draft.length}/
            {OPT_IN_PROMPT_TEMPLATE_MAX_LENGTH}
          </span>
        </label>

        <label className="block">
          <span className="label-eyebrow">Cooldown between prompts (minutes)</span>
          <input
            type="number"
            min={OPT_IN_PROMPT_COOLDOWN_MIN}
            max={OPT_IN_PROMPT_COOLDOWN_MAX}
            value={cooldown}
            onChange={(e) => setCooldown(e.target.value)}
            className="mono mt-1 block w-full rounded-sm border border-border bg-background px-3 py-2 text-sm"
          />
          <span className="mono mt-1 block text-[10px] uppercase tracking-widest text-muted-foreground">
            {OPT_IN_PROMPT_COOLDOWN_MIN}–{OPT_IN_PROMPT_COOLDOWN_MAX} min · applied per contact on
            single and bulk sends
          </span>
        </label>
      </div>

      <div className="mt-4 rounded-sm border border-border bg-background/60 p-3">
        <div className="label-eyebrow">Message preview</div>
        <p className="mono mt-2 text-xs leading-relaxed text-paper">{preview}</p>
        <p className="mono mt-2 text-[10px] uppercase tracking-widest text-muted-foreground">
          {preview.length} chars
        </p>
      </div>

      <div className="mt-4 flex flex-wrap gap-3">
        <button
          type="button"
          onClick={() => save.mutate()}
          disabled={save.isPending}
          className="rounded-sm border border-border bg-card px-4 py-2 text-xs uppercase tracking-widest text-paper transition-colors hover:bg-muted disabled:opacity-50"
        >
          {save.isPending ? "Saving…" : "Save prompt settings"}
        </button>
        <button
          type="button"
          onClick={() => {
            setDraft(DEFAULT_OPT_IN_PROMPT_TEMPLATE);
            setCooldown(String(OPT_IN_PROMPT_COOLDOWN_MINUTES));
          }}
          className="rounded-sm border border-border px-4 py-2 text-xs uppercase tracking-widest text-muted-foreground transition-colors hover:text-paper"
        >
          Reset to default
        </button>
      </div>
    </div>
  );
}
