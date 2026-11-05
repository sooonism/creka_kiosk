#!/bin/bash
# Runs as root (systemd service wifi-fallback). If wlan0 stays disconnected for GRACE seconds, or is connected
# but has no real internet for NOINET_GRACE seconds (dead SIM, captive portal), open a WPA2 setup hotspot +
# web form (wifi-setup.py) for WINDOW seconds, then go back to client mode and retry.
# Usage: wifi-fallback.sh          (daemon)
#        wifi-fallback.sh now      (open the setup hotspot once, immediately; for testing)
# Config: /etc/wifi-fallback.env (AP_SSID, AP_PASS, optional GRACE, NOINET_GRACE, WINDOW)
. /etc/wifi-fallback.env
GRACE=${GRACE:-90}
NOINET_GRACE=${NOINET_GRACE:-180}
WINDOW=${WINDOW:-300}
IF=wlan0
AP=wifi-setup-ap
here=$(dirname "$(readlink -f "$0")")

# real internet = Google's 204 (a captive portal answers 200) or our site over valid TLS (a portal can't fake that);
# either alone keeps us "online", so a Creka server outage doesn't open the hotspot
online() {
  [ "$(curl -s -m 5 -o /dev/null -w '%{http_code}' http://connectivitycheck.gstatic.com/generate_204)" = 204 ] ||
    curl -fs -m 5 -o /dev/null https://kiosk.creka.online/
}
connected() { [ "$(nmcli -g GENERAL.STATE dev show $IF | cut -d' ' -f1)" = 100 ]; }

ap_window() {
  echo "no wifi: opening setup hotspot $AP_SSID for ${WINDOW}s"
  # scan first: the radio can't scan while it is an access point
  nmcli -t -f SSID dev wifi list ifname $IF --rescan yes | awk 'NF && !s[$0]++' > /run/wifi-fallback.ssids
  nmcli con delete $AP >/dev/null 2>&1
  nmcli con add type wifi ifname $IF con-name $AP autoconnect no ssid "$AP_SSID" mode ap \
    802-11-wireless.band bg ipv4.method shared ipv4.addresses 10.42.0.1/24 \
    wifi-sec.key-mgmt wpa-psk wifi-sec.psk "$AP_PASS" >/dev/null
  if nmcli con up $AP >/dev/null 2>&1; then
    echo "hotspot up, waiting for credentials"
    timeout "$WINDOW" python3 "$here/wifi-setup.py"   # exits early once credentials are saved
  else
    echo "hotspot failed to start (does the wifi driver support AP mode?)"
  fi
  echo "closing hotspot, back to client mode"
  nmcli con delete $AP >/dev/null 2>&1
  nmcli dev connect $IF >/dev/null 2>&1   # back to client mode: autoconnect picks the best saved profile
  sleep 30
}

[ "$1" = now ] && { ap_window; exit; }

off=0; noinet=0; t=0
while sleep 5; do
  t=$((t + 5))
  if ! connected; then
    off=$((off + 5)); noinet=0
  else
    off=0
    if [ $((t % 30)) = 0 ]; then   # probe every 30 s: a few bytes, fine on a SIM
      if online; then noinet=0; else noinet=$((noinet + 30)); fi
    fi
  fi
  if [ "$off" -ge "$GRACE" ] || [ "$noinet" -ge "$NOINET_GRACE" ]; then
    ap_window
    off=0; noinet=0
  fi
done
