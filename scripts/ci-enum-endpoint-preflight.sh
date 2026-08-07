#!/usr/bin/env bash
# CI preflight for the generated-enum drift check.
#
# Replaces the old DATABASE_URL/psql preflight: CI no longer needs a database
# credential, only a scoped bearer token for the read-only constraint endpoint.
# Verifies (1) both inputs are present, (2) the endpoint is reachable, and
# (3) the token is accepted. Prints the exact failing command and its output.
set -uo pipefail

fail() {
  echo "::error title=Enum check preflight failed::$1"
  exit 1
}

echo "== Enum check preflight =="

if [ -z "${LOG_ACTION_TYPES_URL:-}" ]; then
  echo "LOG_ACTION_TYPES_URL is not set."
  echo "Expected the constraint endpoint URL, e.g.:"
  echo "  https://project--<project-id>.lovable.app/api/public/log-action-types/constraint"
  fail "LOG_ACTION_TYPES_URL is missing"
fi
echo "Endpoint: $LOG_ACTION_TYPES_URL"

if [ -z "${CI_ENUM_CHECK_TOKEN:-}" ]; then
  echo "CI_ENUM_CHECK_TOKEN is not set (empty or undefined)."
  echo "Add a repository secret named CI_ENUM_CHECK_TOKEN under"
  echo "Settings -> Secrets and variables -> Actions."
  fail "CI_ENUM_CHECK_TOKEN secret is missing"
fi
echo "CI_ENUM_CHECK_TOKEN is set (${#CI_ENUM_CHECK_TOKEN} characters)."

CMD='curl -sS -o body.json -w "%{http_code}" -H "Authorization: Bearer $CI_ENUM_CHECK_TOKEN" "$LOG_ACTION_TYPES_URL"'
echo "Running: $CMD"

BODY_FILE=$(mktemp)
set +e
STATUS_CODE=$(curl -sS --max-time 30 -o "$BODY_FILE" -w "%{http_code}" \
  -H "Authorization: Bearer $CI_ENUM_CHECK_TOKEN" \
  -H "Accept: application/json" \
  "$LOG_ACTION_TYPES_URL" 2>"$BODY_FILE.err")
CURL_STATUS=$?
set -e

report() {
  echo "---- failing command ----"
  echo "$CMD"
  echo "---- curl exit code ----"
  echo "$CURL_STATUS"
  echo "---- http status ----"
  echo "${STATUS_CODE:-none}"
  echo "---- response body (first 2000 bytes) ----"
  head -c 2000 "$BODY_FILE"
  echo
  echo "---- stderr ----"
  head -c 2000 "$BODY_FILE.err" 2>/dev/null
  echo
  echo "-------------------------"
}

if [ $CURL_STATUS -ne 0 ]; then
  report
  echo "Common causes: wrong URL, the project has never been deployed, or no egress."
  fail "could not reach LOG_ACTION_TYPES_URL (curl exit $CURL_STATUS)"
fi

case "$STATUS_CODE" in
  200) ;;
  401)
    report
    echo "The endpoint rejected the token. Rotate it in the app and update the"
    echo "CI_ENUM_CHECK_TOKEN repository secret so both sides match."
    fail "CI_ENUM_CHECK_TOKEN was rejected (HTTP 401)"
    ;;
  503)
    report
    echo "The deployed app has no CI_ENUM_CHECK_TOKEN configured yet."
    fail "endpoint not configured (HTTP 503)"
    ;;
  *)
    report
    fail "unexpected response from constraint endpoint (HTTP $STATUS_CODE)"
    ;;
esac

COUNT=$(grep -o '"count":[0-9]*' "$BODY_FILE" | head -n1 | cut -d: -f2)
echo "Endpoint reachable and token accepted — ${COUNT:-?} allowed action_type values returned."
echo "== Enum check preflight OK =="
