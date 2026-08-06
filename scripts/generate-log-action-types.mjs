#!/usr/bin/env node
/**
 * Generates src/lib/log-action-types.generated.ts from the database CHECK
 * constraint on public.logs.action_type, so app code can never use an
 * action_type string the database would reject.
 *
 * Usage: node scripts/generate-log-action-types.mjs
 * Requires psql connectivity (PGHOST/PG* env or DATABASE_URL).
 */
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const CONSTRAINT = "logs_action_type_check";
const OUT = resolve(dirname(fileURLToPath(import.meta.url)), "../src/lib/log-action-types.generated.ts");

const sql = `select pg_get_constraintdef(oid) from pg_constraint where conname = '${CONSTRAINT}'`;
const args = ["-At", "-c", sql];
if (process.env.DATABASE_URL) args.unshift(process.env.DATABASE_URL);

const def = execFileSync("psql", args, { encoding: "utf8" }).trim();
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

writeFileSync(OUT, file);
console.log(`wrote ${values.length} action types to ${OUT}`);
