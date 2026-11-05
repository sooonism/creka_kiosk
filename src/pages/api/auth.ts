export const prerender = false;

import type { APIRoute } from 'astro';
import { ADMIN_COOKIE, backend } from '../../lib/kiosks';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

// admin OTP login via the Creka account API: {email} sends the code, {email, otp} verifies it and sets the cookie.
// The token stays in an httpOnly cookie; whether it is an *admin* is enforced by the backend on each dashboard call.
export const POST: APIRoute = async ({ request, cookies, url }) => {
  const { email, otp } = await request.json();
  const res = await backend(`/api/creka/auth/otp/${otp ? 'login' : 'request'}`, { method: 'POST', body: JSON.stringify({ email, otp }) });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) return json({ error: body.message ?? 'login failed' }, res.status);
  if (otp) cookies.set(ADMIN_COOKIE, body.data.token, { path: '/', httpOnly: true, sameSite: 'lax', secure: url.protocol === 'https:', maxAge: 60 * 60 * 24 * 7 });
  return json({ ok: true });
};

export const DELETE: APIRoute = ({ cookies }) => (cookies.delete(ADMIN_COOKIE, { path: '/' }), json({ ok: true }));
