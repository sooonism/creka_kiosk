#!/bin/bash
# Run with: sudo bash ~/harden-pi.sh
set -e

# 1. no surprise apt updates (data cost on SIM, can break the kiosk). Update by hand over Tailscale.
systemctl disable --now apt-daily.timer apt-daily-upgrade.timer unattended-upgrades.service

# 2. journal in RAM only: fewer writes to the SD card. Boot logs are lost on reboot.
mkdir -p /etc/systemd/journald.conf.d
printf '[Journal]\nStorage=volatile\nRuntimeMaxUse=50M\n' > /etc/systemd/journald.conf.d/volatile.conf
systemctl restart systemd-journald

# 3. flush dirty ext4 data every 30 s instead of 10 min, so a power cut loses less.
#    remount first: if it fails, fstab stays untouched.
cp -n /etc/fstab /etc/fstab.bak-$(date +%Y%m%d)
mount -o remount,commit=30 /
sed -i 's/commit=600/commit=30/' /etc/fstab
findmnt --verify --tab-file /etc/fstab

echo "--- result"
systemctl is-enabled apt-daily.timer apt-daily-upgrade.timer unattended-upgrades.service || true
journalctl --header 2>/dev/null | head -0; grep -H Storage /etc/systemd/journald.conf.d/volatile.conf
grep -o 'commit=[0-9]*' /proc/mounts | head -1
echo DONE
