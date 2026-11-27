<script lang="ts">
  import { onDestroy, onMount } from 'svelte';
  import '../styles/lovewall.css';
  import LovewallBackdrop from './LovewallBackdrop.svelte';
  import { accentStyle, loadFonts, type Look } from '../lib/lovewall-theme';

  let { slug }: { slug: string } = $props();

  // limits mirror the backend (CrekaCampaign.Lovewall); it enforces them, this just fails fast on a slow venue network
  const MAX_PHOTO = 10_000_000;
  const MAX_VIDEO = 30_000_000;

  const MEDIA = import.meta.env.PUBLIC_BACKEND_URL ?? 'https://creka.online';

  let campaignName = $state('');
  let look = $state<Look | null>(null);
  let open = $state(true);
  let name = $state('');
  let body = $state('');
  let file = $state<File | null>(null);
  let consent = $state(false);
  let sending = $state(false);
  let progress = $state(0);
  let error = $state('');
  let sent = $state<'approved' | 'pending' | null>(null);
  let preview = $state('');
  let deviceId = '';

  // crypto.randomUUID is secure-context only (https/localhost); getRandomValues also works over plain http (LAN testing)
  const uuid = () =>
    crypto.randomUUID?.() ?? [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, '0')).join('');

  // a kiosk opens this page with ?kiosk=<id> so the message is tagged as coming from it
  const kiosk = new URLSearchParams(typeof location === 'undefined' ? '' : location.search).get('kiosk');

  onMount(async () => {
    recordApi = typeof MediaRecorder !== 'undefined' && !!navigator.mediaDevices?.getUserMedia;
    try {
      deviceId = localStorage.getItem('lw-device') ?? uuid();
      localStorage.setItem('lw-device', deviceId);
      name = localStorage.getItem('lw-name') ?? '';
    } catch {
      deviceId = uuid();
    }
    const res = await fetch(`/api/lovewall/${slug}/wall`).catch(() => null);
    if (res?.ok) {
      const j = await res.json();
      campaignName = j.campaign.name;
      look = j.settings;
      open = j.settings.submissions_open;
      loadFonts(look?.template);
    }
  });

  // what the organiser lets guests send; older backends send nothing, so default to everything
  const can = $derived({ text: look?.allow_text !== false, photo: look?.allow_photo !== false, video: look?.allow_video !== false });
  const media = $derived(can.photo || can.video);
  const mediaWord = $derived(can.photo && can.video ? 'photo or video' : can.photo ? 'photo' : 'video');
  const accept = $derived([can.photo && 'image/*', can.video && 'video/*'].filter(Boolean).join(','));
  const lede = $derived(
    'Leave a ' + [can.text && 'message', can.photo && 'photo', can.video && 'short video'].filter(Boolean).join(', ').replace(/, ([^,]*)$/, ' or $1') + ' for the wall.'
  );

  function pick(e: Event) {
    error = '';
    const f = (e.target as HTMLInputElement).files?.[0] ?? null;
    if (f && !(f.type.startsWith('video/') ? can.video : can.photo)) {
      error = `Sorry, ${f.type.startsWith('video/') ? 'videos' : 'photos'} are not being accepted for this event.`;
      (e.target as HTMLInputElement).value = '';
      return;
    }
    if (f && f.size > (f.type.startsWith('video/') ? MAX_VIDEO : MAX_PHOTO)) {
      error = f.type.startsWith('video/') ? 'Video is over 30 MB — try a shorter clip.' : 'Photo is over 10 MB.';
      (e.target as HTMLInputElement).value = '';
      return;
    }
    file = f;
    stickers = []; selected = null;
    if (preview) URL.revokeObjectURL(preview);
    preview = f ? URL.createObjectURL(f) : '';
  }

  // Stickers on a photo. Position/size are fractions of the photo so the on-screen edit and the flattened upload match.
  // Test set = the MBS photobooth poses; a per-event set can replace this list later.
  const STICKERS = [1, 2, 3, 4, 5].map((n) => `/img/demo/mbs/MBG-mascot-00${n}.png`);
  type Sticker = { id: number; src: string; x: number; y: number; s: number; r: number };
  let stickers = $state<Sticker[]>([]);
  let selected = $state<number | null>(null);
  let editEl = $state<HTMLElement | null>(null);
  let stickerId = 0;
  const isPhoto = $derived(!!file && file.type.startsWith('image/'));
  const sel = $derived(stickers.find((t) => t.id === selected));

  function addSticker(src: string) {
    stickers.push({ id: ++stickerId, src, x: 0.5, y: 0.5, s: 0.32, r: 0 });
    selected = stickerId;
  }
  const removeSticker = () => { stickers = stickers.filter((t) => t.id !== selected); selected = null; };

  function dragSticker(e: PointerEvent, t: Sticker) {
    selected = t.id;
    const el = e.currentTarget as HTMLElement;
    el.setPointerCapture(e.pointerId);
    const box = editEl!.getBoundingClientRect();
    const move = (m: PointerEvent) => {
      t.x = Math.min(1.3, Math.max(-0.3, (m.clientX - box.left) / box.width));
      t.y = Math.min(1.3, Math.max(-0.3, (m.clientY - box.top) / box.height));
    };
    const up = () => { el.removeEventListener('pointermove', move); el.removeEventListener('pointerup', up); };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
  }

  // In-app recording: hard stop at REC_MAX_S, corner countdown for the last REC_MAX_S - REC_WARN_S seconds.
  // Needs getUserMedia (https or localhost), so the button only shows where it exists; the file picker stays as the fallback.
  const REC_MAX_S = 30;
  const REC_WARN_S = 20;
  let recordApi = $state(false); // set in onMount: SSR has no navigator
  const canRecord = $derived(can.video && recordApi);
  let recording = $state(false);
  let elapsed = $state(0);
  let liveEl = $state<HTMLVideoElement | null>(null);
  let stream: MediaStream | null = null;
  let recorder: MediaRecorder | null = null;
  let tick: ReturnType<typeof setInterval> | undefined;

  async function startRecording() {
    error = '';
    try {
      stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user' }, audio: true });
    } catch {
      return (error = 'Could not open the camera. Allow camera and microphone access, or add a video instead.');
    }
    const mime = ['video/mp4', 'video/webm'].find((t) => MediaRecorder.isTypeSupported(t)) ?? '';
    // ~2.5 Mbit/s keeps 30 s near 10 MB, well under the 30 MB upload cap
    recorder = new MediaRecorder(stream, { ...(mime && { mimeType: mime }), videoBitsPerSecond: 2_500_000 });
    const chunks: Blob[] = [];
    recorder.ondataavailable = (e) => e.data.size && chunks.push(e.data);
    recorder.onstop = () => {
      const type = recorder?.mimeType || mime || 'video/webm';
      file = new File(chunks, `recording${type.includes('mp4') ? '.mp4' : '.webm'}`, { type });
      if (preview) URL.revokeObjectURL(preview);
      preview = URL.createObjectURL(file);
      cleanupRecording();
    };
    recording = true;
    elapsed = 0;
    // the live <video> mounts once `recording` flips, so attach the stream after the DOM updates
    queueMicrotask(() => liveEl && ((liveEl.srcObject = stream), liveEl.play()));
    recorder.start();
    const t0 = Date.now();
    tick = setInterval(() => {
      elapsed = (Date.now() - t0) / 1000;
      if (elapsed >= REC_MAX_S) stopRecording();
    }, 200);
  }

  const stopRecording = () => recorder?.state === 'recording' && recorder.stop();

  function cleanupRecording() {
    clearInterval(tick);
    stream?.getTracks().forEach((t) => t.stop());
    stream = null;
    recording = false;
  }

  // leaving mid-recording must release the camera without producing a file
  onDestroy(() => {
    if (recorder) recorder.onstop = null;
    stopRecording();
    cleanupRecording();
  });

  // XHR, not fetch: it reports upload progress, which matters for a video on venue wifi
  function send() {
    error = '';
    if (!(can.text && body.trim()) && !file) return (error = can.text ? `Write something${media ? ` or add a ${mediaWord}` : ''}.` : `Add a ${mediaWord}.`);
    if (!consent) return (error = 'Please tick the box so we can show your message.');
    try { localStorage.setItem('lw-name', name); } catch {}

    const fd = new FormData();
    fd.set('name', name);
    fd.set('body', body);
    fd.set('consent', 'true');
    fd.set('device_id', deviceId);
    if (kiosk) { fd.set('source', 'kiosk'); fd.set('kiosk_id', kiosk); }
    if (file) fd.set('file', file);
    // stickers travel as positions (fractions of the photo); the wall draws them back over the untouched photo
    if (isPhoto && stickers.length) fd.set('stickers', JSON.stringify(stickers.map(({ src, x, y, s, r }) => ({ src, x, y, s, r }))));

    const xhr = new XMLHttpRequest();
    xhr.open('POST', `/api/lovewall/${slug}/messages`);
    xhr.upload.onprogress = (e) => (progress = e.lengthComputable ? Math.round((e.loaded / e.total) * 100) : 0);
    xhr.onload = () => {
      sending = false;
      let j: any = {};
      try { j = JSON.parse(xhr.responseText); } catch {}
      if (xhr.status === 201) {
        sent = j.moderation === 'approved' ? 'approved' : 'pending';
        body = ''; file = null; preview = ''; consent = false; stickers = []; selected = null;
      } else error = j.message ?? (xhr.status === 413 ? 'File is too big.' : 'Could not send, please try again.');
    };
    xhr.onerror = () => { sending = false; error = 'No connection — please try again.'; };
    sending = true;
    progress = 0;
    xhr.send(fd);
  }
</script>

<!-- the page stays blank until the look arrives, so a wedding never flashes the default dark theme -->
{#if look}
  <div class="lw lw-guest" data-theme={look.template} style={accentStyle(look.accent)}>
    <LovewallBackdrop theme={look.template} />
    <main class="lw-page">
      <header class="lw-head">
        {#if look.logo_path}<img class="lw-logo" src={look.logo_path.startsWith('/uploads/') ? MEDIA + look.logo_path : look.logo_path} alt="" />{/if}
        <div class="lw-titles">
          <h1 class="lw-title">{look.title || campaignName || 'Leave a message'}</h1>
          {#if look.subtitle}<p class="lw-sub">{look.subtitle}</p>{/if}
        </div>
        <div class="lw-orn" aria-hidden="true"><i></i></div>
      </header>

      {#if sent}
        <div class="lw-done" role="status">
          <svg class="lw-done-icon" viewBox="0 0 48 48" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            {#if sent === 'approved'}<circle cx="24" cy="24" r="20" /><path d="M15 25l6 6 12-14" />{:else}<circle cx="24" cy="24" r="20" /><path d="M24 14v11l7 4" />{/if}
          </svg>
          <p>{sent === 'approved' ? 'Sent! Look out for it on the wall.' : 'Thank you! Your message will appear on the wall once the organiser approves it.'}</p>
          <button class="lw-btn ghost" onclick={() => (sent = null)}>Send another</button>
        </div>
      {:else if !open}
        <p class="lw-lede">Messages are closed for now.</p>
      {:else}
        <p class="lw-lede">{lede}</p>
        <input class="lw-field" placeholder="Your name (optional)" maxlength="40" autocomplete="name" bind:value={name} />
        {#if can.text}
          <textarea class="lw-field" placeholder="Your message" maxlength="500" rows="4" bind:value={body}></textarea>
        {/if}

        {#if media}
        <label class="lw-file">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 8a2 2 0 012-2h2l1.5-2h5L16 6h2a2 2 0 012 2v9a2 2 0 01-2 2H6a2 2 0 01-2-2z" /><circle cx="12" cy="12.5" r="3.5" /></svg>
          <span>{file ? file.name : `Add a ${mediaWord}`}</span>
          <input type="file" {accept} onchange={pick} hidden />
        </label>
        {#if canRecord}
          <button type="button" class="lw-btn ghost" onclick={startRecording}>Record a video (up to {REC_MAX_S}s)</button>
        {/if}
        {/if}
        {#if preview}
          {#if file?.type.startsWith('video/')}
            <!-- svelte-ignore a11y_media_has_caption -->
            <video class="lw-preview" src={preview} controls playsinline muted></video>
          {:else}
            <div class="lw-edit" bind:this={editEl}>
              <img src={preview} alt="Preview of your photo" draggable="false" onpointerdown={() => (selected = null)} />
              {#each stickers as t (t.id)}
                <img class="lw-sticker" class:on={t.id === selected} src={t.src} alt="" draggable="false"
                  style="left:{t.x * 100}%;top:{t.y * 100}%;width:{t.s * 100}%;transform:translate(-50%,-50%) rotate({t.r}deg)"
                  onpointerdown={(e) => dragSticker(e, t)} />
              {/each}
            </div>
          {/if}
        {/if}

        {#if isPhoto}
          {#if sel}
            <div class="lw-stk-ctl">
              <button type="button" onclick={() => (sel.s = Math.max(0.1, sel.s - 0.06))}>Smaller</button>
              <button type="button" onclick={() => (sel.s = Math.min(1, sel.s + 0.06))}>Bigger</button>
              <button type="button" onclick={() => (sel.r -= 15)}>↺</button>
              <button type="button" onclick={() => (sel.r += 15)}>↻</button>
              <button type="button" onclick={removeSticker}>Remove</button>
            </div>
          {:else if !stickers.length}
            <p class="lw-hint">Tap a sticker to add it, then drag it on your photo.</p>
          {/if}
          <div class="lw-stickers" aria-label="Stickers">
            {#each STICKERS as src}
              <button type="button" onclick={() => addSticker(src)}><img {src} alt="Add sticker" /></button>
            {/each}
          </div>
        {/if}

        <label class="lw-consent">
          <input type="checkbox" bind:checked={consent} />
          <span>I agree my message, photo or video may be shown on the wall and shared on the event's social media.</span>
        </label>

        {#if error}<p class="lw-err" role="alert">{error}</p>{/if}
        <button class="lw-btn" disabled={sending} onclick={send}>{sending ? (file ? `Sending… ${progress}%` : 'Sending…') : 'Send'}</button>
      {/if}
      <!-- white logo on the dark templates, black on the light ones -->
      <a class="lw-powered" href="https://creka.online" target="_blank" rel="noopener" aria-label="Qiosk by Creka">
        <img src="/img/qiosk_by_creka_{['classic', 'elegant', 'hitech'].includes(look.template) ? 'w' : 'b'}.svg" alt="" />
      </a>
    </main>
  </div>
{/if}

{#if recording}
  <div class="lw-rec">
    <!-- svelte-ignore a11y_media_has_caption -->
    <video bind:this={liveEl} playsinline muted></video>
    {#if elapsed >= REC_WARN_S}
      <div class="lw-rec-count" role="timer" aria-live="off">{Math.max(0, Math.ceil(REC_MAX_S - elapsed))}</div>
    {/if}
    <button class="lw-btn lw-rec-stop" onclick={stopRecording}>Stop</button>
  </div>
{/if}
