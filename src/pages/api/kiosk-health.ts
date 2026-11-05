export const prerender = false;

import type { APIRoute } from 'astro';
import { ADMIN_COOKIE, backend, validId } from '../../lib/kiosks';

// last 14 daily Pi health rows for the dashboard strip (admin token passed through)
export const GET: APIRoute = async ({ cookies, url }) => {
  const id = url.searchParams.get('id');
  if (!validId(id)) return new Response('[]', { status: 400 });
  const res = await backend(`/kiosks/${id}/health?days=14`, {}, cookies.get(ADMIN_COOKIE)?.value).catch(() => null);
  return new Response(res ? await res.text() : '[]', { status: res?.status ?? 502, headers: { 'Content-Type': 'application/json' } });
};
