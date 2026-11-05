export const prerender = false;

import type { APIRoute } from 'astro';
import { ADMIN_COOKIE, readKiosks, validId } from '../../lib/kiosks';
import { send } from '../../lib/kioskCmd';

// dashboard side: run a command on a kiosk and wait for its reply. Admin only (same check as /api/kiosks).
export const POST: APIRoute = async ({ request, cookies }) => {
  const { id, type } = await request.json().catch(() => ({}));
  if (!validId(id) || (type !== 'ping' && type !== 'snap')) return new Response('bad request', { status: 400 });
  const { status } = await readKiosks(cookies.get(ADMIN_COOKIE)?.value ?? '');
  if (status !== 200) return new Response('admin login required', { status });
  const t = Date.now();
  const r = await send(id, type);
  return new Response(JSON.stringify({ ...r, ms: Date.now() - t }), { headers: { 'Content-Type': 'application/json' } });
};
