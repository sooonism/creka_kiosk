import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { CAPTURES_ROOT } from './kiosks';

// Hardcoded stand-in for the creka_backend lovewall, used while the backend has no campaign for the slug.
// Everything is approved on arrival (no moderation) and lives in <captures mount>/_lovewall/<slug>/.
// ponytail: single-process JSON file; replaced by the real campaign once it exists (the relay prefers the backend).
export const LOCAL: Record<string, { name: string; settings: Record<string, unknown> }> = {
  mbs: {
    name: 'MBS Event',
    settings: {
      accent: '', allow_photo: true, allow_text: true, allow_video: true, fullscreen: true, fullscreen_at: 0,
      logo_path: '/img/demo/mbs/roundtable_logo.png', max_video_s: 30, show_qr: true, submissions_open: true,
      subtitle: '', template: 'festive', title: 'MBS Lovewall',
    },
  },
};

const dir = (slug: string) => path.join(CAPTURES_ROOT, '_lovewall', slug);
const db = (slug: string) => path.join(dir(slug), 'messages.json');
const read = async (slug: string): Promise<any[]> => JSON.parse(await readFile(db(slug), 'utf8').catch(() => '[]'));

export async function wall(slug: string) {
  const l = LOCAL[slug];
  return { data: (await read(slug)).reverse(), status: 1, settings: l.settings, campaign: { name: l.name } };
}

const bad = (message: string, status = 422) => Response.json({ message, status: 0 }, { status });

export async function post(slug: string, form: FormData) {
  if (form.get('consent') !== 'true') return bad('Please tick the consent box');
  const body = String(form.get('body') ?? '').trim().slice(0, 500);
  const file = form.get('file');
  const hasFile = file instanceof File && file.size > 0;
  if (!body && !hasFile) return bad('Write something or add a photo or video');

  const msgs = await read(slug);
  const id = (msgs.at(-1)?.id ?? 0) + 1;
  let kind = 'text', media_path: string | null = null, stickers: unknown[] = [];
  await mkdir(dir(slug), { recursive: true });
  const url = (f: string) => `/captures/demo/camwithnkob/_lovewall/${slug}/${f}`;

  if (hasFile) {
    const buf = Buffer.from(await file.arrayBuffer());
    if (file.type.startsWith('video/') || /\.(mp4|mov|m4v|webm)$/i.test(file.name)) {
      kind = 'video';
      const ext = /webm/i.test(file.type + file.name) ? 'webm' : /quicktime|\.mov$/i.test(file.type + file.name) ? 'mov' : 'mp4';
      const f = `${id}-${crypto.randomUUID()}.${ext}`;
      await writeFile(path.join(dir(slug), f), buf);
      media_path = url(f);
    } else if (file.type.startsWith('image/')) {
      kind = 'photo';
      const { default: sharp } = await import('sharp');
      const alpha = /png|webp/.test(file.type); // keep transparency (stickers sit outside the frame)
      const img = sharp(buf).rotate().resize({ width: 1600, withoutEnlargement: true });
      const f = `${id}-${crypto.randomUUID()}.${alpha ? 'png' : 'jpg'}`;
      await (alpha ? img.png() : img.jpeg({ quality: 85 })).toFile(path.join(dir(slug), f));
      media_path = url(f);
      try {
        stickers = JSON.parse(String(form.get('stickers') ?? '[]')).slice(0, 12).map((s: any) => ({
          src: String(s.src), x: +s.x, y: +s.y, s: +s.s, r: +s.r,
        }));
      } catch {}
    } else return bad('Unsupported file type');
  }

  msgs.push({
    id, kind, author_name: String(form.get('name') ?? '').trim().slice(0, 60), body, media_path, poster_path: null,
    stickers, pinned: false, inserted_at: new Date().toISOString(), source: form.get('source') ?? 'web',
  });
  await writeFile(db(slug), JSON.stringify(msgs));
  return Response.json({ id, status: 1, moderation: 'approved' }, { status: 201 });
}
