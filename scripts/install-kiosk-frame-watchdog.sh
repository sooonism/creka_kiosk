#!/usr/bin/env bash
# Install the page watchdog on a Pi as a user systemd service (no sudo). Run on the Pi, as the kiosk user:
#   scp scripts/kiosk-frame-watchdog.py scripts/install-kiosk-frame-watchdog.sh orangepi@<ip>:/tmp/ && ssh orangepi@<ip> 'bash /tmp/install-kiosk-frame-watchdog.sh'
# Needs Chromium started with --remote-debugging-port=9222 (the autostart already does).
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
mkdir -p ~/.local/bin ~/.config/systemd/user
install -m 755 "$here/kiosk-frame-watchdog.py" ~/.local/bin/kiosk-frame-watchdog
cat > ~/.config/systemd/user/kiosk-frame-watchdog.service <<'EOF'
[Unit]
Description=Restart the kiosk page when Chromium stops drawing frames

[Service]
ExecStart=%h/.local/bin/kiosk-frame-watchdog
Restart=always
RestartSec=10

[Install]
WantedBy=default.target
EOF
systemctl --user daemon-reload
systemctl --user enable --now kiosk-frame-watchdog.service
systemctl --user --no-pager status kiosk-frame-watchdog.service | head -5
echo "log: journalctl --user -u kiosk-frame-watchdog -f"
