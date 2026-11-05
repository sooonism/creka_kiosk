// dashboard → kiosk commands (ping, camera snap, page reload). Kiosks sit behind CGNAT, so each kiosk page keeps one
// long-poll open (GET /api/kiosk-cmd), gets the command through it and POSTs the reply back.
// In memory, single node process, like `beats`; a lost poll just means a "no reply" the admin can retry.
export type Cmd = { n: number; type: 'ping' | 'snap' | 'reload' };

const polls = new Map<string, (c: Cmd | null) => void>(); // the kiosk's open long-poll
const queue = new Map<string, Cmd>(); // command that arrived while no poll was open
const replies = new Map<number, (r: unknown) => void>();
let seq = 0;

export function send(id: string, type: Cmd['type'], ms = 30_000): Promise<any> {
  const cmd: Cmd = { n: ++seq, type };
  return new Promise((resolve) => {
    const t = setTimeout(() => {
      replies.delete(cmd.n);
      if (queue.get(id)?.n === cmd.n) queue.delete(id);
      resolve({ ok: false, error: 'no reply (kiosk page offline?)' });
    }, ms);
    replies.set(cmd.n, (r) => (clearTimeout(t), resolve(r)));
    const poll = polls.get(id);
    if (poll) poll(cmd);
    else queue.set(id, cmd);
  });
}

export function next(id: string, signal: AbortSignal, ms = 25_000): Promise<Cmd | null> {
  return new Promise((resolve) => {
    const queued = queue.get(id);
    if (queued) return queue.delete(id), resolve(queued);
    polls.get(id)?.(null); // a newer poll replaces a stale one
    const done = (c: Cmd | null) => {
      clearTimeout(t);
      if (polls.get(id) === done) polls.delete(id);
      resolve(c);
    };
    const t = setTimeout(() => done(null), ms);
    signal.addEventListener('abort', () => done(null));
    polls.set(id, done);
  });
}

export const reply = (n: number, r: unknown) => {
  replies.get(n)?.(r);
  replies.delete(n);
};
