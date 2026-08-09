#!/usr/bin/env bash
set -euo pipefail

APP_DIR="${YIVE_RELAY_APP_DIR:-/opt/yive-runtime}"
ENV_FILE="${YIVE_RELAY_ENV_FILE:-/etc/yive/relay.env}"

if [[ -f "$ENV_FILE" ]]; then
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

if [[ -z "${YIVE_RELAY_ADMIN_TOKEN:-}" || "${YIVE_RELAY_ADMIN_TOKEN}" == "change-me" ]]; then
  echo "YIVE_RELAY_ADMIN_TOKEN must be set in $ENV_FILE" >&2
  exit 64
fi

bash "$APP_DIR/deploy/check-relay-config.sh"
cd "$APP_DIR"

ARGS=(
  --host "$HOST"
  --port "$PORT"
  --store-file "$PAIRING_STORE"
  --static-dir "$STATIC_DIR"
  --heartbeat-interval-ms "$HEARTBEAT_INTERVAL_MS"
  --heartbeat-timeout-ms "$HEARTBEAT_TIMEOUT_MS"
)
if [[ "$REQUIRE_DESKTOP_BINDING" == "1" ]]; then
  ARGS+=(--require-desktop-binding)
fi

exec node dist/src/cli/hive.js relay "${ARGS[@]}"
