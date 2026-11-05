#!/bin/bash
# Minutely Pi health report to creka_backend (POST /kiosks/<id>/health). Run by kiosk-health.timer as the
# kiosk user so xrandr can reach the X session. Needs curl, jq, nmcli, xrandr, v4l2-ctl. Config: ~/.config/kiosk-health.env.
. ~/.config/kiosk-health.env   # KIOSK_ID, BACKEND
export DISPLAY=:0

up=$(cut -d. -f1 /proc/uptime)
temp=$(awk '{printf "%.1f", $1/1000}' /sys/class/thermal/thermal_zone0/temp 2>/dev/null)
disk=$(df --output=pcent / | tail -1 | tr -dc 0-9); disk=$((100 - disk))
mem=$(awk '/MemTotal/{t=$2} /MemAvailable/{a=$2} END{printf "%.1f", 100*a/t}' /proc/meminfo)
IFS=: read -r _ ssid wifi < <(nmcli -t -f ACTIVE,SSID,SIGNAL dev wifi 2>/dev/null | grep '^yes' | head -1)
ip=$(hostname -I | cut -d' ' -f1)
timeout 3 xrandr 2>/dev/null | grep -q ' connected' && display=true || display=false
{ [ -e /dev/video0 ] && timeout 3 v4l2-ctl -d /dev/video0 --get-fmt-video >/dev/null 2>&1; } && camera=true || camera=false
pgrep -x chromium >/dev/null && browser=true || browser=false
url=$(curl -s -m 3 localhost:9222/json | jq -r '[.[] | select(.type == "page")][0].url // empty')
chronyc tracking 2>/dev/null | grep -q 'Leap status *: Normal' && ntp=true || ntp=false   # timedatectl is broken on this image

jq -n --arg up "$up" --arg temp "$temp" --arg disk "$disk" --arg mem "$mem" --arg wifi "$wifi" \
  --arg ssid "$ssid" --arg ip "$ip" --arg url "$url" \
  --argjson display $display --argjson camera $camera --argjson browser $browser --argjson ntp $ntp '
  def n($s): try ($s | tonumber) catch null;
  def s($s): if $s == "" then null else $s end;
  {up: n($up), temp: n($temp), disk_pct: n($disk), mem_pct: n($mem), wifi_pct: n($wifi),
   ssid: s($ssid), ip: s($ip), url: s($url), display: $display, camera: $camera, browser: $browser, ntp: $ntp}
  | with_entries(select(.value != null))' |
  curl -fsS -m 10 -X POST -H 'Content-Type: application/json' --data @- "$BACKEND/kiosks/$KIOSK_ID/health" >/dev/null
