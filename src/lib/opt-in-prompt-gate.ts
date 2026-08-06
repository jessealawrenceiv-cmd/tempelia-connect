/**
 * Compliance gate for the manual opt-in prompt.
 *
 * 1. HOLD: real sends to real customer numbers are disabled until the A2P
 *    campaign covers "we proactively text someone who contacted us but never
 *    consented, asking them to opt in". Test sends to the owner's own number
 *    are unaffected.
 * 2. PERMANENT RULE (independent of the hold, see inbound-engagement.server.ts):
 *    a contact is only ever eligible if there is a real inbound engagement row
 *    on record (they actually called or texted this business). Imported,
 *    never-engaged contacts are never eligible.
 */
export const OPT_IN_PROMPT_REAL_SENDS_ENABLED = false;

export const OPT_IN_PROMPT_HOLD_REASON =
  "Opt-in prompts to customers are on hold pending carrier (A2P) registration of this message type. Test sends to your own number still work.";

/** Human-readable copy of the permanent eligibility rule, for UI surfaces. */
export const OPT_IN_PROMPT_ENGAGEMENT_RULE =
  "Only contacts with a recorded inbound call or text to your Temaro number can ever receive this prompt.";
