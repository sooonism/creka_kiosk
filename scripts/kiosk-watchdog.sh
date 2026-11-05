#!/bin/bash
# Runs on the Pi as a systemd user service (installed by install-kiosk-health.sh).
# If Chromium sits on its "can't be reached" page (e.g. the kiosk booted before the internet was up),
# restart it as soon as the site answers; the autostart loop relaunches it.
# Chromium names a failed page after its host, so title == host means "error page".
# Usage: kiosk-watchdog.sh            (daemon)
#        kiosk-watchdog.sh test       (self-check of the error-page rule)
site=https://kiosk.creka.online/

is_error_page() {   # $1 = url, $2 = title
  local host=${1#*://}; host=${host%%[/?#]*}
  [ -n "$1" ] && [ "$2" = "$host" ]
}

if [ "$1" = test ]; then
  is_error_page "https://kiosk.creka.online/demo/camwithnkob/?kiosk=x" "kiosk.creka.online" || { echo FAIL error-page; exit 1; }
  is_error_page "http://nonexistent.invalid/" "nonexistent.invalid"                          || { echo FAIL error-page 2; exit 1; }
  is_error_page "https://kiosk.creka.online/demo/camwithnkob/?kiosk=x" "Astro Basics"        && { echo FAIL healthy; exit 1; }
  is_error_page "" ""                                                                        && { echo FAIL empty; exit 1; }
  echo OK; exit 0
fi

while sleep 15; do
  IFS=$'\t' read -r url title < <(curl -s -m 3 localhost:9222/json | jq -r '[.[] | select(.type == "page")][0] | "\(.url)\t\(.title)"' 2>/dev/null)
  is_error_page "$url" "$title" && curl -fsS -m 5 -o /dev/null "$site" && pkill -x chromium
done
