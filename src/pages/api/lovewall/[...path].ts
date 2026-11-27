import type { APIRoute } from 'astro';
import { BACKEND } from '../../../lib/kiosks';
import { LOCAL, post, wall } from '../../../lib/lovewall-local';

export const prerender = false;

// Browser → here → creka_backend (it has no CORS). Only the lovewall endpoints and the organiser OTP login are relayed;
// the organiser token travels in x-organiser-token, uploads stream through untouched.
const AUTH: Record<string, string> = {
  'auth/request': '/api/v1/campaigns/organiser/otp/request',
  'auth/verify': '/api/v1/campaigns/organiser/otp/verify',
};
const LOVEWALL = /^[\w-]+\/(wall(\/state)?|queue|settings|logo|messages(\/\d+|\/bulk)?)$/;

// a hardcoded slug uses the local stand-in until creka_backend has a campaign for it (checked at most every 30 s)
const known = new Map<string, { at: number; backend: boolean }>();
async function useLocal(slug: string) {
  if (!LOCAL[slug]) return false;
  const c = known.get(slug);
  if (c && Date.now() - c.at < 30_000) return !c.backend;
  const backend = await fetch(`${BACKEND}/api/v1/lovewall/${slug}/wall`).then((r) => r.ok).catch(() => false);
  known.set(slug, { at: Date.now(), backend });
  return !backend;
}

export const ALL: APIRoute = async ({ request, params, url }) => {
  const path = params.path ?? '';
  const [slug, route] = path.split('/');
  if (await useLocal(slug)) {
    if (route === 'wall' && request.method === 'GET') return Response.json(await wall(slug), { headers: { 'Cache-Control': 'no-store' } });
    if (path === `${slug}/wall/state`) return Response.json({ status: 1 });
    if (path === `${slug}/messages` && request.method === 'POST') return post(slug, await request.formData());
    return Response.json({ status: 0, message: 'Not available for this event' }, { status: 404 });
  }
  const target = AUTH[path] ?? (LOVEWALL.test(path) ? `/api/v1/lovewall/${path}` : null);
  if (!target) return new Response('Not found', { status: 404 });

  const headers: Record<string, string> = {};
  for (const h of ['content-type', 'x-organiser-token']) {
    const v = request.headers.get(h);
    if (v) headers[h] = v;
  }
  const hasBody = request.method !== 'GET' && request.method !== 'HEAD';
  const res = await fetch(BACKEND + target + url.search, {
    method: request.method,
    headers,
    body: hasBody ? request.body : undefined,
    // node's fetch needs this to stream a request body
    ...({ duplex: 'half' } as object),
  }).catch(() => null);

  if (!res) return Response.json({ status: 0, message: 'Backend unreachable' }, { status: 502 });
  return new Response(res.body, {
    status: res.status,
    headers: { 'Content-Type': res.headers.get('content-type') ?? 'application/json', 'Cache-Control': 'no-store' },
  });
};
