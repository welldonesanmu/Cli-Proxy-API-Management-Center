#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DIST_FILE="${DIST_FILE:-$ROOT_DIR/dist/management.html}"
HOST="${DEPLOY_HOST:-121.40.167.152}"
USER_NAME="${DEPLOY_USER:-admin}"
SERVICE="${DEPLOY_SERVICE:-cliproxyapi}"
REMOTE_TMP="${DEPLOY_REMOTE_TMP:-/tmp/management.html}"
PRIMARY_PATH="${DEPLOY_PRIMARY_PATH:-/opt/cliproxyapi/static/management.html}"
SECONDARY_PATH="${DEPLOY_SECONDARY_PATH:-/opt/CPA-Dashboard/management.html}"
URL="${DEPLOY_URL:-http://121.40.167.152:8317/management.html}"
USE_SUDO="${DEPLOY_USE_SUDO:-1}"
BATCH_MODE="${DEPLOY_BATCH_MODE:-0}"
VERIFY_RETRIES="${DEPLOY_VERIFY_RETRIES:-10}"
VERIFY_RETRY_DELAY="${DEPLOY_VERIFY_RETRY_DELAY:-2}"

usage() {
  cat <<'EOF'
Usage: scripts/deploy-management.sh [options]

Uploads dist/management.html to the management server, installs it into both
known target paths, restarts the service, and verifies the served page.

Options:
  --help                    Show this help message
  --host <host>             Remote host (default: 121.40.167.152)
  --user <user>             Remote SSH user (default: admin)
  --service <name>          systemd service to restart (default: cliproxyapi)
  --remote-tmp <path>       Remote temporary upload path (default: /tmp/management.html)
  --primary-path <path>     Primary target file path
  --secondary-path <path>   Secondary target file path
  --url <url>               Verification URL
  --sudo                    Use sudo for install/systemctl on remote host (default)
  --no-sudo                 Do not use sudo on remote host
  --batch-mode              Force non-interactive SSH/SCP auth
  --no-batch-mode           Allow password/prompt-based SSH/SCP auth (default)
  --verify-retries <count>  Number of verification retries after restart (default: 10)
  --verify-delay <seconds>  Seconds between verification retries (default: 2)

Environment overrides:
  DIST_FILE, DEPLOY_HOST, DEPLOY_USER, DEPLOY_SERVICE, DEPLOY_REMOTE_TMP,
  DEPLOY_PRIMARY_PATH, DEPLOY_SECONDARY_PATH, DEPLOY_URL, DEPLOY_USE_SUDO,
  DEPLOY_BATCH_MODE, DEPLOY_VERIFY_RETRIES, DEPLOY_VERIFY_RETRY_DELAY
EOF
}

fail() {
  printf 'Error: %s\n' "$*" >&2
  exit 1
}

require_integer() {
  local value="$1"
  local label="$2"
  [[ "$value" =~ ^[0-9]+$ ]] || fail "$label must be a non-negative integer."
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || fail "Required command not found: $1"
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --help)
      usage
      exit 0
      ;;
    --host)
      [[ $# -ge 2 ]] || fail '--host requires a value.'
      HOST="$2"
      shift 2
      ;;
    --user)
      [[ $# -ge 2 ]] || fail '--user requires a value.'
      USER_NAME="$2"
      shift 2
      ;;
    --service)
      [[ $# -ge 2 ]] || fail '--service requires a value.'
      SERVICE="$2"
      shift 2
      ;;
    --remote-tmp)
      [[ $# -ge 2 ]] || fail '--remote-tmp requires a value.'
      REMOTE_TMP="$2"
      shift 2
      ;;
    --primary-path)
      [[ $# -ge 2 ]] || fail '--primary-path requires a value.'
      PRIMARY_PATH="$2"
      shift 2
      ;;
    --secondary-path)
      [[ $# -ge 2 ]] || fail '--secondary-path requires a value.'
      SECONDARY_PATH="$2"
      shift 2
      ;;
    --url)
      [[ $# -ge 2 ]] || fail '--url requires a value.'
      URL="$2"
      shift 2
      ;;
    --sudo)
      USE_SUDO=1
      shift
      ;;
    --no-sudo)
      USE_SUDO=0
      shift
      ;;
    --batch-mode)
      BATCH_MODE=1
      shift
      ;;
    --no-batch-mode)
      BATCH_MODE=0
      shift
      ;;
    --verify-retries)
      [[ $# -ge 2 ]] || fail '--verify-retries requires a value.'
      VERIFY_RETRIES="$2"
      shift 2
      ;;
    --verify-delay)
      [[ $# -ge 2 ]] || fail '--verify-delay requires a value.'
      VERIFY_RETRY_DELAY="$2"
      shift 2
      ;;
    *)
      fail "Unknown option: $1"
      ;;
  esac
done

[[ -f "$DIST_FILE" ]] || fail "Local file not found: $DIST_FILE"
require_integer "$VERIFY_RETRIES" 'verify retries'
require_integer "$VERIFY_RETRY_DELAY" 'verify delay'

require_command scp
require_command ssh
require_command curl

REMOTE_TARGET="$USER_NAME@$HOST"
SSH_OPTS=()

if [[ "$BATCH_MODE" == "1" ]]; then
  SSH_OPTS=(-o BatchMode=yes)
fi

REMOTE_PREFIX=""
if [[ "$USE_SUDO" == "1" ]]; then
  REMOTE_PREFIX="sudo "
fi

printf 'Uploading %s to %s:%s\n' "$DIST_FILE" "$REMOTE_TARGET" "$REMOTE_TMP"
scp "${SSH_OPTS[@]}" "$DIST_FILE" "$REMOTE_TARGET:$REMOTE_TMP"

printf 'Installing uploaded file to target paths on %s\n' "$REMOTE_TARGET"
ssh "${SSH_OPTS[@]}" "$REMOTE_TARGET" "${REMOTE_PREFIX}install -m 0644 '$REMOTE_TMP' '$PRIMARY_PATH' && ${REMOTE_PREFIX}install -m 0644 '$REMOTE_TMP' '$SECONDARY_PATH' && ${REMOTE_PREFIX}systemctl restart '$SERVICE'"

printf 'Verifying served page: %s\n' "$URL"
HTML_CONTENT=""
LAST_ERROR=""
ATTEMPT=1
TOTAL_ATTEMPTS=$((VERIFY_RETRIES + 1))

while [[ "$ATTEMPT" -le "$TOTAL_ATTEMPTS" ]]; do
  if HTML_CONTENT="$(curl --fail --silent --show-error --location "$URL" 2>&1)"; then
    LAST_ERROR=""
    break
  fi

  LAST_ERROR="$HTML_CONTENT"
  if [[ "$ATTEMPT" -eq "$TOTAL_ATTEMPTS" ]]; then
    fail "Verification failed after ${TOTAL_ATTEMPTS} attempts: $LAST_ERROR"
  fi

  printf 'Verification attempt %d/%d failed, retrying in %ss...\n' \
    "$ATTEMPT" "$TOTAL_ATTEMPTS" "$VERIFY_RETRY_DELAY" >&2
  sleep "$VERIFY_RETRY_DELAY"
  ATTEMPT=$((ATTEMPT + 1))
done

for expected_text in '刷新全部凭证' '监控中心' '数据备份'; do
  if [[ "$HTML_CONTENT" != *"$expected_text"* ]]; then
    fail "Verification failed: missing expected text '$expected_text' at $URL"
  fi
done

printf 'Deployment verification succeeded for %s\n' "$URL"
