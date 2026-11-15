<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import QRCode from 'qrcode';

  let { slug }: { slug: string } = $props();

  // media lives on creka_backend (/uploads), not on this server
  const MEDIA = import.meta.env.PUBLIC_BACKEND_URL ?? 'https://creka.online';
  const POLL_MS = 3000;
  const CARD_MS = 8000; // how long a text/photo is featured; videos play to the end
  const GRID = 9; // cards visible behind the spotlight

  interface Msg { id: number; kind: 'text' | 'photo' | 'video'; author_name: string; body: string; media_path: string | null; poster_path: string | null; pinned: boolean }

  let started = $state(false);
  let muted = $state(false);
  let title = $state('');
  let maxVideo = $state(15);
  let items = $state<Msg[]>([]);
  let featured = $state<Msg | null>(null);
  let qr = $state('');
  let videoEl = $state<HTMLVideoElement | null>(null);

  const shown = new Map<number, number>(); // id -> last time featured, so everyone gets a turn and new ones jump in
  let timer: ReturnType<typeof setTimeout>;
  let poll: ReturnType<typeof setInterval>;
  let wake: any = null;
  let alive = true;

  const url = (p: string | null) => (p ? MEDIA + p : '');

  async function load() {
    try {
      const res = await fetch(`/api/lovewall/${slug}/wall`);
      if (!res.ok) return;
      const j = await res.json();
      title = j.campaign.name;
      maxVideo = j.settings.max_video_s;
      items = j.data;
    } catch {
      /* offline: keep playing what we have, next poll retries */
    }
  }

  // oldest-featured first, pinned and newest breaking ties
  function next(): Msg | null {
    if (!items.length) return null;
    return [...items].sort((a, b) => (shown.get(a.id) ?? 0) - (shown.get(b.id) ?? 0) || +b.pinned - +a.pinned || b.id - a.id)[0];
  }

  function advance() {
    clearTimeout(timer);
    if (!alive) return;
    featured = next();
    if (!featured) return void (timer = setTimeout(advance, 2000));
    shown.set(featured.id, Date.now());
    // a video calls rest() itself when it ends; the longer timeout is only the safety net if it stalls
    timer = setTimeout(rest, featured.kind === 'video' ? (maxVideo + 5) * 1000 : CARD_MS);
  }

  // clear the spotlight for a beat so the same item (a lone video) re-mounts when it comes round again
  function rest() {
    clearTimeout(timer);
    featured = null;
    timer = setTimeout(advance, 600);
  }

  // the Start click is the user gesture that lets videos play with sound
  async function start() {
    started = true;
    try { await document.documentElement.requestFullscreen(); } catch {}
    lock();
    advance();
  }
  async function lock() {
    try { wake = await (navigator as any).wakeLock?.request('screen'); } catch {}
  }
  function playVideo(el: HTMLVideoElement) {
    el.muted = muted;
    el.play().catch(() => {
      el.muted = true; // sound blocked: play on silently rather than stall the wall
      el.play().catch(rest);
    });
  }
  $effect(() => {
    if (videoEl) playVideo(videoEl);
  });

  const key = (e: KeyboardEvent) => {
    if (e.key === 'm') {
      muted = !muted;
      if (videoEl) videoEl.muted = muted;
    }
  };

  onMount(async () => {
    qr = await QRCode.toDataURL(`${location.origin}/lovewall/${slug}`, { margin: 1, width: 240 });
    await load();
    poll = setInterval(load, POLL_MS);
    document.addEventListener('visibilitychange', () => document.visibilityState === 'visible' && started && lock());
  });
  onDestroy(() => {
    alive = false;
    clearTimeout(timer);
    clearInterval(poll);
    wake?.release?.();
  });

  const grid = $derived(items.filter((m) => m.id !== featured?.id).slice(0, GRID));
</script>

<svelte:window onkeydown={key} />

<div class="wall">
  <header>{title}</header>

  <div class="grid">
    {#each grid as m (m.id)}
      <div class="card">
        {#if m.kind !== 'text'}<img src={url(m.kind === 'video' ? m.poster_path : m.media_path)} alt="" />{/if}
        {#if m.body}<p>{m.body}</p>{/if}
        <small>{m.author_name || 'A guest'}{m.kind === 'video' ? ' · ▶' : ''}</small>
      </div>
    {/each}
  </div>

  {#if !items.length}
    <div class="empty">Scan to leave a message</div>
  {/if}

  <div class="qr">
    <img src={qr} alt="scan to send" />
    <span>Send us a message</span>
  </div>

  {#if featured}
    {#key featured.id}
      <div class="spot" class:video={featured.kind === 'video'}>
        {#if featured.kind === 'video'}
          <!-- svelte-ignore a11y_media_has_caption -->
          <video bind:this={videoEl} src={url(featured.media_path)} poster={url(featured.poster_path)} playsinline preload="auto" onended={rest} onerror={rest}></video>
          <div class="cap">{featured.body ? featured.body + ' — ' : ''}{featured.author_name || 'A guest'}</div>
        {:else}
          <div class="big">
            {#if featured.kind === 'photo'}<img src={url(featured.media_path)} alt="" />{/if}
            {#if featured.body}<p class:small={featured.kind === 'photo'}>{featured.body}</p>{/if}
            <small>— {featured.author_name || 'A guest'}</small>
          </div>
        {/if}
      </div>
    {/key}
  {/if}

  {#if !started}
    <button class="start" onclick={start}>Start wall</button>
  {/if}
</div>

<style>
  .wall {
    position: fixed;
    inset: 0;
    background: #0f1117;
    color: #e1e4ea;
    font-family: system-ui, -apple-system, sans-serif;
    overflow: hidden;
    display: flex;
    flex-direction: column;
  }
  header {
    padding: 2vmin 3vmin;
    font-size: 4vmin;
    font-weight: 700;
    text-align: center;
  }
  .grid {
    flex: 1;
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(28vmin, 1fr));
    grid-auto-rows: minmax(0, 1fr);
    gap: 2vmin;
    padding: 0 3vmin 3vmin;
    min-height: 0;
  }
  .card {
    background: #1a1d27;
    border-radius: 2vmin;
    padding: 2vmin;
    display: flex;
    flex-direction: column;
    gap: 1vmin;
    min-height: 0;
    overflow: hidden;
    animation: pop 0.6s ease;
  }
  .card img {
    flex: 1;
    min-height: 0;
    object-fit: cover;
    border-radius: 1vmin;
  }
  .card p {
    margin: 0;
    font-size: 2.6vmin;
  }
  small {
    opacity: 0.6;
    font-size: 2vmin;
  }
  .empty {
    position: absolute;
    inset: 0;
    display: grid;
    place-items: center;
    font-size: 6vmin;
    opacity: 0.5;
  }
  .qr {
    position: absolute;
    right: 2vmin;
    bottom: 2vmin;
    background: #fff;
    color: #111;
    border-radius: 1.5vmin;
    padding: 1vmin;
    text-align: center;
    font-size: 1.8vmin;
  }
  .qr img {
    width: 14vmin;
    display: block;
  }
  .spot {
    position: absolute;
    inset: 0;
    display: grid;
    place-items: center;
    background: rgba(8, 9, 14, 0.88);
    animation: fade 0.5s ease;
  }
  .spot.video {
    background: #000;
  }
  .spot video {
    width: 100%;
    height: 100%;
    object-fit: contain;
  }
  .cap {
    position: absolute;
    left: 0;
    right: 0;
    bottom: 0;
    padding: 4vmin;
    font-size: 3.2vmin;
    background: linear-gradient(transparent, rgba(0, 0, 0, 0.75));
  }
  .big {
    max-width: 80vw;
    max-height: 85vh;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 2vmin;
    text-align: center;
  }
  .big img {
    max-width: 100%;
    max-height: 60vh;
    border-radius: 2vmin;
    object-fit: contain;
  }
  .big p {
    margin: 0;
    font-size: 6vmin;
    line-height: 1.25;
  }
  .big p.small {
    font-size: 3.4vmin;
  }
  .big small {
    font-size: 3vmin;
  }
  .start {
    position: absolute;
    inset: 0;
    margin: auto;
    width: 40vmin;
    height: 12vmin;
    font-size: 4vmin;
    border: 0;
    border-radius: 3vmin;
    background: #e8456b;
    color: #fff;
    cursor: pointer;
    z-index: 10;
  }
  @keyframes pop {
    from { opacity: 0; transform: scale(0.92); }
  }
  @keyframes fade {
    from { opacity: 0; }
  }
</style>
