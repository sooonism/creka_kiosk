export const prerender = false;

import type { APIRoute } from 'astro';
import { beats, validId } from '../../lib/kiosks';

export const POST: APIRoute = async ({ request, url }) => {
  const id = url.searchParams.get('kiosk');
  if (!validId(id)) return new Response('Bad kiosk id', { status: 400 });
  const b = await request.json().catch(() => ({}));
  beats.set(id, { t: Date.now(), page: String(b.page ?? '').slice(0, 200), w: Number(b.w) || 0, h: Number(b.h) || 0 });
  return new Response('ok');
};
