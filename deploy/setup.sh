#!/usr/bin/env bash
# ============================================================
# One-shot setup for a fresh Ubuntu droplet.
# Installs Node + Caddy, starts the admin app as a service,
# and configures HTTPS for both domains. Run as root:
#
#   sudo bash deploy/setup.sh
#
# Override domain/port if needed:
#   APEX=tommyconway.net APP_PORT=3000 sudo -E bash deploy/setup.sh
# ============================================================
set -euo pipefail

APEX="${APEX:-tommyconway.net}"
ADMIN="${ADMIN:-admin.$APEX}"
APP_PORT="${APP_PORT:-3000}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

if [ "$(id -u)" -ne 0 ]; then echo "Please run with sudo/root."; exit 1; fi
echo "==> Project: $PROJECT_DIR"
echo "==> Domains: $APEX  +  $ADMIN  (app on port $APP_PORT)"

# ---------- Node 20 ----------
if ! command -v node >/dev/null 2>&1; then
  echo "==> Installing Node 20..."
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y nodejs
else
  echo "==> Node already installed: $(node -v)"
fi

# ---------- Caddy ----------
if ! command -v caddy >/dev/null 2>&1; then
  echo "==> Installing Caddy..."
  apt-get install -y debian-keyring debian-archive-keyring apt-transport-https curl gnupg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update
  apt-get install -y caddy
else
  echo "==> Caddy already installed: $(caddy version | head -1)"
fi

# ---------- App dependencies ----------
echo "==> Installing app dependencies..."
cd "$PROJECT_DIR/server"
npm install --omit=dev

# ---------- .env ----------
if [ ! -f "$PROJECT_DIR/server/.env" ]; then
  cp "$PROJECT_DIR/server/.env.example" "$PROJECT_DIR/server/.env"
  echo "==> Created server/.env (edit it to add your AI key + ADMIN_PASS)"
fi

# ---------- make static files readable by caddy ----------
chmod -R a+rX "$PROJECT_DIR/landing" "$PROJECT_DIR/server/public"

# ---------- systemd service (generated for this path) ----------
echo "==> Installing systemd service 'conway-hq'..."
cat > /etc/systemd/system/conway-hq.service <<EOF
[Unit]
Description=Conway Sales HQ ($ADMIN)
After=network.target

[Service]
Type=simple
WorkingDirectory=$PROJECT_DIR/server
ExecStart=$(command -v node) server.js
Environment=PORT=$APP_PORT
Restart=on-failure
RestartSec=3
User=root

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable --now conway-hq

# ---------- Caddy config (generated for these domains) ----------
echo "==> Configuring Caddy + HTTPS..."
cat > /etc/caddy/Caddyfile <<EOF
$APEX, www.$APEX {
    root * $PROJECT_DIR/landing
    file_server
    encode gzip
    @www host www.$APEX
    redir @www https://$APEX{uri} permanent
}

$ADMIN {
    reverse_proxy 127.0.0.1:$APP_PORT
    encode gzip
}
EOF
systemctl reload caddy || systemctl restart caddy

echo ""
echo "============================================================"
echo " Setup complete."
echo "   • App service:  systemctl status conway-hq"
echo "   • Logs:         journalctl -u conway-hq -f"
echo ""
echo " NEXT:"
echo "   1) Edit $PROJECT_DIR/server/.env  (AI key + a strong ADMIN_PASS),"
echo "      then: systemctl restart conway-hq"
echo "   2) Point DNS at this droplet (A records for @, www, admin)."
echo ""
echo " Once DNS resolves, HTTPS is automatic:"
echo "   https://$APEX        (landing)"
echo "   https://$ADMIN       (dashboard)"
echo "============================================================"
