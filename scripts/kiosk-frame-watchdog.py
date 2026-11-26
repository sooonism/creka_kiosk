#!/usr/bin/env python3
"""Restart a kiosk's Chromium page when it stops drawing frames.

Seen on the Orange Pi Zero 3W (software GL): after minutes to hours the page keeps running its JS but Chromium stops
producing frames (requestAnimationFrame never fires), so the screen freezes or goes white. A reload fixes it.

Every CHECK_S seconds: count requestAnimationFrame callbacks over 2 s through Chromium's debug port (9222). After STRIKES
bad checks in a row: reload the last good URL; if it is still bad after another STRIKES: kill Chromium (the openbox
autostart loop relaunches it) and reopen the last good URL. Stdlib only (the Pi has python3 but no websocket module).

Run: python3 kiosk-frame-watchdog.py            (loop)       python3 kiosk-frame-watchdog.py --hard-now   (test the restart path)
"""
import base64, json, os, socket, struct, subprocess, sys, time, urllib.request

PORT = 9222
CHECK_S = int(os.environ.get('CHECK_S', 20))
STRIKES = int(os.environ.get('STRIKES', 3))
MIN_FPS = 5
# a real click (Input.dispatch*), so a wall's "Start" button counts as a user gesture and video sound can play
CLICK_JS = "(()=>{const b=document.querySelector('.lw-start');if(!b)return null;const r=b.getBoundingClientRect();return [r.x+r.width/2,r.y+r.height/2]})()"
FRAMES_JS = "new Promise(r=>{let n=0;const t=performance.now();(function f(){n++;performance.now()-t<2000?requestAnimationFrame(f):r(n/2)})()})"


def log(*a):
    print(time.strftime('%H:%M:%S'), *a, flush=True)


def page_target():
    tabs = json.load(urllib.request.urlopen(f'http://127.0.0.1:{PORT}/json', timeout=5))
    return next(t for t in tabs if t['type'] == 'page')


class WS:
    def __init__(self, url):
        host, rest = url[5:].split('/', 1)
        h, p = host.split(':')
        self.s = socket.create_connection((h, int(p)), timeout=5)
        key = base64.b64encode(os.urandom(16)).decode()
        self.s.sendall(f'GET /{rest} HTTP/1.1\r\nHost: {host}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: {key}\r\nSec-WebSocket-Version: 13\r\n\r\n'.encode())
        buf = b''
        while b'\r\n\r\n' not in buf:
            buf += self.s.recv(1024)
        if b' 101 ' not in buf.split(b'\r\n')[0]:
            raise RuntimeError('websocket handshake failed')
        self.n = 0

    def _read(self, n):
        b = b''
        while len(b) < n:
            c = self.s.recv(n - len(b))
            if not c:
                raise ConnectionError('closed')
            b += c
        return b

    def _send(self, text):
        d = text.encode()
        m = os.urandom(4)
        head = b'\x81' + (bytes([0x80 | len(d)]) if len(d) < 126 else b'\xfe' + struct.pack('>H', len(d)))
        self.s.sendall(head + m + bytes(c ^ m[i % 4] for i, c in enumerate(d)))

    def _recv(self):
        msg = b''
        while True:
            b0, b1 = self._read(2)
            n = b1 & 0x7F
            if n == 126:
                n = struct.unpack('>H', self._read(2))[0]
            elif n == 127:
                n = struct.unpack('>Q', self._read(8))[0]
            data = self._read(n)
            if b0 & 0x0F == 8:
                raise ConnectionError('closed')
            if b0 & 0x0F in (1, 0):
                msg += data
                if b0 & 0x80:
                    return msg.decode()

    def call(self, method, params=None, timeout=8):
        self.n += 1
        self._send(json.dumps({'id': self.n, 'method': method, 'params': params or {}}))
        end = time.time() + timeout
        while True:
            self.s.settimeout(max(0.1, end - time.time()))
            m = json.loads(self._recv())
            if m.get('id') == self.n:
                return m.get('result', {})

    def close(self):
        self.s.close()


def fps():
    """Frames per second the page really draws, or None if it can't be measured (stuck, or no page)."""
    try:
        ws = WS(page_target()['webSocketDebuggerUrl'])
        try:
            return ws.call('Runtime.evaluate', {'expression': FRAMES_JS, 'awaitPromise': True}, timeout=8)['result']['value']
        finally:
            ws.close()
    except Exception:
        return None


def open_url(url, wait=8):
    ws = WS(page_target()['webSocketDebuggerUrl'])
    try:
        ws.call('Page.navigate', {'url': url})
        time.sleep(wait)
        xy = ws.call('Runtime.evaluate', {'expression': CLICK_JS, 'returnByValue': True}).get('result', {}).get('value')
        if xy:
            for t in ('mousePressed', 'mouseReleased'):
                ws.call('Input.dispatchMouseEvent', {'type': t, 'x': xy[0], 'y': xy[1], 'button': 'left', 'clickCount': 1})
    finally:
        ws.close()


def hard_restart(url):
    log('killing chromium')
    subprocess.run(['pkill', '-x', 'chromium'])
    for _ in range(45):  # the autostart loop relaunches it
        time.sleep(2)
        try:
            page_target()
            break
        except Exception:
            pass
    if url:
        time.sleep(5)
        try:
            open_url(url)
        except Exception as e:
            log('reopen failed', e)


def main():
    last_url, bad, soft_done = None, 0, False
    while True:
        time.sleep(CHECK_S)
        f = fps()
        if f is not None and f >= MIN_FPS:
            if bad:
                log(f'recovered ({f:.0f} fps)')
            bad, soft_done = 0, False
            try:
                u = page_target()['url']
                if u.startswith('http'):
                    last_url = u
            except Exception:
                pass
            continue
        bad += 1
        log(f'no frames ({f}), strike {bad}/{STRIKES}, soft_done={soft_done}')
        if bad < STRIKES:
            continue
        bad = 0
        if not soft_done and last_url:
            log('reloading', last_url)
            soft_done = True
            try:
                open_url(last_url)
            except Exception as e:
                log('reload failed', e)
        else:
            hard_restart(last_url)
            soft_done = False


if __name__ == '__main__':
    if '--hard-now' in sys.argv:
        u = page_target()['url']
        hard_restart(u if u.startswith('http') else None)
    else:
        main()
