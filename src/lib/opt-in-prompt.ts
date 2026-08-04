export const OPT_IN_PROMPT_ACTION = "opt_in_prompt";

/** Minutes to wait between opt-in prompts to the same contact. */
export const OPT_IN_PROMPT_COOLDOWN_MINUTES = 60;

/**
 * The compliant opt-in invitation text. Mirrors the confirmation copy the
 * inbound SMS webhook returns for START / YES / UNSTOP.
 */
export function buildOptInPrompt(businessName: string): string {
  const name = businessName || "Our team";
  return `${name}: Reply YES to receive recurring text messages regarding your inquiry, appointment updates, and reviews. Message frequency varies. Message and data rates may apply. Reply STOP to unsubscribe.`;
}
