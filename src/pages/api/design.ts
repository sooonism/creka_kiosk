export const prerender = false;

import type { APIRoute } from 'astro';
import { unlink, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { DESIGNER_COOKIE, DESIGN_DIR, DESIGN_URL, readDesign, sessionEmail, writeDesign } from '../../lib/designer';
import { DEFAULT_DESIGN } from '../../lib/design';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

const EXT: Record<string, string> = { 'image/png': 'png', 'image/webp': 'webp', 'image/jpeg': 'jpg' };
const MAX_BYTES = 8 * 1024 * 1024;
const MIN_POSES = 2; // the kiosk picks a new pose different from the last one

// drop an uploaded file once the config no longer points at it (shipped images aren't ours to delete)
const dropUpload = (url: string) => (url.startsWith(`${DESIGN_URL}/`) ? unlink(path.join(DESIGN_DIR, path.basename(url))).catch(() => {}) : undefined);

// the kiosk reads this on load; no login
export const GET: APIRoute = async () => json(await readDesign());

// designer only. POST multipart {kind: bg|pose, file}: bg replaces, pose appends.
export const POST: APIRoute = async ({ request, cookies }) => {
  if (!sessionEmail(cookies.get(DESIGNER_COOKIE)?.value)) return json({ error: 'sign in required' }, 401);
  const form = await request.formData();
  const kind = form.get('kind'), file = form.get('file');
  const ext = file instanceof File ? EXT[file.type] : undefined;
  if ((kind !== 'bg' && kind !== 'pose') || !(file instanceof File) || !ext) return json({ error: 'send kind=bg|pose and a png/webp/jpeg file' }, 400);
  if (file.size > MAX_BYTES) return json({ error: 'image over 8 MB' }, 413);

  // unique name per upload: the host caches static files, so a reused name would show the old image
  const name = `${kind}-${Date.now()}.${ext}`;
  await mkdir(DESIGN_DIR, { recursive: true });
  await writeFile(path.join(DESIGN_DIR, name), Buffer.from(await file.arrayBuffer()));
  const design = await readDesign();
  const url = `${DESIGN_URL}/${name}`;
  await writeDesign(kind === 'bg' ? { ...design, bg: url } : { ...design, poses: [...design.poses, url] });
  if (kind === 'bg') await dropUpload(design.bg);
  return json(await readDesign());
};

// ?kind=bg resets to the shipped background; ?kind=pose&url=<pose url> removes that expression (keeps at least 2)
export const DELETE: APIRoute = async ({ cookies, url }) => {
  if (!sessionEmail(cookies.get(DESIGNER_COOKIE)?.value)) return json({ error: 'sign in required' }, 401);
  const design = await readDesign();
  let target = url.searchParams.get('url') ?? '';
  if (url.searchParams.get('kind') === 'bg') (target = design.bg), (design.bg = DEFAULT_DESIGN.bg);
  else if (design.poses.includes(target)) {
    if (design.poses.length <= MIN_POSES) return json({ error: `keep at least ${MIN_POSES} expressions` }, 400);
    design.poses = design.poses.filter((p) => p !== target);
  } else return json({ error: 'unknown expression' }, 400);
  await writeDesign(design);
  await dropUpload(target);
  return json(design);
};
