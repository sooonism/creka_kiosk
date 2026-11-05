export const prerender = false;

import type { APIRoute } from 'astro';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { capturesDir, listPngs, validId } from '../../lib/kiosks';

// ids of saved captures, newest first; ?kiosk=<id> reads that kiosk's folder
export const GET: APIRoute = async ({ url }) => {
  const kiosk = url.searchParams.get('kiosk');
  if (kiosk && !validId(kiosk)) return new Response('Bad kiosk id', { status: 400 });
  const dir = capturesDir(kiosk);
  const withTime = await Promise.all(
    (await listPngs(dir)).map(async (n) => ({ id: n.slice(0, -4), t: (await stat(path.join(dir, n))).mtimeMs }))
  );
  const ids = withTime.sort((a, b) => b.t - a.t).map((f) => f.id);
  return new Response(JSON.stringify(ids), { headers: { 'Content-Type': 'application/json' } });
};
