export const OPT_IN_PROMPT_ACTION = "opt_in_prompt";
/** Owner-initiated test send of the opt-in prompt to their own mobile. */
export const OPT_IN_PROMPT_TEST_ACTION = "opt_in_prompt_test";

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

export type TemplateIssue = { level: "error" | "warning"; message: string };

/** The only placeholder the lead-in supports. */
export const OPT_IN_PROMPT_PLACEHOLDERS = ["business"] as const;

/**
 * Validates the owner's lead-in template. Errors block saving; warnings are
 * advisory (e.g. a missing {business} placeholder, which means the message
 * goes out without naming the sender). The compliant YES-to-opt-in / STOP body
 * is appended separately and is never validated or altered here.
 */
export function validateOptInPromptTemplate(raw: string | null | undefined): TemplateIssue[] {
  const issues: TemplateIssue[] = [];
  const value = (raw ?? "").trim();

  if (value.length > OPT_IN_PROMPT_TEMPLATE_MAX_LENGTH) {
    issues.push({
      level: "error",
      message: `Lead-in must be ${OPT_IN_PROMPT_TEMPLATE_MAX_LENGTH} characters or fewer (currently ${value.length}).`,
    });
  }

  const tokens = value.match(/\{[^{}]*\}/g) ?? [];
  const unknown = Array.from(
    new Set(
      tokens.filter(
        (t) => !OPT_IN_PROMPT_PLACEHOLDERS.includes(t.slice(1, -1).trim().toLowerCase() as "business"),
      ),
    ),
  );
  if (unknown.length > 0) {
    issues.push({
      level: "error",
      message: `Unsupported placeholder ${unknown.join(", ")} — only {business} is available, and anything else is sent literally.`,
    });
  }

  if (/\{[^{}]*$|^[^{}]*\}/.test(value) && tokens.length === 0 && /[{}]/.test(value)) {
    issues.push({
      level: "error",
      message: "Unbalanced braces — write the placeholder exactly as {business}.",
    });
  }

  if (value && !/\{business\}/.test(value)) {
    if (/\{\s*business\s*\}/i.test(value)) {
      issues.push({
        level: "error",
        message: "Placeholder must be written exactly as {business} — lowercase, no spaces.",
      });
    } else {
      issues.push({
        level: "warning",
        message:
          "No {business} placeholder — the prompt will go out without naming your business. Carriers expect the sender to be identified.",
      });
    }
  }

  return issues;
}

/**
 * Stable, short fingerprint of a rendered prompt body (FNV-1a, 8 hex chars).
 * Recorded on each opt-in attempt so you can tell which wording version went
 * out, without storing the whole message twice.
 */
export function promptVersionHash(body: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < body.length; i++) {
    h ^= body.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}
