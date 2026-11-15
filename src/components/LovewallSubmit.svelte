<script lang="ts">
  import { onMount } from 'svelte';
  import '../styles/lovewall.css';
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

  function pick(e: Event) {
    error = '';
    const f = (e.target as HTMLInputElement).files?.[0] ?? null;
    if (f && f.size > (f.type.startsWith('video/') ? MAX_VIDEO : MAX_PHOTO)) {
      error = f.type.startsWith('video/') ? 'Video is over 30 MB — try a shorter clip.' : 'Photo is over 10 MB.';
      (e.target as HTMLInputElement).value = '';
      return;
    }
    file = f;
    if (preview) URL.revokeObjectURL(preview);
    preview = f ? URL.createObjectURL(f) : '';
  }

  // XHR, not fetch: it reports upload progress, which matters for a video on venue wifi
  function send() {
    error = '';
    if (!body.trim() && !file) return (error = 'Write something or add a photo or video.');
    if (!consent) return (error = 'Please tick the box so we can show your message.');
    try { localStorage.setItem('lw-name', name); } catch {}

    const fd = new FormData();
    fd.set('name', name);
    fd.set('body', body);
    fd.set('consent', 'true');
    fd.set('device_id', deviceId);
    if (kiosk) { fd.set('source', 'kiosk'); fd.set('kiosk_id', kiosk); }
    if (file) fd.set('file', file);

    const xhr = new XMLHttpRequest();
    xhr.open('POST', `/api/lovewall/${slug}/messages`);
    xhr.upload.onprogress = (e) => (progress = e.lengthComputable ? Math.round((e.loaded / e.total) * 100) : 0);
    xhr.onload = () => {
      sending = false;
      let j: any = {};
      try { j = JSON.parse(xhr.responseText); } catch {}
      if (xhr.status === 201) {
        sent = j.moderation === 'approved' ? 'approved' : 'pending';
        body = ''; file = null; preview = ''; consent = false;
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
    <main class="lw-page">
      <header class="lw-head">
        {#if look.logo_path}<img class="lw-logo" src={MEDIA + look.logo_path} alt="" />{/if}
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
        <p class="lw-lede">Leave a message, photo or short video for the wall.</p>
        <input class="lw-field" placeholder="Your name (optional)" maxlength="40" autocomplete="name" bind:value={name} />
        <textarea class="lw-field" placeholder="Your message" maxlength="500" rows="4" bind:value={body}></textarea>

        <label class="lw-file">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 8a2 2 0 012-2h2l1.5-2h5L16 6h2a2 2 0 012 2v9a2 2 0 01-2 2H6a2 2 0 01-2-2z" /><circle cx="12" cy="12.5" r="3.5" /></svg>
          <span>{file ? file.name : 'Add a photo or video'}</span>
          <input type="file" accept="image/*,video/*" onchange={pick} hidden />
        </label>
        {#if preview}
          {#if file?.type.startsWith('video/')}
            <!-- svelte-ignore a11y_media_has_caption -->
            <video class="lw-preview" src={preview} controls playsinline muted></video>
          {:else}
            <img class="lw-preview" src={preview} alt="Preview of your photo" />
          {/if}
        {/if}

        <label class="lw-consent">
          <input type="checkbox" bind:checked={consent} />
          <span>I agree my message, photo or video may be shown on the wall and shared on the event's social media.</span>
        </label>

        {#if error}<p class="lw-err" role="alert">{error}</p>{/if}
        <button class="lw-btn" disabled={sending} onclick={send}>{sending ? (file ? `Sending… ${progress}%` : 'Sending…') : 'Send'}</button>
      {/if}
    </main>
  </div>
{/if}
