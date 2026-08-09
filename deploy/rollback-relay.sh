#!/usr/bin/env bash
set -euo pipefail

SERVICE_NAME="${YIVE_RELAY_SERVICE_NAME:-yive-relay}"
APP_DIR="${YIVE_RELAY_APP_DIR:-/opt/yive-runtime}"
DATA_DIR="${YIVE_RELAY_DATA_DIR:-/var/lib/yive}"
SERVICE_USER="${YIVE_RELAY_SERVICE_USER:-yive}"
SERVICE_GROUP="${YIVE_RELAY_SERVICE_GROUP:-yive}"
ROLLBACK_TO="${1:-}"
ENV_FILE="${YIVE_RELAY_ENV_FILE:-/etc/yive/relay.env}"

SUDO=()
if [[ "$(id -u)" != "0" ]]; then
  SUDO=(sudo)
fi

run_as_service_user() {
  if [[ "$(id -un)" == "$SERVICE_USER" ]]; then
    "$@"
  elif command -v sudo >/dev/null 2>&1; then
    sudo -u "$SERVICE_USER" -- "$@"
  elif [[ "$(id -u)" == "0" ]] && command -v runuser >/dev/null 2>&1; then
    runuser -u "$SERVICE_USER" -- "$@"
  else
    echo "Cannot run as $SERVICE_USER; install sudo or run this script as $SERVICE_USER." >&2
    exit 69
  fi
}

if [[ -z "$ROLLBACK_TO" ]]; then
  if [[ -f "$DATA_DIR/last-good-relay-commit" ]]; then
    ROLLBACK_TO="$(cat "$DATA_DIR/last-good-relay-commit")"
  else
    echo "Usage: $0 <commit-ish>" >&2
    echo "No $DATA_DIR/last-good-relay-commit file exists." >&2
    exit 64
  fi
fi

"${SUDO[@]}" chown -R "$SERVICE_USER:$SERVICE_GROUP" "$APP_DIR"
BEFORE="$(run_as_service_user git -C "$APP_DIR" rev-parse --short HEAD)"
run_as_service_user git -C "$APP_DIR" fetch --tags origin
run_as_service_user git -C "$APP_DIR" checkout "$ROLLBACK_TO"
run_as_service_user pnpm -C "$APP_DIR" install --frozen-lockfile
run_as_service_user pnpm -C "$APP_DIR" build
"${SUDO[@]}" install -d -m 750 -o "$SERVICE_USER" -g "$SERVICE_GROUP" "$DATA_DIR"
"${SUDO[@]}" chown -R "$SERVICE_USER:$SERVICE_GROUP" "$APP_DIR" "$DATA_DIR"
run_as_service_user env YIVE_RELAY_APP_DIR="$APP_DIR" YIVE_RELAY_ENV_FILE="$ENV_FILE" bash "$APP_DIR/deploy/check-relay-config.sh"
"${SUDO[@]}" systemctl restart "$SERVICE_NAME"
sleep 1
systemctl is-active --quiet "$SERVICE_NAME"

if [[ -f "$ENV_FILE" ]]; then
  set -a
  # shellcheck disable=SC1090
  source "$ENV_FILE"
  set +a
fi

if [[ -n "${YIVE_RELAY_PUBLIC_URL:-}" ]]; then
  run_as_service_user env YIVE_RELAY_ADMIN_TOKEN="${YIVE_RELAY_ADMIN_TOKEN:-}" node "$APP_DIR/deploy/smoke-relay.mjs" --server "$YIVE_RELAY_PUBLIC_URL"
else
  echo "Post-rollback smoke skipped: set YIVE_RELAY_PUBLIC_URL in $ENV_FILE to verify the public Relay URL automatically."
fi

AFTER="$(run_as_service_user git -C "$APP_DIR" rev-parse --short HEAD)"
printf '%s\n' "$AFTER" | "${SUDO[@]}" tee "$DATA_DIR/current-relay-commit" >/dev/null
echo "Relay rolled back: $BEFORE -> $AFTER"
if [[ -n "${YIVE_RELAY_PUBLIC_URL:-}" ]]; then
  echo "Checklist: yive relay checklist --server \"$YIVE_RELAY_PUBLIC_URL\" --desktop-id <desktop-id> --workspace-id <workspace-id> --run-id <run-id> --workspace-file <relative-file>"
fi
