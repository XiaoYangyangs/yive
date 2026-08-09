#!/usr/bin/env bash
set -euo pipefail

APP_DIR="${YIVE_RELAY_APP_DIR:-/opt/yive-runtime}"
ENV_FILE="${YIVE_RELAY_ENV_FILE:-/etc/yive/relay.env}"

fail() {
  echo "Yive Relay config check failed: $*" >&2
  exit 64
}

if [[ -f "$ENV_FILE" ]]; then
  if LC_ALL=C grep -q $'\r' "$ENV_FILE"; then
    fail "$ENV_FILE contains Windows CRLF line endings. Fix it with: sudo sed -i 's/\r$//' $ENV_FILE"
  fi

  set -a
  # shellcheck disable=SC1090
  source "$ENV_FILE"
  set +a
fi

PORT="${YIVE_RELAY_PORT:-4020}"
HOST="${YIVE_RELAY_HOST:-127.0.0.1}"
PAIRING_STORE="${YIVE_RELAY_PAIRING_STORE:-/var/lib/yive/relay-pairings.json}"
STATIC_DIR="${YIVE_RELAY_STATIC_DIR:-$APP_DIR/web/dist}"
HEARTBEAT_INTERVAL_MS="${YIVE_RELAY_HEARTBEAT_INTERVAL_MS:-30000}"
HEARTBEAT_TIMEOUT_MS="${YIVE_RELAY_HEARTBEAT_TIMEOUT_MS:-75000}"
REQUIRE_DESKTOP_BINDING="${YIVE_RELAY_REQUIRE_DESKTOP_BINDING:-1}"

require_integer() {
  local name="$1"
  local value="$2"
  local allow_zero="${3:-0}"
  if [[ "$allow_zero" == "1" ]]; then
    [[ "$value" =~ ^(0|[1-9][0-9]*)$ ]] || fail "$name must be 0 or a positive integer, got '$value'."
  else
    [[ "$value" =~ ^[1-9][0-9]*$ ]] || fail "$name must be a positive integer, got '$value'."
  fi
}

require_host() {
  local value="$1"
  [[ -n "$value" ]] || fail "YIVE_RELAY_HOST must not be empty."
  [[ "$value" != *[[:space:]]* ]] || fail "YIVE_RELAY_HOST must not contain whitespace, got '$value'."
}

[[ -d "$APP_DIR" ]] || fail "APP_DIR does not exist: $APP_DIR"
[[ -f "$APP_DIR/dist/src/cli/hive.js" ]] || fail "built CLI entry is missing: $APP_DIR/dist/src/cli/hive.js; run pnpm build first."
[[ -f "$STATIC_DIR/index.html" ]] || fail "mobile static app is missing: $STATIC_DIR/index.html; run pnpm build and set YIVE_RELAY_STATIC_DIR correctly."

if [[ -z "${YIVE_RELAY_ADMIN_TOKEN:-}" || "${YIVE_RELAY_ADMIN_TOKEN}" == "change-me" ]]; then
  fail "YIVE_RELAY_ADMIN_TOKEN must be set in $ENV_FILE."
fi

require_integer "YIVE_RELAY_PORT" "$PORT"
require_host "$HOST"
require_integer "YIVE_RELAY_HEARTBEAT_INTERVAL_MS" "$HEARTBEAT_INTERVAL_MS" 1
require_integer "YIVE_RELAY_HEARTBEAT_TIMEOUT_MS" "$HEARTBEAT_TIMEOUT_MS"
[[ "$REQUIRE_DESKTOP_BINDING" =~ ^[01]$ ]] || fail "YIVE_RELAY_REQUIRE_DESKTOP_BINDING must be 0 or 1, got '$REQUIRE_DESKTOP_BINDING'."
[[ "$REQUIRE_DESKTOP_BINDING" == "1" ]] || fail "YIVE_RELAY_REQUIRE_DESKTOP_BINDING must be 1 for production Relay."
if [[ -n "${YIVE_RELAY_PUBLIC_URL:-}" ]]; then
  [[ "$YIVE_RELAY_PUBLIC_URL" =~ ^https?://[^[:space:]]+$ ]] || fail "YIVE_RELAY_PUBLIC_URL must start with http:// or https:// and contain no spaces."
fi

PAIRING_STORE_DIR="$(dirname "$PAIRING_STORE")"
mkdir -p "$PAIRING_STORE_DIR"
[[ -d "$PAIRING_STORE_DIR" ]] || fail "pairing store directory does not exist: $PAIRING_STORE_DIR"
[[ -w "$PAIRING_STORE_DIR" ]] || fail "pairing store directory is not writable: $PAIRING_STORE_DIR"

echo "Yive Relay config check: ok"
echo "App dir: $APP_DIR"
echo "Static dir: $STATIC_DIR"
echo "Pairing store: $PAIRING_STORE"
echo "Port: $PORT"
echo "Host: $HOST"
echo "Heartbeat: ${HEARTBEAT_INTERVAL_MS}ms interval, ${HEARTBEAT_TIMEOUT_MS}ms timeout"
echo "Desktop binding: required"
if [[ -n "${YIVE_RELAY_PUBLIC_URL:-}" ]]; then
  echo "Public smoke URL: $YIVE_RELAY_PUBLIC_URL"
else
  echo "Public smoke URL: not configured"
fi
