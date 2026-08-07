#!/usr/bin/env node
/**
 * Generates src/lib/log-action-types.generated.ts from the database CHECK
 * constraint on public.logs.action_type, so app code can never use an
 * action_type string the database would reject.
 *
 * Usage:
 *   node scripts/generate-log-action-types.mjs                 # write the file (psql)
 *   node scripts/generate-log-action-types.mjs --check         # verify only, exit 1 on drift
 *   node scripts/generate-log-action-types.mjs --source=http   # read the constraint over HTTPS
 *
 * `--check` is what CI and the pre-commit hook run: it regenerates in memory and
 * fails when the committed file differs from the live database constraint.
 *
 * Two sources, same output:
 *   --source=psql (default) — runs psql against DATABASE_URL/PG* env. Local use.
 *   --source=http           — GETs the token-gated constraint endpoint
 *                             (LOG_ACTION_TYPES_URL + CI_ENUM_CHECK_TOKEN) and
 *                             uses its `allowed_values`. Needs no database
 *                             credential, which is why CI uses it.
 */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const CONSTRAINT = "logs_action_type_check";
const OUT = resolve(dirname(fileURLToPath(import.meta.url)), "../src/lib/log-action-types.generated.ts");

const checkOnly = process.argv.includes("--check");
const sourceArg = process.argv.find((a) => a.startsWith("--source="));
const source = sourceArg ? sourceArg.slice("--source=".length) : "psql";
if (source !== "psql" && source !== "http") {
  console.error(`unknown --source=${source} (expected "psql" or "http")`);
  process.exit(1);
}

/** Reads the allowed values straight from pg_constraint via psql. */
function valuesFromPsql() {
  const sql = `select pg_get_constraintdef(oid) from pg_constraint where conname = '${CONSTRAINT}'`;
  const args = ["-At", "-c", sql];
  if (process.env.DATABASE_URL) args.unshift(process.env.DATABASE_URL);

  let def;
  try {
    def = execFileSync("psql", args, { encoding: "utf8" }).trim();
  } catch (err) {
    console.error(
      `could not query Postgres for ${CONSTRAINT}: ${err?.message ?? err}\n` +
        "Set DATABASE_URL (or PG* env vars) so psql can reach the database,\n" +
        "or use --source=http with LOG_ACTION_TYPES_URL + CI_ENUM_CHECK_TOKEN.",
    );
    process.exit(1);
  }
  if (!def) {
    console.error(`constraint ${CONSTRAINT} not found — run the migration first`);
    process.exit(1);
  }
  const parsed = [...def.matchAll(/'((?:[^']|'')*)'::text/g)].map((m) => m[1].replace(/''/g, "'"));
  if (parsed.length === 0) {
    console.error(`could not parse allowed values from: ${def}`);
    process.exit(1);
  }
  return parsed;
}

/**
 * Reads the same values over HTTPS from the token-gated constraint endpoint.
 * The endpoint reads pg_constraint server-side, so this stays authoritative
 * while CI holds only a single-purpose bearer token.
 */
async function valuesFromHttp() {
  const url = process.env.LOG_ACTION_TYPES_URL;
  const token = process.env.CI_ENUM_CHECK_TOKEN;
  if (!url || !token) {
    console.error(
      "--source=http needs both LOG_ACTION_TYPES_URL and CI_ENUM_CHECK_TOKEN.\n" +
        "URL example: https://project--<project-id>.lovable.app/api/public/log-action-types/constraint",
    );
    process.exit(1);
  }

  let res;
  try {
    res = await fetch(url, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
    });
  } catch (err) {
    console.error(`could not reach ${url}: ${err?.message ?? err}`);
    process.exit(1);
  }
  const body = await res.text();
  if (!res.ok) {
    console.error(`constraint endpoint returned HTTP ${res.status}: ${body.slice(0, 500)}`);
    if (res.status === 401) console.error("The CI_ENUM_CHECK_TOKEN does not match the deployed app.");
    process.exit(1);
  }

  let payload;
  try {
    payload = JSON.parse(body);
  } catch {
    console.error(`constraint endpoint did not return JSON: ${body.slice(0, 500)}`);
    process.exit(1);
  }
  if (payload.constraint && payload.constraint !== CONSTRAINT) {
    console.error(`endpoint reported constraint "${payload.constraint}", expected "${CONSTRAINT}"`);
    process.exit(1);
  }
  const parsed = Array.isArray(payload.allowed_values) ? payload.allowed_values.map(String) : [];
  if (parsed.length === 0) {
    console.error(`constraint endpoint returned no allowed_values: ${body.slice(0, 500)}`);
    process.exit(1);
  }
  return parsed;
}

const values = source === "http" ? await valuesFromHttp() : valuesFromPsql();

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
    console.log(`up to date — ${values.length} action types match ${CONSTRAINT} (source: ${source})`);
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
