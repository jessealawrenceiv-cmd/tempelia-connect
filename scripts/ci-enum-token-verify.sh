#!/usr/bin/env bash
# Verifies that the CI_ENUM_CHECK_TOKEN held by CI matches the one held by the
# deployed app — WITHOUT any database credential and without printing the token.
#
# Compares truncated sha256 fingerprints only. Requires:
#   CI_ENUM_CHECK_TOKEN  scoped bearer token (GitHub Actions secret)
#   LOG_ACTION_TYPES_URL constraint endpoint URL (token-check is derived from it)
set -uo pipefail

fail() {
  echo "::error title=CI_ENUM_CHECK_TOKEN verification failed::$1"
  exit 1
}

echo "== CI_ENUM_CHECK_TOKEN verification =="

if [ -z "${CI_ENUM_CHECK_TOKEN:-}" ]; then
  echo "CI_ENUM_CHECK_TOKEN is not set (empty or undefined)."
  echo "Mint a value with: node scripts/generate-ci-enum-token.mjs"
  echo "Then store it as a GitHub Actions secret AND as the app secret."
  fail "CI_ENUM_CHECK_TOKEN secret is missing"
fi

if [ -z "${LOG_ACTION_TYPES_URL:-}" ]; then
  fail "LOG_ACTION_TYPES_URL is missing"
fi

VERIFY_URL="${CI_ENUM_TOKEN_CHECK_URL:-${LOG_ACTION_TYPES_URL%/constraint}/token-check}"
echo "Verify endpoint: $VERIFY_URL"

# Local fingerprint of the token CI holds. Never prints the token itself.
LOCAL_FP=$(printf '%s' "$CI_ENUM_CHECK_TOKEN" | shasum -a 256 2>/dev/null | cut -c1-12)
if [ -z "$LOCAL_FP" ]; then
  LOCAL_FP=$(printf '%s' "$CI_ENUM_CHECK_TOKEN" | sha256sum | cut -c1-12)
fi
echo "Token present (${#CI_ENUM_CHECK_TOKEN} chars), fingerprint $LOCAL_FP"

CMD='curl -sS -H "Authorization: Bearer ***" "$VERIFY_URL"'
BODY_FILE=$(mktemp)
set +e
STATUS_CODE=$(curl -sS --max-time 30 -o "$BODY_FILE" -w "%{http_code}" \
  -H "Authorization: Bearer $CI_ENUM_CHECK_TOKEN" \
  -H "Accept: application/json" \
  "$VERIFY_URL" 2>"$BODY_FILE.err")
CURL_STATUS=$?
set -e

report() {
  echo "---- failing command ----"; echo "$CMD"
  echo "---- curl exit code ----"; echo "$CURL_STATUS"
  echo "---- http status ----"; echo "${STATUS_CODE:-none}"
  echo "---- response body (first 2000 bytes) ----"; head -c 2000 "$BODY_FILE"; echo
  echo "---- stderr ----"; head -c 2000 "$BODY_FILE.err" 2>/dev/null; echo
  echo "-------------------------"
}

if [ $CURL_STATUS -ne 0 ]; then
  report
  fail "could not reach the token-check endpoint (curl exit $CURL_STATUS)"
fi

case "$STATUS_CODE" in
  200) ;;
  401)
    report
    echo "The app holds a DIFFERENT token than CI. Compare the fingerprints above:"
    echo "  CI fingerprint: $LOCAL_FP"
    echo "Re-mint one value (node scripts/generate-ci-enum-token.mjs) and set it in both places."
    fail "token mismatch between CI and the deployed app (HTTP 401)"
    ;;
  503)
    report
    fail "the deployed app has no CI_ENUM_CHECK_TOKEN configured (HTTP 503)"
    ;;
  *)
    report
    fail "unexpected response from token-check endpoint (HTTP $STATUS_CODE)"
    ;;
esac

REMOTE_FP=$(grep -o '"fingerprint":"[0-9a-f]*"' "$BODY_FILE" | head -n1 | cut -d'"' -f4)
if [ -n "$REMOTE_FP" ] && [ "$REMOTE_FP" != "$LOCAL_FP" ]; then
  report
  fail "fingerprint mismatch (CI $LOCAL_FP vs app $REMOTE_FP)"
fi

echo "Token verified — CI and the app share fingerprint ${REMOTE_FP:-$LOCAL_FP}."
echo "Scope: read-only action_type whitelist. No database credential used."
echo "== CI_ENUM_CHECK_TOKEN verification OK =="
