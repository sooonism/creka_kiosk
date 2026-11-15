import type { APIRoute } from 'astro';
import { BACKEND } from '../../../lib/kiosks';

export const prerender = false;

// Browser → here → creka_backend (it has no CORS). Only the lovewall endpoints and the organiser OTP login are relayed;
// the organiser token travels in x-organiser-token, uploads stream through untouched.
const AUTH: Record<string, string> = {
  'auth/request': '/api/v1/campaigns/organiser/otp/request',
  'auth/verify': '/api/v1/campaigns/organiser/otp/verify',
};
const LOVEWALL = /^[\w-]+\/(wall|queue|settings|logo|messages(\/\d+|\/bulk)?)$/;

export const ALL: APIRoute = async ({ request, params, url }) => {
  const path = params.path ?? '';
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
