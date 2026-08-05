import { describe, expect, it } from "vitest";
import { validateSaveOptInPromptSettings } from "./opt-in-prompt-settings";
import { OPT_IN_PROMPT_TEMPLATE_MAX_LENGTH } from "./opt-in-prompt";

describe("validateSaveOptInPromptSettings (server-side gate)", () => {
  it("accepts a valid template and clamps the cooldown", () => {
    expect(validateSaveOptInPromptSettings({ template: " {business}: ", cooldownMinutes: 1 })).toEqual({
      template: "{business}:",
      cooldownMinutes: 5,
    });
    expect(
      validateSaveOptInPromptSettings({ template: "Hi from {business}", cooldownMinutes: 99999 }),
    ).toEqual({ template: "Hi from {business}", cooldownMinutes: 1440 });
  });

  it("normalizes blank templates to null (default lead-in)", () => {
    for (const template of ["", "   ", null, undefined]) {
      expect(validateSaveOptInPromptSettings({ template, cooldownMinutes: 60 }).template).toBeNull();
    }
  });

  it("allows a missing placeholder (warning only, not blocking)", () => {
    expect(
      validateSaveOptInPromptSettings({ template: "Quick question:", cooldownMinutes: 60 }).template,
    ).toBe("Quick question:");
  });

  it.each([
    ["wrong case", "{Business}:", /exactly as \{business\}/],
    ["upper case", "{BUSINESS}:", /exactly as \{business\}/],
    ["spaced", "{ business }:", /exactly as \{business\}|Unsupported placeholder/],
    ["unsupported", "{business} for {customer}", /Unsupported placeholder/],
    ["unbalanced", "{business", /Unbalanced braces/],
  ])("rejects %s templates", (_label, template, pattern) => {
    expect(() => validateSaveOptInPromptSettings({ template, cooldownMinutes: 60 })).toThrow(
      pattern as RegExp,
    );
  });

  it("rejects an over-long template", () => {
    expect(() =>
      validateSaveOptInPromptSettings({
        template: "{business} " + "x".repeat(OPT_IN_PROMPT_TEMPLATE_MAX_LENGTH),
        cooldownMinutes: 60,
      }),
    ).toThrow(/characters or fewer/);
  });

  it("rejects non-string templates", () => {
    expect(() =>
      validateSaveOptInPromptSettings({ template: 42 as unknown as string, cooldownMinutes: 60 }),
    ).toThrow(/must be a string/);
  });

  it("falls back to the default cooldown for garbage values", () => {
    expect(
      validateSaveOptInPromptSettings({ template: "{business}:", cooldownMinutes: "abc" as never })
        .cooldownMinutes,
    ).toBe(60);
  });
});
