#!/usr/bin/env bash
set -euo pipefail

DOMAIN="${1:-}"
SERVER_IP="${2:-}"
CURRENT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

usage() {
  cat >&2 <<'USAGE'
Usage:
  sudo bash deploy/enable-relay-https.sh <domain> [server-ip]

Environment:
  LETSENCRYPT_EMAIL=<email>   Optional. If omitted, certbot registers without email.

Example:
  sudo LETSENCRYPT_EMAIL=ops@example.com bash deploy/enable-relay-https.sh relay.example.com 203.0.113.10

This script intentionally stops before requesting a certificate when HTTP /health
does not reach Yive Relay. On mainland China servers, a 403 with Server: Beaver
usually means the domain is blocked before Nginx, commonly because ICP filing or
domain binding is not ready yet.
USAGE
}

if [[ -z "$DOMAIN" || "$DOMAIN" == --* ]]; then
  usage
  exit 64
fi

if [[ "$(id -u)" != "0" ]]; then
  echo "Run this script with sudo/root so it can update Nginx and certbot." >&2
  exit 77
fi

require_command() {
  local name="$1"
  if ! command -v "$name" >/dev/null 2>&1; then
    echo "$name is required." >&2
    exit 69
  fi
}

require_command curl
require_command nginx

echo "Installing HTTP Relay Nginx site for $DOMAIN..."
bash "$CURRENT_DIR/install-nginx-relay-site.sh" "$DOMAIN" http

tmp_headers="$(mktemp)"
tmp_body="$(mktemp)"
trap 'rm -f "$tmp_headers" "$tmp_body"' EXIT

http_code="$(
  curl \
    --connect-timeout 10 \
    --max-time 20 \
    --silent \
    --show-error \
    --dump-header "$tmp_headers" \
    --output "$tmp_body" \
    --write-out '%{http_code}' \
    "http://$DOMAIN/health" || true
)"

if [[ "$http_code" != "200" ]]; then
  echo "HTTP /health did not reach Yive Relay. Status: $http_code" >&2
  sed -n '1,12p' "$tmp_headers" >&2 || true
  if grep -qi 'server:.*beaver' "$tmp_headers" || grep -qi 'beaver' "$tmp_body"; then
    echo "Detected Server: Beaver/provider block. Confirm ICP filing and domain binding before HTTPS." >&2
  fi
  exit 78
fi

if ! grep -q '"service"[[:space:]]*:[[:space:]]*"hive-relay"' "$tmp_body"; then
  echo "HTTP /health returned 200, but it is not a Yive Relay health response." >&2
  sed -n '1,8p' "$tmp_body" >&2 || true
  exit 78
fi

if ! command -v certbot >/dev/null 2>&1; then
  echo "Installing certbot..."
  export DEBIAN_FRONTEND=noninteractive
  apt-get update
  apt-get install -y certbot python3-certbot-nginx
fi

certbot_args=(certonly --nginx --non-interactive --agree-tos -d "$DOMAIN")
if [[ -n "${LETSENCRYPT_EMAIL:-}" ]]; then
  certbot_args+=(--email "$LETSENCRYPT_EMAIL")
else
  certbot_args+=(--register-unsafely-without-email)
fi

echo "Requesting Let's Encrypt certificate for $DOMAIN..."
certbot "${certbot_args[@]}"

echo "Installing HTTPS Relay Nginx site for $DOMAIN..."
bash "$CURRENT_DIR/install-nginx-relay-site.sh" "$DOMAIN" https

if [[ -n "$SERVER_IP" && -f "$CURRENT_DIR/check-domain-readiness.mjs" ]]; then
  node "$CURRENT_DIR/check-domain-readiness.mjs" --domain "$DOMAIN" --server-ip "$SERVER_IP"
else
  echo "HTTPS Relay should be reachable at https://$DOMAIN/mobile?relay=1"
fi
