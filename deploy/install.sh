#!/usr/bin/env bash
#
# Installs the hub on a Raspberry Pi (or any Debian-ish Linux) as a systemd
# service. Safe to re-run: it upgrades an existing install in place.
#
#   git clone https://github.com/MOTOMOTO2/pi-smart-home-hub
#   cd pi-smart-home-hub
#   sudo ./deploy/install.sh
#
set -euo pipefail

APP_DIR=${APP_DIR:-/opt/pi-smart-home-hub}
SERVICE=pi-smart-home-hub
USER_NAME=${HUB_USER:-hub}
NODE_MAJOR=${NODE_MAJOR:-20}
SOURCE_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)

say() { printf '\n\033[1;36m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33mwarning:\033[0m %s\n' "$*"; }
die() { printf '\033[1;31merror:\033[0m %s\n' "$*" >&2; exit 1; }

[[ $EUID -eq 0 ]] || die "run with sudo"
command -v systemctl >/dev/null || die "this installer expects systemd"

# ---------------------------------------------------------------- node
if command -v node >/dev/null && [[ $(node -p 'process.versions.node.split(".")[0]') -ge 20 ]]; then
  say "node $(node -v) is already installed"
else
  say "installing Node.js ${NODE_MAJOR}.x from NodeSource"
  curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | bash -
  apt-get install -y nodejs
fi

# ---------------------------------------------------------------- user
if id "$USER_NAME" >/dev/null 2>&1; then
  say "service user '$USER_NAME' exists"
else
  say "creating service user '$USER_NAME'"
  useradd --system --home-dir "$APP_DIR" --shell /usr/sbin/nologin "$USER_NAME"
fi

# ---------------------------------------------------------------- files
say "installing to $APP_DIR"
mkdir -p "$APP_DIR"
if [[ "$SOURCE_DIR" != "$APP_DIR" ]]; then
  # Keep data/ and config/hub.yaml: they hold tokens and the user's setup.
  rsync -a --delete \
    --exclude 'node_modules' \
    --exclude '.git' \
    --exclude 'data' \
    --exclude 'config/hub.yaml' \
    "$SOURCE_DIR/" "$APP_DIR/"
fi

cd "$APP_DIR"

say "installing dependencies"
# Pure-JS dependencies only, so there is nothing to compile on an ARM board.
npm ci --omit=dev --no-audit --no-fund || npm install --omit=dev --no-audit --no-fund

say "building the server and the dashboard"
# The build needs devDependencies (TypeScript, Vite); drop them again after.
npm install --no-audit --no-fund
npm run build
npm prune --omit=dev

if [[ ! -f config/hub.yaml ]]; then
  say "no config/hub.yaml yet, copying the example"
  cp config/hub.example.yaml config/hub.yaml
  warn "edit $APP_DIR/config/hub.yaml with your devices, then: sudo systemctl restart $SERVICE"
  warn "until you do, the hub runs the simulated demo profile"
fi

mkdir -p data
chown -R "$USER_NAME:$USER_NAME" "$APP_DIR"
chmod 700 data
chmod 600 config/hub.yaml 2>/dev/null || true

if [[ ! -f /etc/pi-smart-home-hub.env ]]; then
  install -m 600 -o "$USER_NAME" -g "$USER_NAME" /dev/null /etc/pi-smart-home-hub.env
  cat > /etc/pi-smart-home-hub.env <<'ENV'
# Secrets for the hub. Reference them from config/hub.yaml as ${NAME}.
# ECOBEE_API_KEY=
# PC_AGENT_TOKEN=
# HUB_TOKEN=
ENV
  chmod 600 /etc/pi-smart-home-hub.env
fi

# ---------------------------------------------------------------- service
say "installing the systemd unit"
sed "s|/opt/pi-smart-home-hub|$APP_DIR|g; s|^User=hub$|User=$USER_NAME|; s|^Group=hub$|Group=$USER_NAME|" \
  deploy/$SERVICE.service > /etc/systemd/system/$SERVICE.service
systemctl daemon-reload
systemctl enable "$SERVICE"
systemctl restart "$SERVICE"

sleep 3
if systemctl is-active --quiet "$SERVICE"; then
  PORT=$(grep -oP '^\s*port:\s*\K[0-9]+' config/hub.yaml 2>/dev/null | head -1 || echo 8080)
  IP=$(hostname -I 2>/dev/null | awk '{print $1}')
  say "the hub is running"
  printf '\n  dashboard:  http://%s:%s\n' "${IP:-<pi-ip>}" "${PORT:-8080}"
  printf '  logs:       sudo journalctl -u %s -f\n' "$SERVICE"
  printf '  config:     sudo -u %s nano %s/config/hub.yaml\n' "$USER_NAME" "$APP_DIR"
  printf '  secrets:    sudo nano /etc/pi-smart-home-hub.env\n'
  printf '  restart:    sudo systemctl restart %s\n\n' "$SERVICE"
else
  die "the service failed to start. Check: sudo journalctl -u $SERVICE -n 50"
fi
