export const prerender = false;

import { CAPTURES_ROOT, LIMIT_BYTES, dirSize } from '../../lib/kiosks';

export const GET = async () =>
  new Response(JSON.stringify({ used: await dirSize(CAPTURES_ROOT), limit: LIMIT_BYTES }), { headers: { 'Content-Type': 'application/json' } });
