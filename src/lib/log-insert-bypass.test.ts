/**
 * Guard test: every write to public.logs must route through insertLog /
 * insertLogReturningId in src/lib/log-action-types.ts, so action_type is
 * validated against the generated whitelist before hitting Postgres.
 *
 * This test fails if any other source file calls `.from("logs").insert(...)`
 * directly, bypassing the validator.
 */
import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(__dirname, "../..");
const ALLOWED_FILES = new Set(["src/lib/log-action-types.ts"]);
const SCAN_DIRS = ["src", "e2e"];
const CODE_EXT = /\.(ts|tsx)$/;
// Test files may insert directly to exercise DB constraints/RLS on purpose.
const IS_TEST = /\.(test|spec|integration\.test|e2e)\.(ts|tsx)$/;

function walk(dir: string, out: string[] = []) {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (CODE_EXT.test(entry)) out.push(full);
  }
  return out;
}

// Matches `.from("logs")` followed (possibly across lines/chained calls) by `.insert(`
const DIRECT_INSERT = /from\(\s*["'`]logs["'`]\s*\)(?:\s*\.\s*[A-Za-z]+\([^()]*\))*?\s*\.\s*insert\s*\(/s;

describe("logs insert bypass guard", () => {
  const files = SCAN_DIRS.flatMap((d) => walk(path.join(ROOT, d)));

  it("finds source files to scan", () => {
    expect(files.length).toBeGreaterThan(50);
  });

  it("has no direct .from('logs').insert() outside the validating helper", () => {
    const offenders: string[] = [];
    for (const file of files) {
      const rel = path.relative(ROOT, file).replace(/\\/g, "/");
      if (ALLOWED_FILES.has(rel) || IS_TEST.test(path.basename(rel))) continue;
      const src = readFileSync(file, "utf8");
      if (DIRECT_INSERT.test(src)) offenders.push(rel);
    }
    expect(
      offenders,
      `These files insert into logs directly. Use insertLog()/insertLogReturningId() from @/lib/log-action-types instead:\n${offenders.join("\n")}`,
    ).toEqual([]);
  });

  it("the regex actually detects a bypass (self-check)", () => {
    expect(DIRECT_INSERT.test(`await supabaseAdmin.from("logs").insert({ action_type: "x" })`)).toBe(true);
    expect(DIRECT_INSERT.test(`await supabaseAdmin\n  .from("logs")\n  .insert({ action_type: "x" })`)).toBe(true);
    expect(DIRECT_INSERT.test(`await supabase.from("logs").select("id")`)).toBe(false);
    expect(DIRECT_INSERT.test(`await supabase.from("customers").insert({})`)).toBe(false);
  });

  it("every server module that logs imports the helper", () => {
    const grep = execFileSync("rg", ["-l", "insertLog", "src"], { cwd: ROOT, encoding: "utf8" });
    expect(grep.split("\n").filter(Boolean).length).toBeGreaterThan(1);
  });
});
