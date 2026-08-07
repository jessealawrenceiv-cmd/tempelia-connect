/**
 * Guard: the whitelist of logs.action_type values has exactly one source —
 * src/lib/log-action-types.generated.ts, which is mirrored from the database
 * CHECK constraint by scripts/generate-log-action-types.mjs.
 *
 * These tests fail when app code hardcodes an action_type string literal, which
 * is how frontend and backend drift apart from the database in the first place.
 */

import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { LOG_ACTION_TYPES } from "./log-action-types.generated";

const SRC = join(process.cwd(), "src");

/** Files allowed to spell action types out: the generated list and its tooling. */
const ALLOWLIST = [
  "src/lib/log-action-types.generated.ts",
  "src/integrations/supabase/types.ts",
];

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...walk(full));
    } else if (/\.(ts|tsx)$/.test(entry)) {
      out.push(full);
    }
  }
  return out;
}

function appFiles(): { rel: string; text: string }[] {
  return walk(SRC)
    .map((full) => ({ rel: full.slice(process.cwd().length + 1).replaceAll("\\", "/"), full }))
    .filter(({ rel }) => !ALLOWLIST.includes(rel))
    .filter(({ rel }) => !/\.test\.tsx?$/.test(rel))
    .map(({ rel, full }) => ({ rel, text: readFileSync(full, "utf8") }));
}

describe("log action types single source", () => {
  it("never assigns a hardcoded action_type string literal", () => {
    const offenders: string[] = [];
    for (const { rel, text } of appFiles()) {
      text.split("\n").forEach((line, i) => {
        if (/action_type:\s*["'`]/.test(line)) offenders.push(`${rel}:${i + 1} ${line.trim()}`);
      });
    }
    expect(offenders, "use LogAction.<value> from @/lib/log-action-types instead").toEqual([]);
  });

  it("never filters logs by a hardcoded action_type string literal", () => {
    const offenders: string[] = [];
    for (const { rel, text } of appFiles()) {
      text.split("\n").forEach((line, i) => {
        if (/\.(eq|in)\(\s*["']action_type["']\s*,\s*["'[]/.test(line) && !/logActionFilterValue|assertLogActionFilter/.test(line)) {
          offenders.push(`${rel}:${i + 1} ${line.trim()}`);
        }
      });
    }
    expect(offenders, "pass filters through logActionFilterValue(s) / assertLogActionFilter(s)").toEqual([]);
  });

  it("exposes a non-empty, duplicate-free whitelist", () => {
    expect(LOG_ACTION_TYPES.length).toBeGreaterThan(0);
    expect(new Set(LOG_ACTION_TYPES).size).toBe(LOG_ACTION_TYPES.length);
  });
});
