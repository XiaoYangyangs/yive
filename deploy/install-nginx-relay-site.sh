#!/usr/bin/env bash
set -euo pipefail

DOMAIN="${1:-}"
MODE="${2:-http}"
SITE_NAME="${YIVE_RELAY_NGINX_SITE_NAME:-yive-relay}"
CURRENT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
AVAILABLE="/etc/nginx/sites-available/$SITE_NAME.conf"
ENABLED="/etc/nginx/sites-enabled/$SITE_NAME.conf"

if [[ "$MODE" != "http" && "$MODE" != "https" ]]; then
  echo "Usage: $0 <domain-or-_> [http|https]" >&2
  exit 64
fi

if [[ -z "$DOMAIN" ]]; then
  echo "Usage: $0 <domain-or-_> [http|https]" >&2
  echo "Examples:" >&2
  echo "  sudo bash deploy/install-nginx-relay-site.sh _ http" >&2
  echo "  sudo bash deploy/install-nginx-relay-site.sh relay.example.com https" >&2
  exit 64
fi

if ! command -v nginx >/dev/null 2>&1; then
  echo "nginx is not installed." >&2
  exit 69
fi

TEMPLATE="$CURRENT_DIR/nginx-yive-relay-http.conf"
if [[ "$MODE" == "https" ]]; then
  TEMPLATE="$CURRENT_DIR/nginx-yive-relay-https.conf"
fi

tmp="$(mktemp)"
trap 'rm -f "$tmp"' EXIT

sed "s/server_name _;/server_name $DOMAIN;/g; s/example.com/$DOMAIN/g" "$TEMPLATE" > "$tmp"

install -m 644 "$tmp" "$AVAILABLE"
ln -sfn "$AVAILABLE" "$ENABLED"
nginx -t
systemctl reload nginx

echo "Installed Nginx site $SITE_NAME for $DOMAIN in $MODE mode."
echo "Relay should be reachable at:"
if [[ "$MODE" == "https" ]]; then
  echo "  https://$DOMAIN/mobile?relay=1"
else
  echo "  http://$DOMAIN/mobile?relay=1"
fi
