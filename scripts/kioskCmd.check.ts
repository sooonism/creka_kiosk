// run: node --experimental-strip-types scripts/kioskCmd.check.ts
import assert from 'node:assert';
import { send, next, reply } from '../src/lib/kioskCmd.ts';
const ac = new AbortController();
// poll open first, then command
const p = next('k1', ac.signal);
const s = send('k1', 'ping');
const c = await p; assert.equal(c?.type, 'ping');
reply(c!.n, { ok: true }); assert.deepEqual(await s, { ok: true });
// command first, then poll
const s2 = send('k1', 'snap'); const c2 = await next('k1', ac.signal); assert.equal(c2?.type, 'snap');
reply(c2!.n, { ok: true, img: 'x' }); assert.equal((await s2).img, 'x');
// no kiosk: times out
assert.equal((await send('nobody', 'ping', 100)).ok, false);
// aborted poll drops, next command is queued not lost
const ac2 = new AbortController(); const p3 = next('k2', ac2.signal); ac2.abort(); assert.equal(await p3, null);
const s4 = send('k2', 'ping'); assert.equal((await next('k2', ac.signal))?.type, 'ping'); reply(2 + 0, {}); 
console.log('kioskCmd ok'); process.exit(0);
