/**
 * Coverage test: every value in the generated `LogAction` enum must be present in
 * the live Postgres CHECK whitelist on public.logs.action_type.
 *
 * This is narrower than log-action-types-schema.test.ts (which asserts an exact,
 * ordered match): it guarantees no app code path can write an action_type the
 * database would reject at runtime.
 */
import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import {
  LOGS_ACTION_TYPE_CONSTRAINT,
  LOG_ACTION_TYPES,
  LogAction,
} from "./log-action-types.generated";

function readAllowedValues(): string[] {
  const sql = `select pg_get_constraintdef(oid) from pg_constraint where conname = '${LOGS_ACTION_TYPE_CONSTRAINT}'`;
  const args = ["-At", "-c", sql];
  if (process.env.DATABASE_URL) args.unshift(process.env.DATABASE_URL);
  const def = execFileSync("psql", args, { encoding: "utf8" }).trim();
  expect(def, `constraint ${LOGS_ACTION_TYPE_CONSTRAINT} not found in the database`).not.toBe("");
  return [...def.matchAll(/'((?:[^']|'')*)'::text/g)].map((m) => m[1].replace(/''/g, "'"));
}

const hasDb = Boolean(process.env.PGHOST || process.env.DATABASE_URL);

describe.skipIf(!hasDb)("LogAction enum coverage in logs_action_type_check", () => {
  it("keeps the enum and the constraint the same size", () => {
    expect(new Set(readAllowedValues()).size).toBe(LOG_ACTION_TYPES.length);
  });

  it("accepts every LogAction value", () => {
    const allowed = new Set(readAllowedValues());
    const missing = Object.values(LogAction).filter((v) => !allowed.has(v));
    expect(
      missing,
      `these LogAction values are not allowed by the database constraint (run a migration, then node scripts/generate-log-action-types.mjs): ${missing.join(", ")}`,
    ).toEqual([]);
  });

  it.each([...LOG_ACTION_TYPES])("allows %s", (value) => {
    expect(readAllowedValues()).toContain(value);
  });
});
