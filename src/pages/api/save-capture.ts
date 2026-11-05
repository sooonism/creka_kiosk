export const prerender = false;

import type { APIRoute } from 'astro';
import { appendFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { CAPTURES_ROOT, backend, capturesDir, validId } from '../../lib/kiosks';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

export const POST: APIRoute = async ({ request, url }) => {
  const kiosk = url.searchParams.get('kiosk');
  if (kiosk && !validId(kiosk)) return json({ error: 'Bad kiosk id' }, 400);

  const { image, meta } = await request.json();
  const match = typeof image === 'string' && image.match(/^data:image\/png;base64,(.+)$/);
  if (!match) return json({ error: 'Expected a data:image/png;base64 URL' }, 400);

  // <kiosk>/<YYYY-MM-DD>/<uuid>.png; the id is '<date>/<uuid>' so every consumer's `${kioskDir}${id}.png` still resolves
  const date = new Date().toLocaleDateString('sv', { timeZone: 'Asia/Kuala_Lumpur' });
  const dir = path.join(capturesDir(kiosk), date);
  await mkdir(dir, { recursive: true });
  const id = `${date}/${crypto.randomUUID()}`;
  await writeFile(path.join(CAPTURES_ROOT, kiosk ?? '', `${id}.png`), Buffer.from(match[1], 'base64'));
  // one json line per photo; lives in the persisted captures mount (so it is also served statically)
  await appendFile(path.join(CAPTURES_ROOT, 'index.jsonl'), JSON.stringify({ id, kiosk, ts: Date.now(), meta }) + '\n');
  // creka_backend keeps the registry/log: it stores its own copy and logs the link. Best effort, never fails the capture.
  // ponytail: dual-write while the photo page/QR still read the local copy; drop the local file once they use the backend link
  if (kiosk) await backend(`/kiosks/${kiosk}/captures`, { method: 'POST', body: JSON.stringify({ image, meta }) }).catch(() => {});

  return json({ id });
};
