export const prerender = false;

import type { APIRoute } from 'astro';
import { stat, unlink } from 'node:fs/promises';
import path from 'node:path';
import { ADMIN_COOKIE, capturesDir, listPngs, readKiosks, validId } from '../../lib/kiosks';

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

// dashboard "×": delete one capture of a kiosk (admin only). Only this server's copy; creka_backend keeps its own.
export const DELETE: APIRoute = async ({ url, cookies }) => {
  const kiosk = url.searchParams.get('kiosk');
  const id = url.searchParams.get('id') ?? '';
  if (!validId(kiosk) || !/^(\d{4}-\d{2}-\d{2}\/)?[\w-]+$/.test(id)) return new Response('bad request', { status: 400 });
  const { status } = await readKiosks(cookies.get(ADMIN_COOKIE)?.value ?? '');
  if (status !== 200) return new Response('admin login required', { status });
  await unlink(path.join(capturesDir(kiosk), `${id}.png`)).catch(() => {});
  return new Response('ok');
};
