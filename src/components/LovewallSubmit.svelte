<script lang="ts">
  import { onMount } from 'svelte';

  let { slug }: { slug: string } = $props();

  // limits mirror the backend (CrekaCampaign.Lovewall); it enforces them, this just fails fast on a slow venue network
  const MAX_PHOTO = 10_000_000;
  const MAX_VIDEO = 30_000_000;

  let title = $state('');
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
      title = j.campaign.name;
      open = j.settings.submissions_open;
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

<div class="wrap">
  <main>
    <h1>{title || 'Love wall'}</h1>

    {#if sent}
      <div class="done">
        <div class="big">{sent === 'approved' ? '💌' : '🙏'}</div>
        <p>{sent === 'approved' ? 'Sent! Look out for it on the wall.' : 'Thanks! Your message will appear on the wall once the organiser approves it.'}</p>
        <button onclick={() => (sent = null)}>Send another</button>
      </div>
    {:else if !open}
      <p class="muted">Messages are closed for now.</p>
    {:else}
      <p class="muted">Leave a message, photo or short video for the wall.</p>
      <input placeholder="Your name (optional)" maxlength="40" bind:value={name} />
      <textarea placeholder="Your message" maxlength="500" rows="4" bind:value={body}></textarea>

      <label class="file">
        {file ? file.name : '📷 Add a photo or video'}
        <input type="file" accept="image/*,video/*" onchange={pick} hidden />
      </label>
      {#if preview}
        {#if file?.type.startsWith('video/')}
          <!-- svelte-ignore a11y_media_has_caption -->
          <video src={preview} controls playsinline muted></video>
        {:else}
          <img src={preview} alt="preview" />
        {/if}
      {/if}

      <label class="consent">
        <input type="checkbox" bind:checked={consent} />
        <span>I agree my message, photo or video may be shown on the wall and shared on the event's social media.</span>
      </label>

      {#if error}<p class="err">{error}</p>{/if}
      <button disabled={sending} onclick={send}>{sending ? (file ? `Sending… ${progress}%` : 'Sending…') : 'Send'}</button>
    {/if}
  </main>
</div>

<style>
  .wrap {
    min-height: 100vh;
    display: flex;
    justify-content: center;
    background: #0f1117;
    color: #e1e4ea;
    font-family: system-ui, -apple-system, sans-serif;
  }
  main {
    width: 100%;
    max-width: 440px;
    padding: 24px 16px 40px;
    display: flex;
    flex-direction: column;
    gap: 14px;
    box-sizing: border-box;
  }
  h1 {
    margin: 8px 0 0;
    font-size: 26px;
    text-align: center;
  }
  .muted {
    margin: 0;
    opacity: 0.65;
    text-align: center;
  }
  input:not([type]),
  textarea {
    background: #1a1d27;
    border: 1px solid #2c3040;
    border-radius: 10px;
    color: inherit;
    font: inherit;
    padding: 12px;
    resize: vertical;
  }
  .file {
    border: 1px dashed #3a4055;
    border-radius: 10px;
    padding: 14px;
    text-align: center;
    cursor: pointer;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  img,
  video {
    width: 100%;
    max-height: 320px;
    object-fit: contain;
    border-radius: 10px;
    background: #000;
  }
  .consent {
    display: flex;
    gap: 10px;
    font-size: 13px;
    opacity: 0.8;
    align-items: flex-start;
  }
  button {
    background: #e8456b;
    color: #fff;
    border: 0;
    border-radius: 10px;
    padding: 14px;
    font: inherit;
    font-weight: 600;
    cursor: pointer;
  }
  button:disabled {
    opacity: 0.6;
  }
  .err {
    margin: 0;
    color: #ff7b8f;
    font-size: 14px;
  }
  .done {
    text-align: center;
    display: flex;
    flex-direction: column;
    gap: 14px;
  }
  .big {
    font-size: 56px;
  }
</style>
