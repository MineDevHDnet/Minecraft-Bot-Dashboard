#!/usr/bin/env bash
set -Eeuo pipefail

[[ ${EUID:-$(id -u)} -eq 0 ]] || { echo "Bitte als root ausführen." >&2; exit 1; }

SRC="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="/opt/minecraft-bot-dashboard"

echo "[1/4] Dashboard-Dateien austauschen ..."
if [[ "$SRC" != "$APP_DIR" ]]; then
  STAGE="$(mktemp -d /opt/minecraft-bot-dashboard.update.XXXXXX)"
  BACKUP="/opt/minecraft-bot-dashboard.previous.$$"
  trap 'rm -rf "$STAGE" "$BACKUP"' EXIT

  tar -C "$SRC" --exclude='dashboard.env' -cf - . | tar -C "$STAGE" -xf -
  chown -R root:bot-dashboard "$STAGE"
  find "$STAGE" -type d -exec chmod 0755 {} +
  find "$STAGE" -type f -exec chmod 0644 {} +
  chmod 0755 "$STAGE/install.sh" "$STAGE/update.sh" "$STAGE/scripts/minecraft-dashboardctl"

  if [[ -d "$APP_DIR" ]]; then
    mv "$APP_DIR" "$BACKUP"
  fi
  mv "$STAGE" "$APP_DIR"
  STAGE=""
  rm -rf "$BACKUP"
  BACKUP=""
else
  echo "Repository liegt bereits in $APP_DIR; git pull hat die Webdateien bereits ersetzt."
  chown -R root:bot-dashboard "$APP_DIR"
  find "$APP_DIR" -type d -exec chmod 0755 {} +
  find "$APP_DIR" -type f -exec chmod 0644 {} +
  chmod 0755 "$APP_DIR/install.sh" "$APP_DIR/update.sh" "$APP_DIR/scripts/minecraft-dashboardctl"
fi

echo "[2/4] Root-Helper austauschen ..."
install -o root -g root -m 0755 "$APP_DIR/scripts/minecraft-dashboardctl" /usr/local/sbin/minecraft-dashboardctl
visudo -cf /etc/sudoers.d/minecraft-bot-dashboard >/dev/null

echo "[3/4] systemd-Dateien aktualisieren ..."
install -o root -g root -m 0644 "$APP_DIR/systemd/minecraft-bot-dashboard.service" /etc/systemd/system/minecraft-bot-dashboard.service
systemctl daemon-reload
systemctl restart minecraft-bot-dashboard.service

echo "[4/4] Nginx aktualisieren ..."
NGINX_SITE="/etc/nginx/sites-available/minecraft-bot-dashboard"
if [[ -f "$NGINX_SITE" ]]; then
  if grep -qE '^[[:space:]]*client_max_body_size[[:space:]]+' "$NGINX_SITE"; then
    sed -i -E 's/^[[:space:]]*client_max_body_size[[:space:]]+[^;]+;/    client_max_body_size 256m;/' "$NGINX_SITE"
  else
    sed -i '/server_name /a\    client_max_body_size 256m;' "$NGINX_SITE"
  fi

  if grep -qE '^[[:space:]]*client_body_timeout[[:space:]]+' "$NGINX_SITE"; then
    sed -i -E 's/^[[:space:]]*client_body_timeout[[:space:]]+[^;]+;/    client_body_timeout 120s;/' "$NGINX_SITE"
  else
    sed -i '/client_max_body_size /a\    client_body_timeout 120s;' "$NGINX_SITE"
  fi

  sed -i -E 's/^[[:space:]]*proxy_read_timeout[[:space:]]+[^;]+;/        proxy_read_timeout 600s;/' "$NGINX_SITE"
fi
nginx -t
systemctl reload nginx

echo
echo "Update fertig: Webdateien, Root-Helper und Upload-Limits wurden aktualisiert."
echo "Dashboard: https://bot-cloud.de"
