export const prerender = false;

import type { APIRoute } from 'astro';
import { validId } from '../../lib/kiosks';
import { next, reply } from '../../lib/kioskCmd';

// kiosk side (no login, like /api/heartbeat): GET = long-poll for the next command, POST = its reply
export const GET: APIRoute = async ({ url, request }) => {
  const id = url.searchParams.get('kiosk');
  if (!validId(id)) return new Response('Bad kiosk id', { status: 400 });
  const cmd = await next(id, request.signal);
  return cmd ? new Response(JSON.stringify(cmd), { headers: { 'Content-Type': 'application/json' } }) : new Response(null, { status: 204 });
};

export const POST: APIRoute = async ({ request }) => {
  const { n, ...r } = await request.json().catch(() => ({}));
  if (typeof n === 'number') reply(n, r);
  return new Response('ok');
};
