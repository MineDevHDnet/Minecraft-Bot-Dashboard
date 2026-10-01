# Minecraft Bot Dashboard

Web-Dashboard für die Minecraft-Bots auf dem Rootserver. Es ist auf die bestehende `minecraft-root@<id>.service`-Installation zugeschnitten und verwendet `bot-cloud.de` als Standard-Domain.

## Funktionen

- Live-Übersicht aller installierten Bot-Instanzen
- Minecraft-Verbindungsstatus über die echte TCP-Verbindung auf Port 25565
- CPU, RAM und Laufzeit pro Bot
- Start, Stop und Restart pro Bot
- letzte Addon-/Minecraft-Logs direkt im Browser
- Rootserver-Übersicht mit Load, RAM, Disk und Uptime
- LabyCrafter-Verwaltung für `mangoskanone` und `gamecasino`
  - Material ändern
  - Werkbank oder Komprimierung wählen
  - Ziel-Citybuild ändern
  - Home-Befehl ändern
  - Speichern startet nur den betroffenen Crafter neu
- automatische Ausblendung nicht installierter Instanzen
- Login mit scrypt-Passwort-Hash und signierter HttpOnly-Session
- responsive Oberfläche für Desktop und Handy

## Unterstützte Instanzen

| ID | Account | Addon |
| --- | --- | --- |
| `evelyn-veyroxcore` | VeyroxCore | Evelyn |
| `evelyn-msr3xie` | MsR3xie | Evelyn |
| `evelyn-rxt3r` | RxT3R | Evelyn |
| `cb2-bot` | CB2_Bot | Abyss |
| `mangoskanone` | Mangoskanone | LabyCrafter |
| `gamecasino` | GameCasino | LabyCrafter |

Die LabyCrafter-Einstellungen werden in der bereits unterstützten Datei `.minecraft/LabyCrafter/headless.properties` gespeichert. Eine Änderung von Material oder Profil startet nur diese eine Instanz neu, damit LabyCrafter die neue Startup-Auswahl lädt.

## Installation

Der DNS-A/AAAA-Record von `bot-cloud.de` sollte bereits auf den Rootserver zeigen. Danach auf dem Minecraft-Server:

```bash
git clone https://github.com/MineDevHDnet/Minecraft-Bot-Dashboard.git
cd Minecraft-Bot-Dashboard
sudo bash install.sh
```

Der Installer fragt das Dashboard-Passwort ab und richtet Node.js, den Dashboard-Systembenutzer, die eingeschränkte Root-Steuerung, systemd, Nginx und Let's Encrypt ein.

Eigene Domain oder E-Mail für Let's Encrypt:

```bash
DOMAIN=bot-cloud.de EMAIL=mail@example.com sudo -E bash install.sh
```

Wenn DNS noch nicht fertig ist:

```bash
SKIP_SSL=1 sudo -E bash install.sh
```

Später kann HTTPS mit `certbot --nginx -d bot-cloud.de --redirect` aktiviert werden. Danach in `/etc/minecraft-bot-dashboard/dashboard.env` wieder `COOKIE_SECURE=true` setzen und `systemctl restart minecraft-bot-dashboard` ausführen.

## Betrieb

```bash
systemctl status minecraft-bot-dashboard
journalctl -u minecraft-bot-dashboard -f
```

Update nach neuen Commits:

```bash
cd /opt/minecraft-bot-dashboard
git pull
systemctl restart minecraft-bot-dashboard
```

## Sicherheit

Das Web-Backend läuft als eigener Benutzer `bot-dashboard`, nicht als root. Privilegierte Aktionen laufen ausschließlich über `/usr/local/sbin/minecraft-dashboardctl`. Dieses Helper-Skript akzeptiert nur die bekannten Bot-IDs und eine feste Menge an Aktionen. Das Dashboard-Passwort wird nicht im Klartext gespeichert, sondern als scrypt-Hash. Sessions werden HMAC-signiert und bei HTTPS als `Secure`, `HttpOnly` und `SameSite=Strict` gesetzt.

## Technischer Aufbau

- `server.js` – Node.js REST-API und Session/Auth ohne externe npm-Abhängigkeiten
- `public/` – responsive Dashboard-Oberfläche
- `scripts/minecraft-dashboardctl` – eingeschränkte System-/Bot-Steuerung
- `config/bots.json` – bekannte Instanzen und Typen
- `systemd/` – Dashboard-Service
- `nginx/` – Reverse-Proxy-Vorlage
- `install.sh` – komplette Serverinstallation
