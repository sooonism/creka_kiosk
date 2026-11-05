#!/usr/bin/env python3
"""Tiny wifi setup form, served on the fallback hotspot (http://10.42.0.1). Run as root by wifi-fallback.sh.
Saves a NetworkManager profile (autoconnect, priority 20) and exits; the caller then tears the hotspot down."""
import html, subprocess, sys, urllib.parse
from http.server import BaseHTTPRequestHandler, HTTPServer

def ssids():
    try:
        return [s for s in open('/run/wifi-fallback.ssids').read().splitlines() if s]
    except OSError:
        return []

def page(msg=''):
    opts = ''.join(f'<option>{html.escape(s)}</option>' for s in ssids())
    return f'''<!doctype html><meta name=viewport content="width=device-width,initial-scale=1">
<title>Kiosk wifi</title><body style="font:18px sans-serif;max-width:26em;margin:1em auto;padding:0 1em">
<h2>Kiosk wifi setup</h2><p style="color:#b00">{html.escape(msg)}</p>
<form method=post action=/connect>
<p>Network<br><select name=ssid style="width:100%;font-size:inherit">{opts}</select></p>
<p>or type the name<br><input name=other style="width:100%;font-size:inherit"></p>
<p>Password<br><input name=psk type=password style="width:100%;font-size:inherit"></p>
<button style="font-size:inherit;padding:.4em 1em">Save and connect</button></form>'''

class H(BaseHTTPRequestHandler):
    def send(self, body, code=200):
        b = body.encode()
        self.send_response(code)
        self.send_header('Content-Type', 'text/html; charset=utf-8')
        self.send_header('Content-Length', str(len(b)))
        self.end_headers()
        self.wfile.write(b)

    def do_GET(self):  # any path, so phones' captive-portal probes land on the form
        self.send(page())

    def do_POST(self):
        f = urllib.parse.parse_qs(self.rfile.read(int(self.headers.get('Content-Length', 0))).decode())
        ssid = (f.get('other', [''])[0] or f.get('ssid', [''])[0]).strip()
        psk = f.get('psk', [''])[0]
        if not ssid or (psk and not 8 <= len(psk) <= 63):
            return self.send(page('Pick a network and enter its password (8-63 characters).'))
        name = 'site-' + ssid
        subprocess.run(['nmcli', 'con', 'delete', name], capture_output=True)
        cmd = ['nmcli', 'con', 'add', 'type', 'wifi', 'ifname', 'wlan0', 'con-name', name, 'ssid', ssid,
               'connection.autoconnect', 'yes', 'connection.autoconnect-priority', '20']
        if psk:
            cmd += ['wifi-sec.key-mgmt', 'wpa-psk', 'wifi-sec.psk', psk]
        if subprocess.run(cmd, capture_output=True).returncode:
            return self.send(page('Could not save that network.'))
        self.send('<meta name=viewport content="width=device-width"><body style="font:18px sans-serif;margin:1em">'
                  f'<h2>Saved</h2><p>The kiosk is now joining <b>{html.escape(ssid)}</b>. This setup network will '
                  'disappear. If it comes back in a few minutes, the password was wrong: connect and try again.')
        self.wfile.flush()
        sys.exit(0)  # ends the server; wifi-fallback.sh switches back to client mode

    def log_message(self, fmt, *a):
        open('/run/wifi-setup.log', 'a').write(fmt % a + '\n')

HTTPServer(('0.0.0.0', 80), H).serve_forever()
