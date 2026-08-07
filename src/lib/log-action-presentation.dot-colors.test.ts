import { describe, it, expect } from "vitest";
import { LOG_ACTION_PRESENTATION } from "./log-action-presentation";
import { LOG_ACTION_TYPES } from "./log-action-types.generated";

/**
 * Fast, always-run companion to the Playwright visual baselines: the dot color
 * per action type is a design contract. A refactor that renames a token or
 * reshuffles the map would change the meaning of the dispatch log without
 * breaking any behavioral test, so the exact class per action type is locked
 * here and only changes with an intentional edit to this file.
 */
describe("status dot color contract", () => {
  const ALLOWED = new Set(["bg-orange", "bg-moss", "bg-steel", "bg-primary", "bg-muted-foreground"]);

  it("every known action type has a dot class from the design tokens", () => {
    for (const type of LOG_ACTION_TYPES) {
      const dot = LOG_ACTION_PRESENTATION[type]?.dot;
      expect(dot, `missing dot for ${type}`).toBeTruthy();
      // Hardcoded colors (bg-red-500, bg-[#fff]) bypass theming entirely.
      expect(ALLOWED.has(dot!), `${type} uses non-token dot "${dot}"`).toBe(true);
    }
  });

  it("uses more than one color so statuses stay distinguishable", () => {
    const used = new Set(LOG_ACTION_TYPES.map((t) => LOG_ACTION_PRESENTATION[t]?.dot));
    expect(used.size).toBeGreaterThan(2);
  });

  it("keeps the per-action dot assignment stable", () => {
    const map = Object.fromEntries(
      [...LOG_ACTION_TYPES].sort().map((t) => [t, LOG_ACTION_PRESENTATION[t]?.dot]),
    );
    expect(map).toMatchSnapshot();
  });
});
