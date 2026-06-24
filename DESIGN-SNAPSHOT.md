# Creka Kiosk — Design Snapshot (2026-06-22)

> **Status**: KIV — design direction captured but uncommitted. Plan may change.

## Hardware
- **SBC**: OrangePi Zero3W 4GB, DietPi OS
- **Camera**: ESP32-CAM (human detection + capture)
- **Display**: Vertical screen connected to SBC (HDMI/DSI), **no touchscreen**
- **Network**: WiFi, always online

## User Flow
1. **Idle**: slideshow/video plays on screen
2. **Detection**: ESP32-CAM detects human nearby → triggers
3. **Selfie**: Cartoon character IP appears on screen, takes selfie with human
4. **QR**: Dynamic QR code displayed — human scans with phone
5. **Delivery**: Phone opens URL → gets the selfie images

## Software Architecture (preferred direction — KIV)
- **SBC**: Light Rust HTTP server (Axum) + SSE for state push — orchestrator daemon
- **Frontend**: Vanilla JS modules (slideshow, selfie-app, qr-display, sse-client) — output-only display
- **ESP32**: MJPEG stream directly to browser; HTTP POST for detection events + capture
- **Image compositing**: Local on SBC (Rust `image` crate or ImageMagick)
- **Cloud**: API server + Media server (HTTP, no WebSocket relay needed for now)
- **Future integration**: Event/boundary design for Creka campaign/voucher system deferred

## Key Design Decision (proposed)
- **Rust HTTP + SSE** instead of WebSocket on SBC (simpler, more stable, minimal code)
- **No browser orchestrator** — Rust daemon is single source of truth
- **ESP32 is autonomous** — just sends HTTP POSTs, doesn't care about browser state

## Open Questions (to resolve later)
- Image compositing location (SBC vs Cloud)
- ESP32-CAM detection method (PIR / motion detection / ML)
- Cloud backend tech stack
- Repo structure (mono vs multi-repo)
- Phone gallery page tech stack
