export const prerender = false;

import type { APIRoute } from 'astro';
import { backend } from '../../lib/kiosks';
import { DESIGNER_COOKIE, isDesignerEmail, makeSession, sessionEmail } from '../../lib/designer';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

export const GET: APIRoute = ({ cookies }) => {
  const email = sessionEmail(cookies.get(DESIGNER_COOKIE)?.value);
  return email ? json({ email }) : json({ error: 'sign in required' }, 401);
};

// same Creka OTP flow as /api/auth ({email} sends the code, {email, otp} verifies), but only the DESIGNERS list gets a cookie
export const POST: APIRoute = async ({ request, cookies, url }) => {
  const { email, otp } = await request.json();
  if (typeof email !== 'string' || !isDesignerEmail(email)) return json({ error: 'this email is not a designer' }, 403);
  const res = await backend(`/api/creka/auth/otp/${otp ? 'login' : 'request'}`, { method: 'POST', body: JSON.stringify({ email, otp }) });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) return json({ error: body.message ?? 'login failed' }, res.status);
  if (otp) cookies.set(DESIGNER_COOKIE, makeSession(email), { path: '/', httpOnly: true, sameSite: 'lax', secure: url.protocol === 'https:', maxAge: 60 * 60 * 24 * 7 });
  return json({ ok: true });
};

export const DELETE: APIRoute = ({ cookies }) => (cookies.delete(DESIGNER_COOKIE, { path: '/' }), json({ ok: true }));
