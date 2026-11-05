export const prerender = false;

import type { APIRoute } from 'astro';
import { ADMIN_COOKIE, backend, beats, capturesDir, listPngs, readKiosks, validId, type Kiosk } from '../../lib/kiosks';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

// registry is creka_backend's; this adapts it for the dashboard (+ live heartbeat, local capture count).
// 401/403 from the backend (no/non-admin token) is passed through so the dashboard shows the OTP login.
export const GET: APIRoute = async ({ cookies }) => {
  const { status, list } = await readKiosks(cookies.get(ADMIN_COOKIE)?.value ?? '');
  if (status !== 200) return json({ error: status === 502 ? 'creka_backend unreachable' : 'admin login required' }, status);
  return json(await Promise.all(list.map(async (k) => ({ ...k, beat: beats.get(k.id), captures: (await listPngs(capturesDir(k.id))).length }))));
};

const forward = async (res: Response) => json(await res.json().catch(() => ({})), res.status);

export const POST: APIRoute = async ({ request, cookies }) => {
  const k: Kiosk = await request.json();
  if (!validId(k.id)) return json({ error: 'id must be a-z, 0-9, - (max 40)' }, 400);
  const { id, name, location, module, mode, hw, notes } = k;
  return forward(await backend(`/kiosks/${id}`, { method: 'PUT', body: JSON.stringify({ name, location, module, mode, hw, notes }) }, cookies.get(ADMIN_COOKIE)?.value));
};

export const DELETE: APIRoute = async ({ cookies, url }) => {
  const id = url.searchParams.get('id');
  if (!validId(id)) return json({ error: 'bad id' }, 400);
  return forward(await backend(`/kiosks/${id}`, { method: 'DELETE' }, cookies.get(ADMIN_COOKIE)?.value));
};
