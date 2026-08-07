#!/usr/bin/env bash
# CI preflight: verify DATABASE_URL is present and that psql can actually connect.
# On failure, prints the exact command that failed plus its full output so the CI
# log is self-explanatory (no local reproduction needed).
set -uo pipefail

fail() {
  echo "::error title=DB preflight failed::$1"
  exit 1
}

echo "== DB preflight =="

# 1. Presence check ----------------------------------------------------------
if [ -z "${DATABASE_URL:-}" ]; then
  echo "DATABASE_URL is not set (empty or undefined)."
  echo "Expected: a repository/environment secret named DATABASE_URL containing"
  echo "a Postgres connection string, e.g.:"
  echo "  postgresql://USER:PASSWORD@HOST:5432/postgres?sslmode=require"
  echo "Set it under Settings -> Secrets and variables -> Actions."
  fail "DATABASE_URL secret is missing"
fi

# Redacted echo so the log shows shape without leaking credentials.
REDACTED=$(printf '%s' "$DATABASE_URL" | sed -E 's#://[^@/]+@#://***:***@#')
echo "DATABASE_URL is set: $REDACTED"

if ! printf '%s' "$DATABASE_URL" | grep -Eq '^postgres(ql)?://'; then
  echo "DATABASE_URL does not start with postgres:// or postgresql://."
  fail "DATABASE_URL is not a Postgres connection string"
fi

# 2. Tooling check -----------------------------------------------------------
if ! command -v psql >/dev/null 2>&1; then
  echo "Failing command: command -v psql"
  echo "Output: psql not found on PATH"
  echo "Install it first, e.g.: sudo apt-get install -y postgresql-client"
  fail "psql client is not installed"
fi
echo "psql version: $(psql --version)"

# 3. Connectivity check ------------------------------------------------------
CMD='psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -Atc "select current_database(), current_user, version()"'
echo "Running: psql \"\$DATABASE_URL\" -v ON_ERROR_STOP=1 -Atc \"select current_database(), current_user, version()\""

set +e
OUTPUT=$(psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -Atc "select current_database(), current_user, version()" 2>&1)
STATUS=$?
set -e

if [ $STATUS -ne 0 ]; then
  echo "---- failing command ----"
  echo "$CMD"
  echo "---- exit code ----"
  echo "$STATUS"
  echo "---- combined stdout/stderr ----"
  echo "$OUTPUT"
  echo "-------------------------"
  echo "Common causes: wrong host/port, rotated password, IP not allowed by the"
  echo "database firewall, or a missing sslmode=require parameter."
  fail "psql could not connect to DATABASE_URL (exit $STATUS)"
fi

echo "Connected successfully:"
echo "$OUTPUT"
echo "== DB preflight OK =="
