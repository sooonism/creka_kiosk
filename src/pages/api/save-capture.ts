export const prerender = false;

import type { APIRoute } from 'astro';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const CAPTURES_DIR = path.join(process.cwd(), 'public', 'captures', 'demo', 'camwithnkob');

export const POST: APIRoute = async ({ request }) => {
  const { image } = await request.json();
  const match = typeof image === 'string' && image.match(/^data:image\/png;base64,(.+)$/);
  if (!match) {
    return new Response(JSON.stringify({ error: 'Expected a data:image/png;base64 URL' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  await mkdir(CAPTURES_DIR, { recursive: true });
  const id = crypto.randomUUID();
  await writeFile(path.join(CAPTURES_DIR, `${id}.png`), Buffer.from(match[1], 'base64'));

  return new Response(JSON.stringify({ id }), {
    headers: { 'Content-Type': 'application/json' },
  });
};
