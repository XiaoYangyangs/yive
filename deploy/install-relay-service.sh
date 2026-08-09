#!/usr/bin/env bash
set -euo pipefail

SERVICE_NAME="${YIVE_RELAY_SERVICE_NAME:-yive-relay}"
APP_DIR="${YIVE_RELAY_APP_DIR:-/opt/yive-runtime}"
CONFIG_DIR="${YIVE_RELAY_CONFIG_DIR:-/etc/yive}"
DATA_DIR="${YIVE_RELAY_DATA_DIR:-/var/lib/yive}"
ENV_FILE="$CONFIG_DIR/relay.env"
CURRENT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if [[ "$CURRENT_DIR" != "$APP_DIR" ]]; then
  echo "This script should be run from the production clone at $APP_DIR." >&2
  echo "Current repo: $CURRENT_DIR" >&2
  echo "Set YIVE_RELAY_APP_DIR=$CURRENT_DIR only for non-production testing." >&2
  if [[ "${YIVE_RELAY_ALLOW_NONSTANDARD_APP_DIR:-0}" != "1" ]]; then
    exit 64
  fi
fi

if ! command -v sudo >/dev/null 2>&1 && [[ "$(id -u)" != "0" ]]; then
  echo "sudo is required unless running as root." >&2
  exit 69
fi

SUDO=()
if [[ "$(id -u)" != "0" ]]; then
  SUDO=(sudo)
fi

install_file() {
  local mode="$1"
  local src="$2"
  local dest="$3"
  if [[ "$(realpath "$src")" == "$(realpath -m "$dest")" ]]; then
    "${SUDO[@]}" chmod "$mode" "$dest"
    return
  fi
  "${SUDO[@]}" install -m "$mode" "$src" "$dest"
}

if ! id yive >/dev/null 2>&1; then
  "${SUDO[@]}" useradd --system --home "$APP_DIR" --shell /usr/sbin/nologin yive
fi

"${SUDO[@]}" install -d -m 755 "$CONFIG_DIR"
"${SUDO[@]}" install -d -m 750 -o yive -g yive "$DATA_DIR"

if [[ ! -f "$ENV_FILE" ]]; then
  "${SUDO[@]}" install -m 640 -o root -g yive "$CURRENT_DIR/deploy/relay.env.example" "$ENV_FILE"
  echo "Created $ENV_FILE. Edit YIVE_RELAY_ADMIN_TOKEN before starting the service." >&2
fi

"${SUDO[@]}" chown -R yive:yive "$APP_DIR"
install_file 755 "$CURRENT_DIR/deploy/check-relay-config.sh" "$APP_DIR/deploy/check-relay-config.sh"
install_file 755 "$CURRENT_DIR/deploy/run-relay.sh" "$APP_DIR/deploy/run-relay.sh"
install_file 644 "$CURRENT_DIR/deploy/yive-relay.service" "/etc/systemd/system/$SERVICE_NAME.service"
"${SUDO[@]}" systemctl daemon-reload
"${SUDO[@]}" systemctl enable "$SERVICE_NAME.service"

echo "Installed $SERVICE_NAME.service."
echo "Next:"
echo "  sudo editor $ENV_FILE"
echo "  sudo -u yive env YIVE_RELAY_APP_DIR=$APP_DIR YIVE_RELAY_ENV_FILE=$ENV_FILE bash $APP_DIR/deploy/check-relay-config.sh"
echo "  sudo systemctl start $SERVICE_NAME"
echo "  systemctl status $SERVICE_NAME --no-pager"
