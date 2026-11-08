export const prerender = false;

import type { APIRoute } from 'astro';
import { backend, validId } from '../../lib/kiosks';

// visitor taps on the photo page (open / whatsapp / instagram / save / profile, with source qr|wa for where the visitor came from). Relayed to creka_backend, which tags the
// kiosk's location; same-origin so the phone needs no CORS. Best effort: tracking never breaks the page.
export const POST: APIRoute = async ({ url, request }) => {
  const kiosk = url.searchParams.get('kiosk');
  if (!validId(kiosk)) return new Response('Bad kiosk id', { status: 400 });
  const { type, photo, source } = await request.json().catch(() => ({}));
  await backend(`/kiosks/${kiosk}/events`, { method: 'POST', body: JSON.stringify({ type, photo, source }) }).catch(() => {});
  return new Response('ok');
};
