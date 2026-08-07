#!/usr/bin/env node
/**
 * Mints a strong, single-purpose token value for CI_ENUM_CHECK_TOKEN.
 *
 * This is a SHARED secret: the same value must exist in two places —
 *   1. the app's environment (so the constraint endpoint can compare it), and
 *   2. the GitHub Actions repository secret named CI_ENUM_CHECK_TOKEN.
 * Because it must be copied by hand into both, it cannot be a hidden
 * generated-only secret. This script produces the value locally; nothing is
 * written to disk and nothing is sent anywhere.
 *
 * Usage: node scripts/generate-ci-enum-token.mjs [--bytes 32] [--quiet]
 *   --quiet prints only the token (useful for piping into `gh secret set`).
 */
import { randomBytes, createHash } from "node:crypto";

const args = process.argv.slice(2);
const quiet = args.includes("--quiet");
const bytesIdx = args.indexOf("--bytes");
const bytes = bytesIdx !== -1 ? Math.max(24, Math.min(64, Number(args[bytesIdx + 1]) || 32)) : 32;

const token = `ciek_${randomBytes(bytes).toString("base64url")}`;
const fingerprint = createHash("sha256").update(token, "utf8").digest("hex").slice(0, 12);

if (quiet) {
  process.stdout.write(`${token}\n`);
} else {
  console.log("");
  console.log("CI_ENUM_CHECK_TOKEN (copy now — it is not stored anywhere):");
  console.log("");
  console.log(`  ${token}`);
  console.log("");
  console.log(`  fingerprint (sha256, first 12): ${fingerprint}`);
  console.log(`  length: ${token.length} chars`);
  console.log("");
  console.log("Install it in BOTH places:");
  console.log("  1. App secret: ask Lovable to update CI_ENUM_CHECK_TOKEN and paste this value.");
  console.log("  2. GitHub: Settings -> Secrets and variables -> Actions -> CI_ENUM_CHECK_TOKEN");
  console.log("     or: gh secret set CI_ENUM_CHECK_TOKEN --body '<value>'");
  console.log("");
  console.log("Then verify both sides match (no database credential involved):");
  console.log("  CI_ENUM_CHECK_TOKEN=... bash scripts/ci-enum-token-verify.sh");
  console.log("");
  console.log("This token grants nothing beyond reading the allowed action_type list.");
  console.log("");
}
