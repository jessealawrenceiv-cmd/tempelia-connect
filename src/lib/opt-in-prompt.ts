export const OPT_IN_PROMPT_ACTION = "opt_in_prompt";

/** Default minutes to wait between opt-in prompts to the same contact. */
export const OPT_IN_PROMPT_COOLDOWN_MINUTES = 60;
export const OPT_IN_PROMPT_COOLDOWN_MIN = 5;
export const OPT_IN_PROMPT_COOLDOWN_MAX = 1440;
export const OPT_IN_PROMPT_TEMPLATE_MAX_LENGTH = 300;

/** Default lead-in, before the fixed compliance sentence. */
export const DEFAULT_OPT_IN_PROMPT_TEMPLATE = "{business}:";

/**
 * The non-negotiable compliance body. Mirrors the confirmation copy the
 * inbound SMS webhook returns for START / YES / UNSTOP and is always appended,
 * regardless of the owner's custom lead-in.
 */
export const OPT_IN_PROMPT_COMPLIANCE_TEXT =
  "Reply YES to receive recurring text messages regarding your inquiry, appointment updates, and reviews. Message frequency varies. Message and data rates may apply. Reply STOP to unsubscribe.";

export function clampCooldownMinutes(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return OPT_IN_PROMPT_COOLDOWN_MINUTES;
  return Math.min(OPT_IN_PROMPT_COOLDOWN_MAX, Math.max(OPT_IN_PROMPT_COOLDOWN_MIN, Math.round(n)));
}

/**
 * Builds the outbound opt-in invitation. The owner controls only the lead-in
 * (via `template`, where `{business}` is substituted); the compliant
 * YES-to-opt-in / STOP-to-unsubscribe body is always included verbatim.
 */
export function buildOptInPrompt(businessName: string, template?: string | null): string {
  const name = businessName || "Our team";
  const leadIn = (template && template.trim() ? template : DEFAULT_OPT_IN_PROMPT_TEMPLATE)
    .replace(/\{business\}/g, name)
    .trim()
    .slice(0, OPT_IN_PROMPT_TEMPLATE_MAX_LENGTH);
  return `${leadIn} ${OPT_IN_PROMPT_COMPLIANCE_TEXT}`.trim();
}
