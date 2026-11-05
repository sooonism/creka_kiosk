import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';

export interface Kiosk {
  id: string;
  name: string;
  location: string;
  module: string;
  hw: { board: string; cpu: string; ram: string; monitor: string; camera: string; os: string; flags: string[] };
  notes: string;
  lastSeen: number;
  captures?: number;
  health?: Record<string, any> | null; // latest daily Pi health row from creka_backend
}

// prod sets CAPTURES_DIR to a folder the node server also serves statically (dist/client/captures/...)
export const CAPTURES_ROOT = process.env.CAPTURES_DIR ?? path.join(process.cwd(), 'public', 'captures', 'demo', 'camwithnkob');

export const validId = (id: unknown): id is string => typeof id === 'string' && /^[a-z0-9-]{1,40}$/.test(id);

// no id → legacy shared folder
export const capturesDir = (kiosk?: string | null) => (kiosk ? path.join(CAPTURES_ROOT, kiosk) : CAPTURES_ROOT);

// registry lives in creka_backend (CrekaCampaignRepo). Dashboard calls carry the admin's Creka API token
// (from the OTP login cookie); the backend enforces admin, kiosk-side calls need none.
export const BACKEND = process.env.BACKEND_URL ?? 'https://creka.online';
export const ADMIN_COOKIE = 'creka_admin';

export const backend = (route: string, init: RequestInit = {}, token = '') =>
  fetch(`${BACKEND}${route.startsWith('/api/') ? '' : '/api/v1/photobooth'}${route}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(token && { Authorization: `Bearer ${token}` }), ...init.headers },
  });

const toKiosk = (k: any): Kiosk => ({
  id: k.id, name: k.name, location: k.location, module: k.module, notes: k.notes,
  hw: { board: '', cpu: '', ram: '', monitor: '', camera: '', os: '', flags: [], ...k.hw },
  lastSeen: k.last_seen ? Date.parse(k.last_seen) : 0,
  captures: k.captures,
  health: k.health,
});

// null = backend said no (401/403 → not an admin session) or is unreachable
export async function readKiosks(token: string): Promise<{ status: number; list: Kiosk[] }> {
  const res = await backend('/kiosks', {}, token).catch(() => null);
  return { status: res?.status ?? 502, list: res?.ok ? (await res.json()).map(toKiosk) : [] };
}

export const touchKiosk = (id: string) => backend(`/kiosks/${id}/touch`, { method: 'POST' }).catch(() => {});

export const DATE_DIR = /^\d{4}-\d{2}-\d{2}$/;

// pngs directly in dir (legacy flat) plus those in its YYYY-MM-DD subfolders, as 'name.png' / 'date/name.png'
export async function listPngs(dir: string): Promise<string[]> {
  const entries = await readdir(dir).catch(() => [] as string[]);
  const nested = await Promise.all(
    entries.filter((n) => DATE_DIR.test(n)).map(async (d) => (await readdir(path.join(dir, d)).catch(() => [])).filter((n) => n.endsWith('.png')).map((n) => `${d}/${n}`))
  );
  return [...entries.filter((n) => n.endsWith('.png')), ...nested.flat()];
}


// live heartbeats, in memory only (kiosks re-beat within 20s after a server restart)
export const beats = new Map<string, { t: number; page: string; w: number; h: number }>();

export const LIMIT_BYTES = Number(process.env.CAPTURES_LIMIT_MB ?? 1024) * 1024 * 1024;

// total bytes under dir, recursive
export async function dirSize(dir: string): Promise<number> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  const sizes = await Promise.all(
    entries.map((e) => (e.isDirectory() ? dirSize(path.join(dir, e.name)) : stat(path.join(dir, e.name)).then((s) => s.size).catch(() => 0)))
  );
  return sizes.reduce((a, b) => a + b, 0);
}
