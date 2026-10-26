# Orange Pi Kiosk Setup — Hardware & Software Workflow

Complete guide to setting up an Orange Pi as a browser-based kiosk running
Creka Kiosk pages (`https://kiosk.creka.online`).

---

## Table of Contents

- [1. Overview](#1-overview)
- [2. Hardware](#2-hardware)
- [3. Initial OS Setup](#3-initial-os-setup)
- [4. Software Installation](#4-software-installation)
- [5. Openbox & X11 Configuration](#5-openbox--x11-configuration)
- [6. Autostart & Chromium Kiosk Mode](#6-autostart--chromium-kiosk-mode)
- [7. Camera & Permissions](#7-camera--permissions)
- [8. First Boot & Verification](#8-first-boot--verification)
- [9. Remote Access (SSH + Debug)](#9-remote-access-ssh--debug)
- [10. Deploying Kiosk Pages](#10-deploying-kiosk-pages)
- [11. Troubleshooting](#11-troubleshooting)

---

## 1. Overview

The kiosk setup runs a full-screen Chromium instance on an Orange Pi, connected
to a display and USB webcam. It auto-starts on power-on, loads a Creka Kiosk
page over HTTPS, and uses MediaPipe via the webcam for real-time computer
vision (hand tracking, face detection, pose estimation, etc.).

**Architecture:**

```
[USB Camera] ──→ [Orange Pi] ──HDMI──→ [Display]
                      │
                      │ SSH / remote debug (port 9222)
                      │
[Cloudflare] ←── [Server (208.87.132.15)]
                      │
            kiosk.creka.online (HTTPS)
```

Cloudflare terminates SSL. The kiosk page must load over **HTTPS** because
`navigator.mediaDevices.getUserMedia()` requires a secure context.

---

## 2. Hardware

| Component | Example |
|---|---|
| Board | Orange Pi 4 Pro (6-core, 4GB RAM recommended) |
| Power | USB-C, 5V/3A (or 12V barrel if using OPi 5) |
| Storage | MicroSD (32GB+ recommended) or eMMC module |
| Display | HDMI monitor or touchscreen |
| Camera | USB webcam (UVC-compatible, 720p+) |
| Network | WiFi or Ethernet |
| Input | USB keyboard/mouse (for setup only) |

**Known working camera:** USB Camera (32e6:9221) — MediaPipe compatible.

---

## 3. Initial OS Setup

### Flash the OS

1. Download **Orange Pi OS (Bullseye)** or **Armbian** for your board from
   the official Orange Pi website.
2. Flash to MicroSD using Raspberry Pi Imager, balenaEtcher, or `dd`:

   ```bash
   # Find your SD card device
   diskutil list
   # Unmount & flash (replace /dev/diskX with your SD card)
   diskutil unmountDisk /dev/diskX
   sudo dd if=orangepi-os.img of=/dev/rdiskX bs=4m status=progress
   diskutil eject /dev/diskX
   ```

3. Insert the SD card into the Orange Pi, connect HDMI, keyboard, and power on.

### First Boot

Default credentials (Orange Pi OS):
```
Username: orangepi
Password: orangepi
```

Run initial updates:

```bash
sudo apt update && sudo apt upgrade -y
```

**Important:** After a major `apt upgrade`, you may need to clear Chromium's
profile cache (see [Troubleshooting — Camera not available](#camera-not-available)).

---

## 4. Software Installation

Install all required packages in one go:

```bash
# X11 display server
sudo apt install --no-install-recommends -y xorg openbox

# Chromium browser
sudo apt install -y chromium

# Utilities
sudo apt install -y unclutter x11-xserver-utils xdotool

# Camera & video tools (optional but useful for debugging)
sudo apt install -y v4l-utils

# SSH (already installed on most images, verify)
sudo apt install -y openssh-server
```

### Verify the user is in the `video` group

```bash
groups orangepi
# Should show: orangepi ... video ...
```

If `video` is missing:

```bash
sudo usermod -a -G video orangepi
```

Reboot for group changes to take effect:

```bash
sudo reboot
```

---

## 5. Openbox & X11 Configuration

Create the Openbox autostart directory:

```bash
mkdir -p ~/.config/openbox
```

### Autostart Script

Create `~/.config/openbox/autostart`:

```bash
#!/bin/bash

# Disable screen blanking & power saving
xset s off
xset s noblank
xset -dpms

# Hide mouse cursor after 2 seconds idle
unclutter -idle 2 -root &

# Kiosk loop — restart Chromium if it crashes
while true; do
	chromium \
		--kiosk \
		--no-first-run \
		--no-sandbox \
		--use-fake-ui-for-media-stream \
		--ignore-gpu-blocklist \
		--enable-webgl \
		--enable-usermedia-screen-capturing \
		--enable-accelerated-2d-canvas \
		--enable-gpu-rasterization \
		--remote-debugging-port=9222 \
		--remote-allow-origins="*" \
		"https://kiosk.creka.online/admin/step_test/"
	sleep 2
done
```

Make it executable:

```bash
chmod +x ~/.config/openbox/autostart
```

### Flag Reference

| Flag | Purpose |
|---|---|
| `--kiosk` | Full-screen kiosk mode (no address bar, no tabs) |
| `--no-first-run` | Skip first-run wizard |
| `--no-sandbox` | Required on some boards without proper sandbox support |
| `--use-fake-ui-for-media-stream` | Auto-approve camera/mic permission prompts |
| `--ignore-gpu-blocklist` | Enable GPU acceleration even on unsupported hardware |
| `--enable-webgl` | WebGL for MediaPipe GPU backend |
| `--enable-usermedia-screen-capturing` | Enable getUserMedia / screen capture APIs |
| `--enable-accelerated-2d-canvas` | Canvas acceleration |
| `--enable-gpu-rasterization` | GPU rasterization for smoother rendering |
| `--remote-debugging-port=9222` | Enable remote DevTools debugging |
| `--remote-allow-origins="*"` | Allow remote debugging from any origin |

### URL trailing slash requirement

Always include the trailing slash (`/`) in the kiosk URL:

```
✅ https://kiosk.creka.online/admin/step_test/
❌ https://kiosk.creka.online/admin/step_test
```

Without the trailing slash, Cloudflare's redirect uses `http://` in the
Location header, which breaks the secure context and disables the camera.

---

## 6. Chromium Kiosk Mode

### Manual launch (for testing)

If you need to launch Chromium without the autostart:

```bash
export DISPLAY=:0
chromium --kiosk --no-first-run --no-sandbox \
  --use-fake-ui-for-media-stream --ignore-gpu-blocklist \
  --enable-webgl --enable-usermedia-screen-capturing \
  --enable-accelerated-2d-canvas --enable-gpu-rasterization \
  --remote-debugging-port=9222 --remote-allow-origins="*" \
  "https://kiosk.creka.online/admin/step_test/"
```

### Switch the kiosk page

Edit `~/.config/openbox/autostart` and change the URL, then:

```bash
# Kill Chromium — the while loop restarts it with the new URL
pkill chromium
```

Or for a page that stays until reboot (without editing autostart):

```bash
# Navigate via keyboard shortcut (if keyboard attached)
# F6 to focus address bar, type URL, Enter

# Or kill and modify on the fly
sed -i 's|step_test|finger_puppet_v2|' ~/.config/openbox/autostart
pkill chromium
```

---

## 7. Camera & Permissions

### Verify camera detection

```bash
# List video devices
ls -la /dev/video*

# Show camera details
v4l2-ctl --list-devices

# Test capture
ffplay -f v4l2 /dev/video0   # if ffmpeg is installed
```

### Permission chain

For the camera to work in the browser:

1. **Kernel** → uvcvideo driver loaded (check with `lsmod | grep uvc`)
2. **Device node** → `/dev/video0` exists (check with `ls -la /dev/video*`)
3. **User** → `orangepi` is in `video` group (check with `groups`)
4. **Browser** → HTTPS secure context (`window.isSecureContext === true`)
5. **Page** → `navigator.mediaDevices.getUserMedia()` called with video constraint
6. **Permission** → auto-approved by `--use-fake-ui-for-media-stream`

If any link in this chain fails, the camera won't work.

### Required Chromium flags for camera

| Flag | Effect |
|---|---|
| `--use-fake-ui-for-media-stream` | Auto-approves the camera permission dialog |
| `--enable-usermedia-screen-capturing` | Enables getUserMedia API |
| `--unsafely-treat-insecure-origin-as-secure` | ⚠️ Last resort only — forces HTTP to be treated as secure |

**Do not use `--use-fake-device-for-media-stream`** — this replaces the real
camera with a test pattern.

---

## 8. First Boot & Verification

### Auto-start X11 and kiosk on power-on

The recommended approach is to add the openbox session to `~/.xinitrc` and
launch it via `startx` on tty1 login.

Create `~/.xinitrc`:

```bash
#!/bin/bash
exec openbox-session
```

Make it executable:

```bash
chmod +x ~/.xinitrc
```

Add to `~/.bash_profile` (or `~/.profile`) for automatic start on tty1 login:

```bash
if [ -z "$DISPLAY" ] && [ "$(tty)" = "/dev/tty1" ]; then
    startx -- -nocursor 2>/dev/null &
fi
```

### Verification checklist

After reboot, check:

```bash
# Is Chromium running?
ps aux | grep chromium | grep -v grep

# Is it on the correct URL?
curl -s http://localhost:9222/json/list | python3 -c "import sys,json; print(json.load(sys.stdin)[0]['url'])"

# Is the camera accessible?
curl -s http://localhost:9222/json/list | python3 -c "
import sys,json,http.client,json
page = json.load(sys.stdin)[0]
import asyncio, websockets
"

# Quick CDP check (alternative)
ssh orangepi@192.168.50.16 "v4l2-ctl --list-devices"
```

### Full camera test via CDP

From your dev machine (requires SSH tunnel to port 9222):

```bash
ssh -L 9223:localhost:9222 -f -N orangepi@<ip>

# Run node test:
node -e '
const WebSocket = require("ws");
const http = require("http");
http.get("http://localhost:9223/json/list", (res) => {
  let data = "";
  res.on("data", c => data += c);
  res.on("end", () => {
    const page = JSON.parse(data)[0];
    const ws = new WebSocket(page.webSocketDebuggerUrl);
    ws.on("open", () => {
      ws.send(JSON.stringify({id:1,method:"Runtime.enable"}));
      setTimeout(() => {
        ws.send(JSON.stringify({id:2,method:"Runtime.evaluate",params:{expression:"(async () => { try { const s = await navigator.mediaDevices.getUserMedia({video:true}); s.getTracks().forEach(t=>t.stop()); return \\"OK:\\"+s.getVideoTracks()[0].label; } catch(e) { return \\"ERR:\\"+e.name; } })()",awaitPromise:true}}));
      }, 1000);
    });
    ws.on("message", d => { const m = JSON.parse(d.toString()); if(m.id===2) console.log(m.result.result.value); });
    setTimeout(() => process.exit(0), 8000);
  });
});
'
```

---

## 9. Remote Access (SSH + Debug)

### SSH into the Orange Pi

```bash
# From your dev machine
ssh orangepi@<orange-pi-ip>
```

**Key-based login** (set up initially):

```bash
ssh orangepi@<ip>
# On your dev machine:
ssh-copy-id orangepi@<ip>
# Or manually:
cat ~/.ssh/id_ed25519.pub | ssh orangepi@<ip> "tee -a ~/.ssh/authorized_keys"
```

### Remote Chromium DevTools

Forward the debug port:

```bash
ssh -L 9223:localhost:9222 -f -N orangepi@192.168.50.16
```

Then open `chrome://inspect` in your local Chrome → "Configure" → add
`localhost:9223`. Or use the remote debugger URL directly:

```bash
# Get the page list
curl -s http://localhost:9223/json/list | python3 -m json.tool

# Open in Chrome DevTools (paste the devtoolsFrontendUrl)
```

### Quick SSH One-liners

```bash
# Check Chromium URL
ssh orangepi@<ip> "curl -s http://localhost:9222/json/list | python3 -c 'import sys,json; print(json.load(sys.stdin)[0][\"url\"])'"

# Check camera
ssh orangepi@<ip> "v4l2-ctl --list-devices"

# Restart kiosk
ssh orangepi@<ip> "pkill chromium"

# Edit autostart
ssh orangepi@<ip> "nano ~/.config/openbox/autostart"

# Reboot
ssh orangepi@<ip> "sudo reboot"
```

---

## 10. Deploying Kiosk Pages

The kiosk frontend is deployed from `~/gitlab/creka-kiosk/` to a remote server:

```bash
cd ~/gitlab/creka-kiosk
bash deploy.sh
```

The deploy script:
1. Builds the Astro/Svelte site with `npm run build`
2. Copies files via SCP to `mindaadmin@208.87.132.15:~/creka/kiosk/public/`
3. Restarts the Docker container `creka-kiosk`

### Credentials

Credentials are stored in `.env` (gitignored). Template in `.env.example`:

```
DEPLOY_SERVER=208.87.132.15
DEPLOY_SSH_USER=mindaadmin
DEPLOY_SSH_KEY=~/.ssh/id_ed25519
DEPLOY_REMOTE_PATH=~/creka/kiosk/public/
DEPLOY_CONTAINER=creka-kiosk
```

---

## 11. Troubleshooting

### Camera not available

**Symptom:** Page shows "camera not available" or "make sure you are on HTTPS"
error.

**Checklist:**

1. **Profile cache** — Chromium may be loading a cached HTTP redirect:

   ```bash
   pkill chromium
   rm -rf ~/.config/chromium/Default/Sessions \
          ~/.config/chromium/Default/Current\ Session \
          ~/.config/chromium/Default/Last\ Session \
          ~/.config/chromium/Default/Preferences \
          ~/.config/chromium/Default/History
   # Wait for autostart to relaunch (~5s)
   ```

   This is the most common fix after OS updates or Chrome version bumps.

2. **Verify the URL has trailing slash:**

   ```bash
   curl -s http://localhost:9222/json/list | python3 -c \
     "import sys,json; print(json.load(sys.stdin)[0]['url'])"
   ```
   Should start with `https://`.

3. **Check secure context in CDP:**

   ```bash
   node -e '
   const http=require("http"),WebSocket=require("ws");
   http.get("http://localhost:9222/json/list",r=>{let d="";r.on("data",c=>d+=c);r.on("end",()=>{
   const p=JSON.parse(d)[0],ws=new WebSocket(p.webSocketDebuggerUrl);
   ws.on("open",()=>{ws.send(JSON.stringify({id:1,method:"Runtime.enable"}))});
   setTimeout(()=>{ws.send(JSON.stringify({id:2,method:"Runtime.evaluate",
     params:{expression:"window.isSecureContext&&!!navigator.mediaDevices"}}))},500);
   ws.on("message",d=>{const m=JSON.parse(d.toString());if(m.id===2)console.log(m.result?.result?.value)})})})
   '
   ```

   Should print `true`.

4. **Verify device:**

   ```
   $ ls -la /dev/video*
   crw-rw---- 1 root video 81, 0 ... /dev/video0
   ```

   The user (`orangepi`) must be in the `video` group.

5. **Run a camera test directly:**

   ```bash
   # From the Orange Pi
   v4l2-ctl --list-devices
   # Should show your USB camera
   ```

### HTTPS redirects to HTTP

If the Chromium starts with `https://` but ends up on `http://`:

```bash
# 1. Clear cache (see above)
# 2. Verify the URL has trailing slash in autostart
# 3. Try a fresh profile:
pkill chromium
chromium --user-data-dir=/tmp/chromium-test \
  --kiosk "https://kiosk.creka.online/admin/step_test/" &
```

If the fresh profile works, the old profile had corrupted state — clear it.

### Chromium not starting

```bash
# Check X11 display
echo $DISPLAY
# Should be :0

# Launch manually with error output
export DISPLAY=:0
chromium --kiosk "https://kiosk.creka.online/" 2>&1

# Check logs
journalctl -xe | grep chromium
```

### WiFi connection drops

```bash
# Check interface
ip addr show wlan0

# Restart networking
sudo systemctl restart networking
# or
sudo ifconfig wlan0 down && sudo ifconfig wlan0 up
```

### Cannot SSH

```bash
# Check if SSH is running
sudo systemctl status ssh

# Enable SSH
sudo systemctl enable ssh
sudo systemctl start ssh

# Find IP address
ip addr show | grep inet
```

### After OS upgrade, camera stopped working

`apt upgrade` can update Chromium to a new major version, which may:
- Change how `--use-fake-ui-for-media-stream` is handled
- Introduce different permission requirements
- Reset profile state causing redirect cache issues

**Fix:** Follow the [Profile cache](#1-profile-cache) steps above.

---

## Appendix: File Reference

| Path | Purpose |
|---|---|
| `~/.config/openbox/autostart` | Kiosk autostart script (main config) |
| `~/.xinitrc` | X11 session launcher |
| `~/.bash_profile` | Auto-login X11 on tty1 |
| `~/.ssh/authorized_keys` | SSH key-based login |
| `~/.config/chromium/Default/` | Chromium user profile |
| `~/gitlab/creka-kiosk/` | Kiosk frontend source code |
| `~/gitlab/creka-kiosk/deploy.sh` | Deploy to production server |

---

## Appendix: CDP Quick Commands

### Navigate the kiosk page remotely

```bash
PAGE_ID=$(curl -s http://localhost:9223/json/list | python3 -c "import sys,json; print(json.load(sys.stdin)[0]['id'])")
WS_URL=$(curl -s http://localhost:9223/json/list | python3 -c "import sys,json; print(json.load(sys.stdin)[0]['webSocketDebuggerUrl'])")

node -e "
const WebSocket = require('ws');
const ws = new WebSocket('$WS_URL');
ws.on('open', () => ws.send(JSON.stringify({id:1,method:'Page.navigate',params:{url:'https://kiosk.creka.online/admin/finger_puppet_v2/'}})));
ws.on('message', d => { const m = JSON.parse(d.toString()); if(m.method === 'Page.frameNavigated') console.log('Navigated:', m.params.frame.url); });
setTimeout(() => process.exit(0), 5000);
"
```

### Check page state

```bash
node -e '
const http=require("http"),WebSocket=require("ws");
http.get("http://localhost:9222/json/list",r=>{let d="";r.on("data",c=>d+=c);r.on("end",()=>{
const p=JSON.parse(d)[0],ws=new WebSocket(p.webSocketDebuggerUrl);
ws.on("open",()=>{ws.send(JSON.stringify({id:1,method:"Runtime.enable"}))});
setTimeout(()=>{ws.send(JSON.stringify({id:2,method:"Runtime.evaluate",
 params:{expression:"JSON.stringify({url:location.href,secure:window.isSecureContext,md:!!navigator.mediaDevices})"}}))},500);
ws.on("message",d=>{const m=JSON.parse(d.toString());if(m.id===2)console.log(m.result?.result?.value)})})})
'
```
