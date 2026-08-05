import { describe, expect, it } from "vitest";
import {
  DEFAULT_OPT_IN_PROMPT_TEMPLATE,
  OPT_IN_PROMPT_COMPLIANCE_TEXT,
  OPT_IN_PROMPT_TEMPLATE_MAX_LENGTH,
  buildOptInPrompt,
  clampCooldownMinutes,
  promptVersionHash,
  validateOptInPromptTemplate,
} from "./opt-in-prompt";

const errors = (raw: string | null | undefined) =>
  validateOptInPromptTemplate(raw).filter((i) => i.level === "error");
const warnings = (raw: string | null | undefined) =>
  validateOptInPromptTemplate(raw).filter((i) => i.level === "warning");

describe("validateOptInPromptTemplate — missing placeholder", () => {
  it("warns (does not block) when {business} is absent", () => {
    const issues = validateOptInPromptTemplate("Quick question:");
    expect(errors("Quick question:")).toHaveLength(0);
    expect(warnings("Quick question:")).toHaveLength(1);
    expect(issues[0].message).toMatch(/No \{business\} placeholder/);
  });

  it("returns no issues for empty or nullish templates (default lead-in is used)", () => {
    for (const raw of ["", "   ", null, undefined]) {
      expect(validateOptInPromptTemplate(raw)).toEqual([]);
    }
  });

  it("accepts a correct template with no issues", () => {
    expect(validateOptInPromptTemplate("{business}:")).toEqual([]);
    expect(validateOptInPromptTemplate("Hi from {business} — {business} here")).toEqual([]);
  });
});

describe("validateOptInPromptTemplate — wrong case / spacing", () => {
  it.each(["{Business}:", "{BUSINESS}:", "{ business }:", "{Business Name}"])(
    "errors on %s",
    (raw) => {
      const errs = errors(raw);
      expect(errs.length).toBeGreaterThan(0);
      expect(errs.map((e) => e.message).join(" ")).toMatch(
        /exactly as \{business\}|Unsupported placeholder/,
      );
    },
  );

  it("does not emit the missing-placeholder warning when the intent was clearly a cased variant", () => {
    expect(warnings("{Business}:")).toHaveLength(0);
  });
});

describe("validateOptInPromptTemplate — unsupported placeholders", () => {
  it("errors and names the unsupported token", () => {
    const errs = errors("{business} for {customer}");
    expect(errs).toHaveLength(1);
    expect(errs[0].message).toContain("{customer}");
    expect(errs[0].message).toContain("only {business} is available");
  });

  it("dedupes repeated unsupported tokens", () => {
    const errs = errors("{business} {foo} {foo} {bar}");
    expect(errs).toHaveLength(1);
    expect(errs[0].message.match(/\{foo\}/g)).toHaveLength(1);
    expect(errs[0].message).toContain("{bar}");
  });

  it("errors on unbalanced braces", () => {
    expect(errors("{business").length).toBeGreaterThan(0);
  });

  it("errors when the lead-in exceeds the max length", () => {
    const errs = errors("{business} " + "x".repeat(OPT_IN_PROMPT_TEMPLATE_MAX_LENGTH));
    expect(errs.some((e) => /characters or fewer/.test(e.message))).toBe(true);
  });
});

describe("buildOptInPrompt — compliance body is immutable", () => {
  const cases: Array<[string, string | null | undefined]> = [
    ["missing placeholder", "Quick question:"],
    ["wrong case", "{Business}:"],
    ["spaced placeholder", "{ business }:"],
    ["unsupported placeholder", "{business} for {customer}:"],
    ["unbalanced brace", "{business:"],
    ["empty", ""],
    ["whitespace", "   "],
    ["null", null],
    ["undefined", undefined],
  ];

  it.each(cases)("keeps the YES-to-opt-in language verbatim (%s)", (_label, template) => {
    const body = buildOptInPrompt("Acme Painting", template);
    expect(body.endsWith(OPT_IN_PROMPT_COMPLIANCE_TEXT)).toBe(true);
    expect(body).toContain("Reply YES to receive recurring text messages");
    expect(body).toContain("Reply STOP to unsubscribe.");
    // The compliance sentence appears exactly once.
    expect(body.split(OPT_IN_PROMPT_COMPLIANCE_TEXT)).toHaveLength(2);
  });

  it("substitutes every {business} occurrence and leaves unsupported tokens literal", () => {
    expect(buildOptInPrompt("Acme", "{business} & {business} for {customer}:")).toBe(
      `Acme & Acme for {customer}: ${OPT_IN_PROMPT_COMPLIANCE_TEXT}`,
    );
  });

  it("does not substitute wrong-case placeholders", () => {
    expect(buildOptInPrompt("Acme", "{Business}:")).toBe(
      `{Business}: ${OPT_IN_PROMPT_COMPLIANCE_TEXT}`,
    );
  });

  it("falls back to the default lead-in and a generic name", () => {
    expect(buildOptInPrompt("Acme", "")).toBe(`Acme: ${OPT_IN_PROMPT_COMPLIANCE_TEXT}`);
    expect(buildOptInPrompt("", null)).toBe(`Our team: ${OPT_IN_PROMPT_COMPLIANCE_TEXT}`);
    expect(DEFAULT_OPT_IN_PROMPT_TEMPLATE).toBe("{business}:");
  });

  it("truncates an over-long lead-in without touching the compliance body", () => {
    const body = buildOptInPrompt("Acme", "y".repeat(OPT_IN_PROMPT_TEMPLATE_MAX_LENGTH + 50));
    expect(body).toContain(OPT_IN_PROMPT_COMPLIANCE_TEXT);
    expect(body.replace(` ${OPT_IN_PROMPT_COMPLIANCE_TEXT}`, "")).toHaveLength(
      OPT_IN_PROMPT_TEMPLATE_MAX_LENGTH,
    );
  });

  it("pins the exact compliance sentence (guards against accidental rewording)", () => {
    expect(OPT_IN_PROMPT_COMPLIANCE_TEXT).toBe(
      "Reply YES to receive recurring text messages regarding your inquiry, appointment updates, and reviews. Message frequency varies. Message and data rates may apply. Reply STOP to unsubscribe.",
    );
  });
});

describe("cooldown + version hash", () => {
  it("clamps cooldown minutes into range", () => {
    expect(clampCooldownMinutes(1)).toBe(5);
    expect(clampCooldownMinutes(99999)).toBe(1440);
    expect(clampCooldownMinutes(30.4)).toBe(30);
    expect(clampCooldownMinutes("abc")).toBe(60);
  });

  it("hashes deterministically and differs per body", () => {
    const a = promptVersionHash(buildOptInPrompt("Acme", "{business}:"));
    expect(a).toMatch(/^[0-9a-f]{8}$/);
    expect(promptVersionHash(buildOptInPrompt("Acme", "{business}:"))).toBe(a);
    expect(promptVersionHash(buildOptInPrompt("Acme", "Hi from {business}:"))).not.toBe(a);
  });
});
