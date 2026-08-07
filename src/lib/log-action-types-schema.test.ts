/**
 * Schema test: the live Postgres CHECK whitelist on public.logs.action_type must
 * exactly match the expected list committed in the repo
 * (src/lib/log-action-types.generated.ts).
 *
 * If this fails, the database constraint changed. Re-run
 * `node scripts/generate-log-action-types.mjs` and review the diff — never edit
 * the generated file by hand.
 */
import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import {
  LOGS_ACTION_TYPE_CONSTRAINT,
  LOG_ACTION_TYPES,
} from "./log-action-types.generated";

function readConstraintDef(): string {
  const sql = `select pg_get_constraintdef(oid) from pg_constraint where conname = '${LOGS_ACTION_TYPE_CONSTRAINT}'`;
  const args = ["-At", "-c", sql];
  if (process.env.DATABASE_URL) args.unshift(process.env.DATABASE_URL);
  return execFileSync("psql", args, { encoding: "utf8" }).trim();
}

function parseAllowedValues(def: string): string[] {
  return [...def.matchAll(/'((?:[^']|'')*)'::text/g)].map((m) =>
    m[1].replace(/''/g, "'"),
  );
}

const hasDb = Boolean(process.env.PGHOST || process.env.DATABASE_URL);

describe.skipIf(!hasDb)("logs.action_type CHECK whitelist", () => {
  it("still exists as a CHECK constraint", () => {
    const def = readConstraintDef();
    expect(def, `constraint ${LOGS_ACTION_TYPE_CONSTRAINT} not found`).not.toBe(
      "",
    );
    expect(def.startsWith("CHECK")).toBe(true);
    expect(def).toContain("action_type");
  });

  it("is an explicit whitelist (no catch-all, no regex)", () => {
    const def = readConstraintDef();
    expect(def).toMatch(/= ANY \(ARRAY\[/);
    expect(def).not.toMatch(/~|~\*|LIKE/);
  });

  it("matches the expected list in the repo exactly, in order", () => {
    const actual = parseAllowedValues(readConstraintDef());
    expect(actual).toEqual([...LOG_ACTION_TYPES]);
  });

  it("has no duplicate or empty values", () => {
    const actual = parseAllowedValues(readConstraintDef());
    expect(new Set(actual).size).toBe(actual.length);
    expect(actual.every((v) => v.trim() === v && v.length > 0)).toBe(true);
  });
});
