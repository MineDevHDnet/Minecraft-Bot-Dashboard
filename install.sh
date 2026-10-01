#!/usr/bin/env bash
set -Eeuo pipefail

[[ ${EUID:-$(id -u)} -eq 0 ]] || { echo "Bitte als root ausführen." >&2; exit 1; }

SRC="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="/opt/minecraft-bot-dashboard"
ENV_DIR="/etc/minecraft-bot-dashboard"
ENV_FILE="$ENV_DIR/dashboard.env"
DOMAIN="${DOMAIN:-bot-cloud.de}"
PORT="${PORT:-3210}"
EMAIL="${EMAIL:-}"
SKIP_SSL="${SKIP_SSL:-0}"

command -v apt-get >/dev/null 2>&1 || { echo "Dieses Setup ist für Debian/Ubuntu gedacht." >&2; exit 1; }

echo "[1/7] Pakete installieren ..."
apt-get update -qq
DEBIAN_FRONTEND=noninteractive apt-get install -y -qq nodejs nginx sudo python3 openssl git certbot python3-certbot-nginx >/dev/null

if ! id bot-dashboard >/dev/null 2>&1; then
  useradd --system --home-dir "$APP_DIR" --shell /usr/sbin/nologin bot-dashboard
fi

echo "[2/7] Dashboard installieren ..."
if [[ "$SRC" != "$APP_DIR" ]]; then
  rm -rf "$APP_DIR"
  mkdir -p "$APP_DIR"
  tar -C "$SRC" --exclude='dashboard.env' -cf - . | tar -C "$APP_DIR" -xf -
else
  echo "Repository liegt bereits in $APP_DIR; Dateien werden direkt verwendet."
fi
chown -R root:bot-dashboard "$APP_DIR"
find "$APP_DIR" -type d -exec chmod 0755 {} +
find "$APP_DIR" -type f -exec chmod 0644 {} +
chmod 0755 "$APP_DIR/install.sh" "$APP_DIR/update.sh" "$APP_DIR/scripts/minecraft-dashboardctl"

install -o root -g root -m 0755 "$APP_DIR/scripts/minecraft-dashboardctl" /usr/local/sbin/minecraft-dashboardctl
cat > /etc/sudoers.d/minecraft-bot-dashboard <<'SUDOEOF'
bot-dashboard ALL=(root) NOPASSWD: /usr/local/sbin/minecraft-dashboardctl *
SUDOEOF
chmod 0440 /etc/sudoers.d/minecraft-bot-dashboard
visudo -cf /etc/sudoers.d/minecraft-bot-dashboard >/dev/null

echo "[3/7] Login konfigurieren ..."
if [[ -z "${DASHBOARD_PASSWORD:-}" ]]; then
  while true; do
    read -rsp "Dashboard-Passwort: " DASHBOARD_PASSWORD; echo
    read -rsp "Passwort wiederholen: " DASHBOARD_PASSWORD_2; echo
    [[ "$DASHBOARD_PASSWORD" == "$DASHBOARD_PASSWORD_2" ]] || { echo "Passwörter stimmen nicht überein."; continue; }
    [[ ${#DASHBOARD_PASSWORD} -ge 8 ]] || { echo "Mindestens 8 Zeichen verwenden."; continue; }
    break
  done
fi

PASSWORD_HASH="$(node - "$DASHBOARD_PASSWORD" <<'NODE'
const crypto = require('crypto');
const password = process.argv[2];
const salt = crypto.randomBytes(16);
const hash = crypto.scryptSync(password, salt, 64);
process.stdout.write(`${salt.toString('hex')}:${hash.toString('hex')}`);
NODE
)"
unset DASHBOARD_PASSWORD DASHBOARD_PASSWORD_2
SESSION_SECRET="$(openssl rand -hex 48)"
mkdir -p "$ENV_DIR"
cat > "$ENV_FILE" <<EOF2
PORT=$PORT
DASHBOARD_PASSWORD_HASH=$PASSWORD_HASH
SESSION_SECRET=$SESSION_SECRET
COOKIE_SECURE=true
CONTROL_BIN=/usr/local/sbin/minecraft-dashboardctl
EOF2
chown root:bot-dashboard "$ENV_DIR" "$ENV_FILE"
chmod 0750 "$ENV_DIR"
chmod 0640 "$ENV_FILE"

echo "[4/7] systemd einrichten ..."
install -o root -g root -m 0644 "$APP_DIR/systemd/minecraft-bot-dashboard.service" /etc/systemd/system/minecraft-bot-dashboard.service
systemctl daemon-reload
systemctl enable --now minecraft-bot-dashboard.service >/dev/null
sleep 1
systemctl is-active --quiet minecraft-bot-dashboard.service || {
  journalctl -u minecraft-bot-dashboard.service -n 80 --no-pager
  exit 1
}

echo "[5/7] Nginx einrichten ..."
NGINX_SITE="/etc/nginx/sites-available/minecraft-bot-dashboard"
sed -e "s/__DOMAIN__/$DOMAIN/g" -e "s/__PORT__/$PORT/g" "$APP_DIR/nginx/minecraft-bot-dashboard.conf" > "$NGINX_SITE"
ln -sfn "$NGINX_SITE" /etc/nginx/sites-enabled/minecraft-bot-dashboard
rm -f /etc/nginx/sites-enabled/default
nginx -t
systemctl enable --now nginx >/dev/null
systemctl reload nginx

echo "[6/7] HTTPS einrichten ..."
SSL_OK=0
if [[ "$SKIP_SSL" == "1" ]]; then
  echo "HTTPS wurde per SKIP_SSL=1 übersprungen."
else
  CERTBOT_ARGS=(--nginx -d "$DOMAIN" --non-interactive --agree-tos --redirect)
  if [[ -n "$EMAIL" ]]; then
    CERTBOT_ARGS+=(--email "$EMAIL")
  else
    CERTBOT_ARGS+=(--register-unsafely-without-email)
  fi
  if certbot "${CERTBOT_ARGS[@]}"; then
    SSL_OK=1
  else
    echo "WARNUNG: Let's Encrypt konnte noch nicht eingerichtet werden. Prüfe den DNS-A/AAAA-Record für $DOMAIN." >&2
  fi
fi

if [[ "$SSL_OK" != "1" ]]; then
  sed -i 's/^COOKIE_SECURE=true$/COOKIE_SECURE=false/' "$ENV_FILE"
  systemctl restart minecraft-bot-dashboard.service
fi

echo "[7/7] Fertig"
echo
echo "Dashboard: $([[ "$SSL_OK" == "1" ]] && echo https || echo http)://$DOMAIN"
echo "Service:   systemctl status minecraft-bot-dashboard"
echo "Logs:      journalctl -u minecraft-bot-dashboard -f"
if [[ "$SSL_OK" != "1" ]]; then
  echo
  echo "Sobald DNS korrekt zeigt, HTTPS nachholen mit:"
  echo "  certbot --nginx -d $DOMAIN --redirect"
  echo "Danach COOKIE_SECURE=true in $ENV_FILE setzen und den Dashboard-Service neu starten."
fi
