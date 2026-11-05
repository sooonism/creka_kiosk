<script lang="ts">
  import { onMount } from "svelte";
  import { MODULES, FLAGS } from "../lib/modules";

  type Hw = { board: string; cpu: string; ram: string; monitor: string; camera: string; os: string; flags: string[] };
  type H = { day: string; samples: number; last_at: string; max_temp: number | null; min_disk_pct: number | null; min_mem_pct: number | null; min_wifi_pct: number | null; bad_camera: number; bad_display: number; bad_browser: number; last: Record<string, any> };
  type K = { health?: H | null; id: string; name: string; location: string; module: string; hw: Hw; notes: string; lastSeen: number; fresh?: boolean; captures?: number; beat?: { t: number; page: string; w: number; h: number } };

  let kiosks = $state<K[]>([]);
  let thumbs = $state<Record<string, string[]>>({});
  let history = $state<Record<string, H[]>>({});
  let login = $state(false); // backend wants an admin OTP session
  let email = $state("");
  let otp = $state("");
  let sent = $state(false);
  let msg = $state("");
  let now = $state(Date.now());
  let storage = $state({ used: 0, limit: 1 });

  const blank = (): K => ({
    id: "", name: "", location: "", module: MODULES[0].route, notes: "", lastSeen: 0, fresh: true,
    hw: { board: "", cpu: "", ram: "", monitor: "", camera: "", os: "", flags: ["internet"] },
  });

  // `fresh` = just saved/deleted: replace everything; polls only refresh live fields so unsaved edits survive
  async function load(fresh = false) {
    const res = await fetch("/api/kiosks");
    login = res.status === 401 || res.status === 403;
    if (!res.ok) return void (msg = login ? "" : "error: backend unreachable");
    const server: K[] = await res.json();
    if (fresh) kiosks = server;
    else {
      for (const s of server) {
        const mine = kiosks.find((k) => k.id === s.id);
        if (mine) Object.assign(mine, { beat: s.beat, captures: s.captures, lastSeen: s.lastSeen, health: s.health });
        else kiosks.push(s);
      }
      kiosks = kiosks.filter((k) => k.fresh || server.some((s) => s.id === k.id)); // unsaved drafts survive the poll
    }
    storage = await fetch("/api/storage").then((r) => r.json());
    for (const k of kiosks) {
      const ids: string[] = await fetch(`/api/captures?kiosk=${k.id}`).then((r) => r.json()).catch(() => []);
      thumbs[k.id] = ids.slice(0, 6);
      if (k.id) history[k.id] = await fetch(`/api/kiosk-health?id=${k.id}`).then((r) => r.json()).catch(() => []);
    }
  }

  const headers = () => ({ "Content-Type": "application/json" });

  async function auth(body: object) {
    const r = await fetch("/api/auth", { method: "POST", headers: headers(), body: JSON.stringify(body) });
    const j = await r.json();
    msg = r.ok ? "" : `error: ${j.error}`;
    return r.ok;
  }
  const sendCode = async () => (sent = await auth({ email }));
  const verify = async () => { if (await auth({ email, otp })) { otp = ""; sent = false; await load(true); } };
  const logout = async () => { await fetch("/api/auth", { method: "DELETE" }); kiosks = []; login = true; };

  async function save(k: K) {
    const r = await fetch("/api/kiosks", { method: "POST", headers: headers(), body: JSON.stringify(k) });
    msg = r.ok ? `saved ${k.id}` : `error: ${(await r.json()).error}`;
    if (r.ok) await load(true);
  }

  async function remove(k: K) {
    if (!confirm(`Delete ${k.id}? (captures stay on disk)`)) return;
    const r = await fetch(`/api/kiosks?id=${k.id}`, { method: "DELETE", headers: headers() });
    msg = r.ok ? `deleted ${k.id}` : "error: not allowed";
    if (r.ok) await load(true);
  }

  const toggle = (k: K, f: string) => (k.hw.flags = k.hw.flags.includes(f) ? k.hw.flags.filter((x) => x !== f) : [...k.hw.flags, f]);
  const can = (k: K) => MODULES.filter((m) => m.needs.every((n) => k.hw.flags.includes(n)));
  const cannot = (k: K) =>
    MODULES.map((m) => ({ m, miss: m.needs.filter((n) => !k.hw.flags.includes(n)) })).filter((x) => x.miss.length);
  const piUp = (k: K) => !!k.health && now - Date.parse(k.health.last_at) < 3 * 60_000;
  const lastOf = (k: K) => k.health?.last ?? {};
  // last 14 Malaysia days, oldest first; ~1440 reports a day when the Pi never sleeps
  const strip = (k: K) =>
    Array.from({ length: 14 }, (_, i) => new Date(now + 8 * 3600_000 - (13 - i) * 86_400_000).toISOString().slice(0, 10)).map((day) => ({
      day,
      h: history[k.id]?.find((r) => r.day === day),
    }));
  const tone = (s?: number) => (s === undefined ? "" : s >= 1000 ? "ok" : s >= 300 ? "mid" : "bad");
  const tip = (d: { day: string; h?: H }) =>
    d.h ? `${d.day}: ${d.h.samples} reports, max ${d.h.max_temp ?? "?"}°C, min disk free ${d.h.min_disk_pct ?? "?"}%, min wifi ${d.h.min_wifi_pct ?? "?"}%, camera/display/browser misses ${d.h.bad_camera}/${d.h.bad_display}/${d.h.bad_browser}` : `${d.day}: no reports`;
  // online = the kiosk page beat in the last minute, or the Pi's health report is fresh
  const online = (k: K) => now - (k.beat?.t ?? 0) < 60_000 || piUp(k);
  const onlineCount = $derived(kiosks.filter(online).length);
  type R = { busy?: boolean; ok?: boolean; error?: string; ms?: number; img?: string; bright?: number; page?: string; up?: number };
  let result = $state<Record<string, R>>({});
  const run = async (k: K, type: "ping" | "snap") => {
    result[k.id] = { busy: true };
    const r = await fetch("/api/kiosk-do", { method: "POST", headers: headers(), body: JSON.stringify({ id: k.id, type }) });
    result[k.id] = r.ok ? await r.json() : { ok: false, error: `dashboard says ${r.status}` };
  };
  const full = $derived(storage.used >= storage.limit);
  const mb = (b: number) => (b / 1048576).toFixed(0);
  const dir = (k: K) => `/captures/demo/camwithnkob/${k.id}/`;

  onMount(() => {
    load();
    const t = setInterval(() => ((now = Date.now()), load()), 15_000);
    return () => clearInterval(t);
  });
</script>

{#if login}
  <form class="card login" onsubmit={(e) => (e.preventDefault(), sent ? verify() : sendCode())}>
    <h3>Admin login</h3>
    <input type="email" placeholder="admin email" bind:value={email} required />
    {#if sent}<input inputmode="numeric" placeholder="code from email" bind:value={otp} required />{/if}
    <button>{sent ? "Verify" : "Send code"}</button>
    <span class="msg">{msg}</span>
  </form>
{:else}
<div class="bar" class:warn={storage.used >= storage.limit * 0.8} class:full>
  Captures {mb(storage.used)} / {mb(storage.limit)} MB
  {#if full}— <b>FULL, delete old captures</b>{/if}
  <progress value={storage.used} max={storage.limit}></progress>
</div>
<p class="live"><span class="dot on"></span> <b>{onlineCount}</b> of {kiosks.length} kiosk{kiosks.length === 1 ? "" : "s"} online</p>
<p class="hint">
  Point each Pi's Chromium at <code>https://kiosk.creka.online/k/&lt;id&gt;</code> once; change its module here.
  <button onclick={() => kiosks.push(blank())}>+ Add kiosk</button>
  <button onclick={logout}>Log out</button>
  <span class="msg">{msg}</span>
</p>

{#each kiosks as k (k.id || k)}
  <details class="card" open={k.fresh}>
    <summary>
      <span class="dot" class:on={online(k)} title={k.beat ? `${k.beat.page} ${k.beat.w}x${k.beat.h}` : "offline"}></span>
      <b>{k.name || k.id || "new kiosk"}</b>
      <small>{k.id}{k.location ? ` · ${k.location}` : ""}</small>
      {#if k.health}<small class:down={!piUp(k)}>Pi {piUp(k) ? `${lastOf(k).temp ?? "?"}°C · disk ${lastOf(k).disk_pct ?? "?"}% free · wifi ${lastOf(k).wifi_pct ?? "?"}%` : "no report"}</small>{/if}
      <small class="mod">{MODULES.find((m) => m.route === k.module)?.label ?? k.module}</small>
    </summary>
    <header>
      <input class="id" placeholder="id (a-z0-9-)" bind:value={k.id} />
      <input placeholder="name" bind:value={k.name} />
      <input placeholder="location" bind:value={k.location} />
      <label>Module
        <select bind:value={k.module}>
          {#each MODULES as m}<option value={m.route}>{m.label} — {m.route}</option>{/each}
        </select>
      </label>
    </header>

    <div class="grid">
      <div>
        <h3>Hardware</h3>
        {#each ["board", "cpu", "ram", "monitor", "camera", "os"] as f}
          <label>{f}<input bind:value={k.hw[f as keyof Hw] as string} /></label>
        {/each}
        <div class="flags">
          {#each FLAGS as f}
            <label><input type="checkbox" checked={k.hw.flags.includes(f)} onchange={() => toggle(k, f)} /> {f}</label>
          {/each}
        </div>
      </div>

      <div>
        <h3>Can do</h3>
        <ul class="ok">{#each can(k) as m}<li>{m.label}</li>{:else}<li>nothing</li>{/each}</ul>
        <h3>Cannot do</h3>
        <ul class="no">{#each cannot(k) as x}<li>{x.m.label} <small>needs {x.miss.join(", ")}</small></li>{:else}<li>—</li>{/each}</ul>
      </div>

      <div>
        <h3>Pi health {#if k.health}<small>{piUp(k) ? "reporting" : `silent since ${new Date(k.health.last_at).toLocaleTimeString()}`}</small>{/if}</h3>
        {#if k.health}
          <ul class="chk">
            {#each [["display", "screen"], ["camera", "camera"], ["browser", "Chromium"], ["ntp", "clock sync"]] as [key, label]}
              <li class:bad={lastOf(k)[key] === false}>{lastOf(k)[key] === false ? "✗" : "✓"} {label}</li>
            {/each}
          </ul>
          <small>up {Math.floor((lastOf(k).up ?? 0) / 3600)}h · {lastOf(k).ssid ?? "no wifi"} · {lastOf(k).ip ?? ""}</small><br />
          <small>{lastOf(k).url ?? "no page"}</small>
        {:else}
          <small>no reports yet — install scripts/kiosk-health.sh on the Pi</small>
        {/if}
        <div class="strip">{#each strip(k) as d}<i class={tone(d.h?.samples)} title={tip(d)}></i>{/each}</div>
      </div>

      <div>
        <h3>Captures <small>{k.captures ?? 0} files</small></h3>
        <code>{dir(k)}</code>
        <div class="thumbs">
          {#each thumbs[k.id] ?? [] as id}<a href={`${dir(k)}${id}.png`} target="_blank"><img src={`${dir(k)}${id}.png`} alt="" /></a>{/each}
        </div>
        <label>Notes<textarea bind:value={k.notes}></textarea></label>
      </div>
    </div>

    <footer>
      <button onclick={() => save(k)}>Save</button>
      <button class="del" onclick={() => remove(k)}>Delete</button>
      <button onclick={() => run(k, "ping")} disabled={result[k.id]?.busy}>Ping</button>
      <button onclick={() => run(k, "snap")} disabled={result[k.id]?.busy}>Check camera</button>
      {#if k.beat}<small>on {k.beat.page} ({k.beat.w}×{k.beat.h})</small>{/if}
      {#if k.lastSeen}<small>last seen {new Date(k.lastSeen).toLocaleString()}</small>{/if}
    </footer>
    {#if result[k.id]}
      {@const r = result[k.id]}
      <p class="reply" class:bad={r.ok === false}>
        {#if r.busy}waiting for the kiosk…
        {:else if !r.ok}✗ {r.error}
        {:else if r.img}
          {r.bright! < 8 ? "✗ frame is black, camera not delivering" : "✓ camera frame"} (brightness {r.bright}/255, {r.ms} ms)<br /><img src={r.img} alt="camera check" />
        {:else}✓ replied in {r.ms} ms · {r.page} · page up {r.up}s{/if}
      </p>
    {/if}
  </details>
{/each}
{/if}

<style>
  .bar { font-size: 0.85rem; color: #8b8fa3; } .bar progress { width: 100%; }
  .bar.warn { color: #fbbf24; } .bar.full { color: #f87171; background: #3b1219; padding: 0.5rem; border-radius: 6px; }
  .login { display: flex; flex-direction: column; gap: 0.5rem; max-width: 20rem; }
  .hint { color: #8b8fa3; font-size: 0.85rem; }
  .msg { margin-left: 0.5rem; color: #a78bfa; }
  .card { background: #1a1d27; border: 1px solid #2a2d37; border-radius: 10px; padding: 1rem; margin: 1rem 0; }
  header { display: flex; flex-wrap: wrap; gap: 0.5rem; align-items: end; }
  .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: 1rem; margin-top: 1rem; }
  label { display: flex; flex-direction: column; font-size: 0.7rem; color: #8b8fa3; margin-top: 0.4rem; }
  input, select, textarea, button { background: #0f1117; color: #e1e4ea; border: 1px solid #2a2d37; border-radius: 6px; padding: 0.35rem 0.5rem; font: inherit; }
  button { cursor: pointer; }
  button:hover { border-color: #a78bfa; }
  .del:hover { border-color: #f87171; }
  .id { width: 10rem; }
  summary { display: flex; gap: 0.6rem; align-items: center; cursor: pointer; }
  .mod { margin-left: auto; }
  details[open] > summary { margin-bottom: 0.75rem; }
  .dot { width: 10px; height: 10px; border-radius: 50%; background: #5b5f73; align-self: center; }
  .dot.on { background: #4ade80; animation: blink 1.4s ease-in-out infinite; }
  @keyframes blink { 50% { opacity: 0.25; } }
  .live { font-size: 0.95rem; display: flex; align-items: center; gap: 0.4rem; }
  .reply { font-size: 0.85rem; color: #4ade80; } .reply.bad { color: #f87171; } .reply img { max-width: 24rem; width: 100%; border-radius: 6px; margin-top: 0.4rem; }
  .down { color: #f87171; }
  .chk { list-style: none; padding: 0; } .chk .bad { color: #f87171; }
  .strip { display: flex; gap: 3px; margin-top: 0.5rem; }
  .strip i { width: 14px; height: 14px; border-radius: 3px; background: #2a2d37; }
  .strip .ok { background: #4ade80; } .strip .mid { background: #fbbf24; } .strip .bad { background: #f87171; }
  .flags { display: flex; gap: 0.75rem; flex-wrap: wrap; }
  .flags label { flex-direction: row; gap: 0.3rem; align-items: center; }
  ul { margin: 0; padding-left: 1.1rem; font-size: 0.85rem; }
  .ok li::marker { color: #4ade80; } .no li::marker { color: #f87171; }
  small { color: #8b8fa3; }
  h3 { margin: 0.5rem 0 0.25rem; font-size: 0.85rem; }
  .thumbs { display: flex; flex-wrap: wrap; gap: 4px; margin: 0.5rem 0; }
  .thumbs img { width: 64px; height: 64px; object-fit: cover; border-radius: 4px; }
  textarea { min-height: 3rem; }
  footer { margin-top: 1rem; display: flex; gap: 0.5rem; align-items: center; }
</style>
