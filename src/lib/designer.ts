import { createHmac, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { CAPTURES_ROOT } from './kiosks.ts';
import { DEFAULT_DESIGN, type Design } from './design.ts';

// Designer login: the Creka OTP proves the email, DESIGNERS says who may edit. The session is a
// stateless HMAC cookie, so it needs DESIGNER_SECRET (any long random string); without it nobody can sign in.
const DESIGNERS = ['sooonism@gmail.com', 'boonelee@gmail.com'];
export const DESIGNER_COOKIE = 'creka_designer';
const DAY = 24 * 3600 * 1000;
const secret = () => process.env.DESIGNER_SECRET ?? '';
const sign = (s: string) => createHmac('sha256', secret()).update(s).digest('base64url');

export const isDesignerEmail = (email: string) =>
  DESIGNERS.includes(email.trim().toLowerCase());

export const makeSession = (email: string) => {
  const p = `${email.toLowerCase()}|${Date.now() + 7 * DAY}`;
  return `${Buffer.from(p).toString('base64url')}.${sign(p)}`;
};

// the signed email if the cookie is valid, unexpired and the email is still on the list
export function sessionEmail(cookie?: string): string | null {
  if (!secret() || !cookie) return null;
  const [body, sig = ''] = cookie.split('.');
  const p = Buffer.from(body, 'base64url').toString();
  const good = Buffer.from(sign(p)), got = Buffer.from(sig);
  if (good.length !== got.length || !timingSafeEqual(good, got)) return null;
  const [email, exp] = p.split('|');
  return Number(exp) > Date.now() && isDesignerEmail(email) ? email : null;
}

// uploads sit in the persisted captures mount, so they survive redeploys and the node server serves them statically.
// '_' can't start a kiosk id, so no capture folder collides with it.
export const DESIGN_DIR = path.join(CAPTURES_ROOT, '_design');
export const DESIGN_URL = '/captures/demo/camwithnkob/_design';
const CONFIG = path.join(DESIGN_DIR, 'config.json');

export const readDesign = async (): Promise<Design> => {
  const saved = JSON.parse(await readFile(CONFIG, 'utf8').catch(() => '{}'));
  return { ...DEFAULT_DESIGN, ...saved };
};

export async function writeDesign(d: Design) {
  await mkdir(DESIGN_DIR, { recursive: true });
  await writeFile(`${CONFIG}.tmp`, JSON.stringify(d));
  await rename(`${CONFIG}.tmp`, CONFIG); // atomic: a kiosk never reads half a file
}
