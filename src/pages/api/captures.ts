export const prerender = false;

import type { APIRoute } from 'astro';
import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';

const CAPTURES_DIR = path.join(process.cwd(), 'public', 'captures', 'demo', 'camwithnkob');

// ids of saved captures, newest first
export const GET: APIRoute = async () => {
  const names = (await readdir(CAPTURES_DIR).catch(() => [])).filter((n) => n.endsWith('.png'));
  const withTime = await Promise.all(
    names.map(async (n) => ({ id: n.slice(0, -4), t: (await stat(path.join(CAPTURES_DIR, n))).mtimeMs }))
  );
  const ids = withTime.sort((a, b) => b.t - a.t).map((f) => f.id);
  return new Response(JSON.stringify(ids), { headers: { 'Content-Type': 'application/json' } });
};
