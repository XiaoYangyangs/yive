#!/usr/bin/env bash
set -euo pipefail

SERVICE_NAME="${YIVE_RELAY_SERVICE_NAME:-yive-relay}"
APP_DIR="${YIVE_RELAY_APP_DIR:-/opt/yive-runtime}"
DATA_DIR="${YIVE_RELAY_DATA_DIR:-/var/lib/yive}"
SERVICE_USER="${YIVE_RELAY_SERVICE_USER:-yive}"
SERVICE_GROUP="${YIVE_RELAY_SERVICE_GROUP:-yive}"
REVISION="${1:-main}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
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

if [[ ! -d "$APP_DIR/.git" ]]; then
  echo "$APP_DIR is not a git clone." >&2
  exit 66
fi

"${SUDO[@]}" chown -R "$SERVICE_USER:$SERVICE_GROUP" "$APP_DIR"
BEFORE="$(run_as_service_user git -C "$APP_DIR" rev-parse --short HEAD)"
echo "$STAMP deploying $REVISION from $BEFORE"

run_as_service_user git -C "$APP_DIR" fetch --tags origin
if run_as_service_user git -C "$APP_DIR" rev-parse --verify --quiet "origin/$REVISION" >/dev/null; then
  run_as_service_user git -C "$APP_DIR" checkout -B "$REVISION" "origin/$REVISION"
else
  run_as_service_user git -C "$APP_DIR" checkout "$REVISION"
fi
run_as_service_user pnpm -C "$APP_DIR" install --frozen-lockfile
run_as_service_user pnpm -C "$APP_DIR" build

AFTER="$(run_as_service_user git -C "$APP_DIR" rev-parse --short HEAD)"
"${SUDO[@]}" install -d -m 750 -o "$SERVICE_USER" -g "$SERVICE_GROUP" "$DATA_DIR"
printf '%s\n' "$BEFORE" | "${SUDO[@]}" tee "$DATA_DIR/last-good-relay-commit" >/dev/null
printf '%s\n' "$AFTER" | "${SUDO[@]}" tee "$DATA_DIR/current-relay-commit" >/dev/null
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
  echo "Post-deploy smoke skipped: set YIVE_RELAY_PUBLIC_URL in $ENV_FILE to verify the public Relay URL automatically."
fi

echo "Relay deployed: $BEFORE -> $AFTER"
echo "Check: yive relay status --server <relay-url> --token <admin-token>"
if [[ -n "${YIVE_RELAY_PUBLIC_URL:-}" ]]; then
  echo "Checklist: yive relay checklist --server \"$YIVE_RELAY_PUBLIC_URL\" --desktop-id <desktop-id> --workspace-id <workspace-id> --run-id <run-id> --workspace-file <relative-file>"
fi
