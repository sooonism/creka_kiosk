#!/bin/bash
# Run on the Pi as root: sudo bash install-wifi-fallback.sh <kiosk-id>   (prompts for the setup hotspot password)
# Installs wifi-fallback.sh + wifi-setup.py to /opt/wifi-fallback and enables the wifi-fallback systemd service.
set -e
id=${1:?kiosk id, e.g. orangepi-1}
here=$(dirname "$(readlink -f "$0")")
read -rsp "Setup hotspot password (8-63 chars): " pass; echo
[ ${#pass} -ge 8 ] && [ ${#pass} -le 63 ] || { echo "password must be 8-63 characters"; exit 1; }

# NetworkManager's hotspot runs its own dnsmasq on :53; the system one would block it (nothing here uses it)
systemctl disable --now dnsmasq 2>/dev/null || true

# every DNS lookup from a phone on the hotspot answers 10.42.0.1, so phones pop up the setup page by themselves
mkdir -p /etc/NetworkManager/dnsmasq-shared.d
echo 'address=/#/10.42.0.1' > /etc/NetworkManager/dnsmasq-shared.d/captive.conf

install -d /opt/wifi-fallback
install -m 755 "$here/wifi-fallback.sh" "$here/wifi-setup.py" /opt/wifi-fallback/
printf 'AP_SSID=creka-setup-%s\nAP_PASS=%s\n' "$id" "$pass" > /etc/wifi-fallback.env
chmod 600 /etc/wifi-fallback.env

cat > /etc/systemd/system/wifi-fallback.service <<'UNIT'
[Unit]
Description=Open a setup hotspot when no wifi connects
After=NetworkManager.service
[Service]
ExecStart=/opt/wifi-fallback/wifi-fallback.sh
Restart=always
[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable --now wifi-fallback.service
echo "ok: setup hotspot 'creka-setup-$id' opens after 90 s without wifi"
