#!/usr/bin/env python3
"""WS2812 strip on the Pi's SPI MOSI pin, switched by the kiosk page over localhost.
GET /on lights it, GET /off clears it; it also clears itself 120 s after the last /on
(the page re-sends /on every 60 s while awake), so a crashed page can't leave it lit.
Needs `pip install spidev` and SPI enabled (orangepi-config -> Hardware). Config: LED_COUNT, LED_COLOR (RRGGBB), LED_BRIGHT (0-1), LED_SPI (bus,dev)."""
import os, threading
from http.server import BaseHTTPRequestHandler, HTTPServer
import spidev

N = int(os.environ.get("LED_COUNT", 30))
BRIGHT = float(os.environ.get("LED_BRIGHT", 0.5))
RGB = [int(int(os.environ.get("LED_COLOR", "FFFFFF")[i:i + 2], 16) * BRIGHT) for i in (0, 2, 4)]
bus, dev = map(int, os.environ.get("LED_SPI", "1,0").split(","))
spi = spidev.SpiDev(); spi.open(bus, dev); spi.max_speed_hz = 2_400_000  # 3 SPI bits per WS2812 bit

def frame(rgb):
    bits = "".join(f"{b:08b}" for b in (rgb[1], rgb[0], rgb[2]) * N)  # GRB order
    bits = "".join("110" if c == "1" else "100" for c in bits) + "0" * 240  # trailing zeros = reset
    return [int(bits[i:i + 8], 2) for i in range(0, len(bits), 8)]

ON, OFF = frame(RGB), frame((0, 0, 0))
timer = None

def show(on):
    global timer
    if timer: timer.cancel()
    spi.writebytes2(ON if on else OFF)
    if on: timer = threading.Timer(120, show, (False,)); timer.start()

class H(BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path in ("/on", "/off"): show(self.path == "/on")
        self.send_response(204); self.end_headers()
    def log_message(self, *a): pass

show(False)
HTTPServer(("127.0.0.1", 8765), H).serve_forever()
