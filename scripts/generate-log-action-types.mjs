#!/usr/bin/env node
/**
 * Generates src/lib/log-action-types.generated.ts from the database CHECK
 * constraint on public.logs.action_type, so app code can never use an
 * action_type string the database would reject.
 *
 * Usage:
 *   node scripts/generate-log-action-types.mjs           # write the file
 *   node scripts/generate-log-action-types.mjs --check   # verify only, exit 1 on drift
 *
 * `--check` is what CI and the pre-commit hook run: it regenerates in memory and
 * fails when the committed file differs from the live database constraint.
 * Requires psql connectivity (PGHOST/PG* env or DATABASE_URL).
 */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const CONSTRAINT = "logs_action_type_check";
const OUT = resolve(dirname(fileURLToPath(import.meta.url)), "../src/lib/log-action-types.generated.ts");

const sql = `select pg_get_constraintdef(oid) from pg_constraint where conname = '${CONSTRAINT}'`;
const args = ["-At", "-c", sql];
if (process.env.DATABASE_URL) args.unshift(process.env.DATABASE_URL);

const checkOnly = process.argv.includes("--check");

let def;
try {
  def = execFileSync("psql", args, { encoding: "utf8" }).trim();
} catch (err) {
  console.error(
    `could not query Postgres for ${CONSTRAINT}: ${err?.message ?? err}\n` +
      "Set DATABASE_URL (or PG* env vars) so psql can reach the database.",
  );
  process.exit(1);
}
if (!def) {
  console.error(`constraint ${CONSTRAINT} not found — run the migration first`);
  process.exit(1);
}

const values = [...def.matchAll(/'((?:[^']|'')*)'::text/g)].map((m) => m[1].replace(/''/g, "'"));
if (values.length === 0) {
  console.error(`could not parse allowed values from: ${def}`);
  process.exit(1);
}

const file = `/**
 * AUTO-GENERATED — DO NOT EDIT BY HAND.
 *
 * Source: public.logs constraint \`${CONSTRAINT}\` (CHECK whitelist).
 * Regenerate with: \`node scripts/generate-log-action-types.mjs\`
 *
 * Any change must start as a database migration; the generator then mirrors the
 * constraint's allowed values into this file.
 */

export const LOGS_ACTION_TYPE_CONSTRAINT = "${CONSTRAINT}";

export const LOG_ACTION_TYPES = [
${values.map((v) => `  ${JSON.stringify(v)},`).join("\n")}
] as const;

export type LogActionType = (typeof LOG_ACTION_TYPES)[number];

/** Enum-style lookup so call sites can use \`LogAction.status_refresh\` instead of a raw string. */
export const LogAction = Object.freeze(
  Object.fromEntries(LOG_ACTION_TYPES.map((v) => [v, v])) as {
    readonly [K in LogActionType]: K;
  },
);
`;

if (checkOnly) {
  const current = existsSync(OUT) ? readFileSync(OUT, "utf8") : "";
  if (current === file) {
    console.log(`up to date — ${values.length} action types match ${CONSTRAINT}`);
    process.exit(0);
  }
  const committed = [...current.matchAll(/^  "([^"]+)",$/gm)].map((m) => m[1]);
  const missing = values.filter((v) => !committed.includes(v));
  const extra = committed.filter((v) => !values.includes(v));
  console.error(
    `src/lib/log-action-types.generated.ts is OUT OF DATE with the database constraint ${CONSTRAINT}.`,
  );
  if (missing.length) console.error(`  in database but not in the file: ${missing.join(", ")}`);
  if (extra.length) console.error(`  in the file but not in the database: ${extra.join(", ")}`);
  if (!missing.length && !extra.length) {
    console.error("  values match but the file body differs (ordering or header drift).");
  }
  console.error("Fix with: npm run gen:log-action-types  (then commit the regenerated file)");
  process.exit(1);
}

writeFileSync(OUT, file);
console.log(`wrote ${values.length} action types to ${OUT}`);
