#!/bin/bash
# Run on the Pi as the kiosk user (no root): bash install-kiosk-health.sh <kiosk-id> [backend-url] [interval]
# Installs kiosk-health.sh plus a systemd *user* timer (the autologin session is always up on a kiosk).
set -e
id=${1:?kiosk id, e.g. orangepi-4pro}
backend=${2:-https://creka.online/api/v1/photobooth}
interval=${3:-1min}
here=$(dirname "$0")
export XDG_RUNTIME_DIR=/run/user/$(id -u)

mkdir -p ~/.local/bin ~/.config/systemd/user
install -m 755 "$here/kiosk-health.sh" ~/.local/bin/kiosk-health
printf 'KIOSK_ID=%s\nBACKEND=%s\n' "$id" "$backend" > ~/.config/kiosk-health.env

cat > ~/.config/systemd/user/kiosk-health.service <<UNIT
[Unit]
Description=Report kiosk health to creka_backend
[Service]
Type=oneshot
ExecStart=%h/.local/bin/kiosk-health
Nice=10
UNIT

cat > ~/.config/systemd/user/kiosk-health.timer <<UNIT
[Unit]
Description=Kiosk health report every $interval
[Timer]
OnBootSec=30s
OnUnitActiveSec=$interval
AccuracySec=5s
[Install]
WantedBy=timers.target
UNIT

# watchdog: restart Chromium if it is stuck on its "can't be reached" page once the site answers again
install -m 755 "$here/kiosk-watchdog.sh" ~/.local/bin/kiosk-watchdog
cat > ~/.config/systemd/user/kiosk-watchdog.service <<UNIT
[Unit]
Description=Restart Chromium if the kiosk page failed to load
[Service]
ExecStart=%h/.local/bin/kiosk-watchdog
Restart=always
Nice=10
[Install]
WantedBy=default.target
UNIT

systemctl --user daemon-reload
systemctl --user enable --now kiosk-health.timer kiosk-watchdog.service
loginctl enable-linger "$USER" 2>/dev/null || true   # keep it running even if the session restarts
systemctl --user start kiosk-health.service && echo "ok: first report sent"
