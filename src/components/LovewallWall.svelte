<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import QRCode from 'qrcode';
  import '../styles/lovewall.css';
  import LovewallBackdrop from './LovewallBackdrop.svelte';
  import { accentStyle, loadFonts, type Look } from '../lib/lovewall-theme';

  let { slug }: { slug: string } = $props();

  // media lives on creka_backend (/uploads), not on this server
  const MEDIA = import.meta.env.PUBLIC_BACKEND_URL ?? 'https://creka.online';
  const POLL_MS = 3000;
  const CARD_MS = 8000; // how long a text/photo is featured; videos play to the end
  const GRID = 9; // cards visible behind the spotlight

  interface Msg { id: number; kind: 'text' | 'photo' | 'video'; author_name: string; body: string; media_path: string | null; poster_path: string | null; pinned: boolean }

  let started = $state(false);
  let muted = $state(false);
  let campaignName = $state('');
  let look = $state<Look | null>(null);
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
  let wantFs = $state(false); // the organiser asked for fullscreen: waiting for a tap on this screen
  let lastCmd: number | null = null;

  const url = (p: string | null) => (p ? MEDIA + p : '');

  async function load() {
    try {
      const res = await fetch(`/api/lovewall/${slug}/wall`);
      if (!res.ok) return;
      const j = await res.json();
      campaignName = j.campaign.name;
      if (JSON.stringify(look) !== JSON.stringify(j.settings)) {
        look = j.settings;
        loadFonts(look?.template);
      }
      obey(j.settings.fullscreen_at, j.settings.fullscreen);
      maxVideo = j.settings.max_video_s;
      items = j.data;
    } catch {
      /* offline: keep playing what we have, next poll retries */
    }
  }

  // The organiser's fullscreen button. Leaving fullscreen needs no permission; entering does (a tap on this screen),
  // so "on" raises a prompt instead. The first load only records the stamp, so a reload never replays an old command.
  function obey(at: number, want: boolean) {
    if (lastCmd !== null && at !== lastCmd) {
      if (!want) {
        wantFs = false;
        if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
      } else if (!document.fullscreenElement) wantFs = started;
    }
    lastCmd = at;
    report();
  }
  // tell the organiser page what the browser is really doing
  const report = () =>
    fetch(`/api/lovewall/${slug}/wall/state`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ fullscreen: !!document.fullscreenElement }) }).catch(() => {});
  function goFullscreen() {
    wantFs = false;
    document.documentElement.requestFullscreen().catch(() => {});
  }
  const fsChange = () => {
    if (document.fullscreenElement) wantFs = false;
    report();
  };

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
    // the organiser can turn this off (e.g. a wall running inside a kiosk browser that is already fullscreen)
    if (look?.fullscreen !== false) try { await document.documentElement.requestFullscreen(); } catch {}
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
<svelte:document onfullscreenchange={fsChange} />

<!-- blank until the look arrives, so the wall never flashes the wrong template -->
{#if look}
<div class="lw lw-wall" data-theme={look.template} style={accentStyle(look.accent)}>
  <LovewallBackdrop theme={look.template} />
  <header class="lw-head">
    {#if look.logo_path}<img class="lw-logo" src={url(look.logo_path)} alt="" />{/if}
    <div class="lw-titles">
      <h1 class="lw-title">{look.title || campaignName}</h1>
      {#if look.subtitle}<p class="lw-sub">{look.subtitle}</p>{/if}
    </div>
    <div class="lw-orn" aria-hidden="true"><i></i></div>
  </header>

  <div class="lw-body">
  <div class="lw-grid">
    {#each grid as m (m.id)}
      <div class="lw-card">
        {#if m.kind !== 'text'}<img src={url(m.kind === 'video' ? m.poster_path : m.media_path)} alt="" />{/if}
        {#if m.body}<p>{m.body}</p>{/if}
        <small class="lw-by">{m.author_name || 'A guest'}{m.kind === 'video' ? ' · video' : ''}</small>
      </div>
    {/each}
  </div>
  {#if look.show_qr !== false}
    <aside class="lw-qr">
      <img src={qr} alt="Scan to send a message" />
      <span>Send us a message</span>
    </aside>
  {/if}
  </div>

  {#if !items.length}
    <div class="lw-empty">Scan the code to leave a message</div>
  {/if}

  {#if featured}
    {#key featured.id}
      <div class="lw-spot" class:video={featured.kind === 'video'}>
        {#if featured.kind === 'video'}
          <!-- svelte-ignore a11y_media_has_caption -->
          <video bind:this={videoEl} src={url(featured.media_path)} poster={url(featured.poster_path)} playsinline preload="auto" onended={rest} onerror={rest}></video>
          <div class="lw-cap">{featured.body ? featured.body + ' — ' : ''}{featured.author_name || 'A guest'}</div>
        {:else}
          <div class="lw-big">
            {#if featured.kind === 'photo'}<img src={url(featured.media_path)} alt="" />{/if}
            {#if featured.body}<p class:small={featured.kind === 'photo'}>{featured.body}</p>{/if}
            <small class="lw-by">{featured.author_name || 'A guest'}</small>
          </div>
        {/if}
      </div>
    {/key}
  {/if}

  {#if wantFs}
    <button class="lw-fs-prompt" onclick={goFullscreen}><span>Tap anywhere to go fullscreen</span></button>
  {/if}

  {#if !started}
    <button class="lw-start" onclick={start}>Start wall</button>
  {/if}
</div>
{/if}
