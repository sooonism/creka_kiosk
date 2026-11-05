import { Socket, type Channel } from 'phoenix';

// creka_backend Phoenix channel `kiosk:<id>`; the phoenix client reconnects and rejoins on its own.
// Override per environment with PUBLIC_KIOSK_WS (local backend: ws://localhost:4000/socket).
const WS_URL = import.meta.env.PUBLIC_KIOSK_WS ?? 'wss://creka.online/socket';

export function openKioskLink(role: 'kiosk' | 'remote', id: string, opts: { key?: string; onJoin?: (resp: any) => void; onRefused?: () => void } = {}) {
  // ?ws=ws://host:4000/socket points a kiosk/remote pair at another backend (debugging against a local one)
  const socket = new Socket(new URLSearchParams(location.search).get('ws') ?? WS_URL);
  socket.connect();
  const channel: Channel = socket.channel(`kiosk:${id}`, { role, key: opts.key });
  channel.join().receive('ok', (resp) => opts.onJoin?.(resp)).receive('error', (e) => {
      console.warn('kiosk link refused', e);
      opts.onRefused?.();
    });
  return { channel, close: () => socket.disconnect() };
}

// Malaysia has no DST: fixed +8h gives the local calendar day the backend also uses
export const dayMYT = (ms = Date.now()) => new Date(ms + 8 * 3600_000).toISOString().slice(0, 10);
export const hourMYT = (ms = Date.now()) => new Date(ms + 8 * 3600_000).getUTCHours();
