<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import '../styles/lovewall.css';
  import { TEMPLATES, SWATCHES, accentStyle, loadFonts, template } from '../lib/lovewall-theme';

  let { slug }: { slug: string } = $props();

  const MEDIA = import.meta.env.PUBLIC_BACKEND_URL ?? 'https://creka.online';
  const TOKEN_KEY = `lw-org-${slug}`;
  const TABS = ['pending', 'approved', 'rejected', 'hidden'] as const;
  const MODES = [
    ['review_video', 'Review videos only'],
    ['review_all', 'Review everything'],
    ['auto', 'Auto-approve all'],
  ];

  interface Msg { id: number; kind: string; author_name: string; body: string; media_path: string | null; poster_path: string | null; pinned: boolean; inserted_at: string; source: string }

  let token = $state('');
  let email = $state('');
  let otp = $state('');
  let codeSent = $state(false);
  let authError = $state('');

  let tab = $state<(typeof TABS)[number]>('pending');
  let items = $state<Msg[]>([]);
  let counts = $state<Record<string, number>>({});
  let settings = $state<any>(null);
  let wall = $state({ connected: false, fullscreen: false }); // what the open wall screen is really doing, reported by the wall itself
  let fsAsked = $state(false);
  let blocklist = $state('');
  let titleDraft = $state('');
  let subtitleDraft = $state('');
  let saved = $state('');
  let savedTimer: ReturnType<typeof setTimeout>;
  let error = $state('');
  let poll: ReturnType<typeof setInterval>;

  const url = (p: string | null) => (p ? MEDIA + p : '');

  // every call carries the organiser token; a 401 means it expired, so show the login again
  async function api(path: string, init: RequestInit = {}) {
    const res = await fetch(`/api/lovewall/${path}`, { ...init, headers: { 'Content-Type': 'application/json', 'x-organiser-token': token, ...init.headers } });
    if (res.status === 401) logout();
    return res;
  }

  async function login(step: 'request' | 'verify') {
    authError = '';
    const res = await fetch(`/api/lovewall/auth/${step}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, otp, slug }) }).catch(() => null);
    const j = await res?.json().catch(() => ({}));
    if (!res?.ok) return (authError = j?.message ?? 'Could not reach the server.');
    if (step === 'request') return (codeSent = true);
    token = j.data.token;
    try { localStorage.setItem(TOKEN_KEY, token); } catch {}
    refresh();
    poll = setInterval(refresh, 4000);
  }

  function logout() {
    token = '';
    codeSent = false;
    clearInterval(poll);
    try { localStorage.removeItem(TOKEN_KEY); } catch {}
  }

  async function refresh() {
    const res = await api(`${slug}/queue?status=${tab}`).catch(() => null);
    if (!res?.ok) return;
    const j = await res.json();
    items = j.data;
    counts = j.counts;
    wall = j.wall;
    if (wall.fullscreen || !wall.connected) fsAsked = false;
    if (!settings) {
      settings = j.settings;
      blocklist = j.settings.blocklist.join(', ');
      titleDraft = j.settings.title;
      subtitleDraft = j.settings.subtitle;
      TEMPLATES.forEach((t) => loadFonts(t.id)); // the picker previews every template
    }
  }

  async function act(ids: number[], action: string) {
    // removing from the list first keeps the queue snappy; the next poll corrects it if the call failed
    items = items.filter((m) => !ids.includes(m.id) || action === 'pin' || action === 'unpin');
    const res = await api(`${slug}/messages/bulk`, { method: 'POST', body: JSON.stringify({ ids, action }) });
    if (!res.ok) error = 'That did not go through, refreshing.';
    refresh();
  }

  async function save(patch: Record<string, unknown>) {
    const res = await api(`${slug}/settings`, { method: 'PATCH', body: JSON.stringify(patch) });
    if (res.ok) {
      settings = (await res.json()).settings;
      saved = 'Saved';
      clearTimeout(savedTimer);
      savedTimer = setTimeout(() => (saved = ''), 2000);
    } else error = res.status === 422 ? 'That value is not allowed.' : 'Could not save settings.';
  }

  // multipart, so no JSON content-type: the browser has to set the boundary itself
  // Fullscreen is the wall browser's call, so this sends a command (a fresh stamp) and the button follows what the wall reports back
  function toggleFullscreen() {
    const want = !wall.fullscreen;
    fsAsked = want;
    save({ fullscreen: want, fullscreen_at: Date.now() });
    setTimeout(refresh, 3500);
    setTimeout(() => (fsAsked = false), 60_000); // give up waiting if nobody taps the wall
  }

  async function uploadLogo(e: Event) {
    const input = e.target as HTMLInputElement;
    const f = input.files?.[0];
    if (!f) return;
    error = '';
    const fd = new FormData();
    fd.set('file', f);
    const res = await fetch(`/api/lovewall/${slug}/logo`, { method: 'POST', headers: { 'x-organiser-token': token }, body: fd });
    const j = await res.json().catch(() => ({}));
    if (res.ok) settings = j.settings;
    else error = j.message ?? 'Could not upload the logo.';
    input.value = '';
  }
  async function removeLogo() {
    const res = await fetch(`/api/lovewall/${slug}/logo`, { method: 'POST', headers: { 'x-organiser-token': token } });
    if (res.ok) settings = (await res.json()).settings;
  }

  async function clearWall() {
    if (!confirm('Take everything currently on the wall down? You can bring items back from the Hidden tab.')) return;
    const res = await api(`${slug}/queue?status=approved`);
    const ids = (await res.json()).data.map((m: Msg) => m.id);
    if (ids.length) await act(ids, 'hide');
  }

  // fast review: A approves, R rejects the first card in the queue
  function key(e: KeyboardEvent) {
    if (!token || tab !== 'pending' || !items.length || (e.target as HTMLElement).matches('input, textarea, select')) return;
    if (e.key === 'a') act([items[0].id], 'approve');
    if (e.key === 'r') act([items[0].id], 'reject');
  }

  function setTab(t: (typeof TABS)[number]) {
    tab = t;
    items = [];
    refresh();
  }

  onMount(() => {
    try { token = localStorage.getItem(TOKEN_KEY) ?? ''; } catch {}
    if (token) {
      refresh();
      poll = setInterval(refresh, 4000);
    }
  });
  onDestroy(() => clearInterval(poll));

  const ago = (iso: string) => {
    const m = Math.round((Date.now() - Date.parse(iso)) / 60000);
    return m < 1 ? 'just now' : m < 60 ? `${m} min ago` : `${Math.round(m / 60)} h ago`;
  };
  const SAMPLES = ['What a night. Congratulations to you both!', 'Best party we have been to all year.', 'Thank you for having us.'];
  const tile = $derived(accentStyle(settings?.accent));
  const texts = $derived(items.filter((m) => m.kind !== 'video').map((m) => m.id));
</script>

<svelte:window onkeydown={key} />

<div class="wrap">
  {#if !token}
    <div class="login">
      <h1>Organiser sign-in</h1>
      <p class="muted">Use the organiser email registered for this event. We'll email you a code.</p>
      <input type="email" placeholder="Email" bind:value={email} disabled={codeSent} />
      {#if codeSent}
        <input inputmode="numeric" placeholder="Code from your email" bind:value={otp} />
        <button onclick={() => login('verify')}>Sign in</button>
      {:else}
        <button onclick={() => login('request')}>Send code</button>
      {/if}
      {#if authError}<p class="err">{authError}</p>{/if}
    </div>
  {:else}
    <header>
      <h1>Lovewall</h1>
      <div class="links">
        <a href="/lovewall/{slug}/wall" target="_blank">Open wall ↗</a>
        <a href="/lovewall/{slug}" target="_blank">Guest page ↗</a>
        <button class="ghost" onclick={logout}>Sign out</button>
      </div>
    </header>

    {#if settings}
      <section class="look" aria-labelledby="look-h">
        <div class="look-top">
          <h2 id="look-h">Look</h2>
          <span class="saved" role="status">{saved}</span>
        </div>
        <p class="muted">One template styles the guest page and the wall. Changes appear on the wall within a few seconds.</p>

        <div class="tiles" role="radiogroup" aria-label="Template">
          {#each TEMPLATES as t}
            <button class="tile" role="radio" aria-checked={settings.template === t.id} class:on={settings.template === t.id} onclick={() => save({ template: t.id })}>
              <div class="lw lw-wall mini" data-theme={t.id} style="--u:1.7px;{tile}" aria-hidden="true">
                <div class="lw-head">
                  <div class="lw-titles">
                    <div class="lw-title">{titleDraft || 'Your event'}</div>
                    {#if subtitleDraft}<div class="lw-sub">{subtitleDraft}</div>{/if}
                  </div>
                  <div class="lw-orn"><i></i></div>
                </div>
                <div class="lw-grid">
                  {#each SAMPLES as txt}<div class="lw-card"><p>{txt}</p><span class="lw-by">A guest</span></div>{/each}
                </div>
              </div>
              <span class="tname">{t.name}</span>
              <span class="tfor">{t.for}</span>
            </button>
          {/each}
        </div>

        <div class="toggles">
          <button class="tgl" aria-pressed={wall.fullscreen} disabled={!wall.connected} onclick={toggleFullscreen}>
            <span class="track"><span class="knob"></span></span>
            <span class="tl">Wall fullscreen
              <small>{!wall.connected ? 'Wall is not open' : fsAsked ? 'Waiting for a tap on the wall screen' : wall.fullscreen ? 'On' : 'Off'}</small>
            </span>
          </button>
          <button class="tgl" aria-pressed={settings.show_qr} onclick={() => save({ show_qr: !settings.show_qr })}>
            <span class="track"><span class="knob"></span></span>
            <span class="tl">QR code on the wall <small>{settings.show_qr ? 'Shown' : 'Hidden'}</small></span>
          </button>
        </div>

        <div class="fields">
          <label>
            Event title
            <input maxlength="80" placeholder="e.g. Sarah &amp; Daniel · or · Acme Summit 2026" bind:value={titleDraft} onchange={() => save({ title: titleDraft.trim() })} />
          </label>
          <label>
            Subtitle
            <input maxlength="140" placeholder="e.g. 14 June · Cameron Highlands" bind:value={subtitleDraft} onchange={() => save({ subtitle: subtitleDraft.trim() })} />
          </label>

          <div class="accent">
            <span id="accent-l">Accent colour</span>
            <div class="swatches" role="group" aria-labelledby="accent-l">
              <button class="sw def" class:on={!settings.accent} onclick={() => save({ accent: '' })} title="Template default" style="background:{template(settings.template).accent}">
                <span class="sr">Template default</span>
              </button>
              {#each SWATCHES as c}
                <button class="sw" class:on={settings.accent === c} style="background:{c}" onclick={() => save({ accent: c })} title={c}><span class="sr">{c}</span></button>
              {/each}
              <label class="sw custom" title="Pick any colour">
                <input type="color" value={settings.accent || template(settings.template).accent} onchange={(e) => save({ accent: (e.target as HTMLInputElement).value })} />
                <span class="sr">Custom colour</span>
              </label>
            </div>
          </div>

          <div class="logo">
            <span>Logo</span>
            <div class="logo-row">
              {#if settings.logo_path}<img src={url(settings.logo_path)} alt="Current logo" />{/if}
              <label class="btnlike">
                {settings.logo_path ? 'Replace' : 'Upload logo'}
                <input type="file" accept="image/png,image/jpeg,image/webp" onchange={uploadLogo} hidden />
              </label>
              {#if settings.logo_path}<button class="ghost" onclick={removeLogo}>Remove</button>{/if}
            </div>
            <small>PNG, JPG or WebP up to 10 MB. A transparent PNG works on every template.</small>
          </div>
        </div>
      </section>
    {/if}

    {#if settings}
      <section class="settings">
        <label>
          Moderation
          <select value={settings.mode} onchange={(e) => save({ mode: (e.target as HTMLSelectElement).value })}>
            {#each MODES as [v, label]}<option value={v}>{label}</option>{/each}
          </select>
        </label>
        <label class="row">
          <input type="checkbox" checked={settings.submissions_open} onchange={(e) => save({ submissions_open: (e.target as HTMLInputElement).checked })} />
          Accepting messages
        </label>
        <label>
          Max video length (s)
          <input type="number" min="3" max="60" value={settings.max_video_s} onchange={(e) => save({ max_video_s: +(e.target as HTMLInputElement).value })} />
        </label>
        <label class="wide">
          Hold for review if text contains (comma separated)
          <input bind:value={blocklist} onchange={() => save({ blocklist: blocklist.split(',').map((w) => w.trim()).filter(Boolean) })} />
        </label>
        <button class="danger" onclick={clearWall}>Clear the wall</button>
      </section>
    {/if}

    <nav>
      {#each TABS as t}
        <button class:on={tab === t} onclick={() => setTab(t)}>{t} <b>{counts[t] ?? 0}</b></button>
      {/each}
    </nav>

    {#if error}<p class="err">{error}</p>{/if}

    {#if tab === 'pending' && texts.length > 1}
      <button class="bulk" onclick={() => act(texts, 'approve')}>Approve all {texts.length} text & photo items</button>
    {/if}

    <div class="list">
      {#each items as m (m.id)}
        <article>
          {#if m.kind === 'video'}
            <!-- svelte-ignore a11y_media_has_caption -->
            <video src={url(m.media_path)} poster={url(m.poster_path)} controls playsinline preload="metadata"></video>
          {:else if m.kind === 'photo'}
            <img src={url(m.media_path)} alt="" />
          {/if}
          {#if m.body}<p>{m.body}</p>{/if}
          <small>{m.author_name || 'A guest'} · {m.kind} · {m.source} · {ago(m.inserted_at)}{m.pinned ? ' · 📌' : ''}</small>
          <div class="btns">
            {#if tab !== 'approved'}<button class="ok" onclick={() => act([m.id], 'approve')}>Approve</button>{/if}
            {#if tab === 'pending'}<button class="no" onclick={() => act([m.id], 'reject')}>Reject</button>{/if}
            {#if tab === 'approved'}
              <button onclick={() => act([m.id], m.pinned ? 'unpin' : 'pin')}>{m.pinned ? 'Unpin' : 'Pin'}</button>
              <button class="no" onclick={() => act([m.id], 'hide')}>Hide</button>
            {/if}
          </div>
        </article>
      {:else}
        <p class="muted">Nothing {tab} right now.{tab === 'pending' ? ' Keys: A approve, R reject.' : ''}</p>
      {/each}
    </div>
  {/if}
</div>

<style>
  .wrap {
    min-height: 100vh;
    background: #0f1117;
    color: #e1e4ea;
    font-family: system-ui, -apple-system, sans-serif;
    padding: 16px;
    box-sizing: border-box;
    max-width: 880px;
    margin: 0 auto;
  }
  h1 {
    margin: 0;
    font-size: 22px;
  }
  header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 14px;
  }
  .links {
    display: flex;
    gap: 14px;
    align-items: center;
    font-size: 14px;
  }
  a {
    color: #8ab4ff;
  }
  .login {
    max-width: 360px;
    margin: 12vh auto 0;
    display: flex;
    flex-direction: column;
    gap: 12px;
  }
  .muted {
    opacity: 0.6;
    margin: 0;
  }
  input,
  select {
    background: #1a1d27;
    border: 1px solid #2c3040;
    border-radius: 8px;
    color: inherit;
    font: inherit;
    padding: 10px;
  }
  button {
    background: #2c3040;
    color: inherit;
    border: 0;
    border-radius: 8px;
    padding: 10px 14px;
    font: inherit;
    cursor: pointer;
  }
  .ghost {
    background: none;
    opacity: 0.6;
  }
  .settings {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
    gap: 12px;
    background: #151822;
    border-radius: 12px;
    padding: 14px;
    margin-bottom: 14px;
    align-items: end;
  }
  .settings label {
    display: flex;
    flex-direction: column;
    gap: 6px;
    font-size: 13px;
    opacity: 0.9;
  }
  .settings .row {
    flex-direction: row;
    align-items: center;
  }
  .wide {
    grid-column: 1 / -1;
  }
  nav {
    display: flex;
    gap: 8px;
    flex-wrap: wrap;
    margin-bottom: 12px;
  }
  nav button {
    text-transform: capitalize;
  }
  nav button.on {
    background: #e8456b;
  }
  .bulk {
    width: 100%;
    margin-bottom: 12px;
    background: #1f6f4a;
  }
  .list {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(260px, 1fr));
    gap: 12px;
  }
  article {
    background: #1a1d27;
    border-radius: 12px;
    padding: 12px;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  article img,
  article video {
    width: 100%;
    max-height: 300px;
    object-fit: contain;
    background: #000;
    border-radius: 8px;
  }
  article p {
    margin: 0;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }
  small {
    opacity: 0.55;
  }
  .btns {
    display: flex;
    gap: 8px;
  }
  .btns button {
    flex: 1;
  }
  .ok {
    background: #1f6f4a;
  }
  .no,
  .danger {
    background: #7a2a3a;
  }
  .err {
    color: #ff7b8f;
    margin: 0 0 8px;
    font-size: 14px;
  }
  .look {
    background: #151822;
    border-radius: 12px;
    padding: 16px;
    margin-bottom: 14px;
  }
  .look-top {
    display: flex;
    justify-content: space-between;
    align-items: baseline;
  }
  h2 {
    margin: 0 0 4px;
    font-size: 17px;
  }
  .saved {
    font-size: 13px;
    color: #6fd0a0;
    min-height: 1em;
  }
  .tiles {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(170px, 1fr));
    gap: 12px;
    margin: 14px 0;
  }
  .tile {
    display: flex;
    flex-direction: column;
    gap: 3px;
    text-align: left;
    padding: 8px 8px 10px;
    background: #1a1d27;
    border: 2px solid transparent;
    border-radius: 12px;
  }
  .tile.on {
    border-color: #e8456b;
  }
  .tile :global(.lw-wall.mini) {
    aspect-ratio: 16 / 9;
    height: auto;
    border-radius: 6px;
    margin-bottom: 6px;
    pointer-events: none;
  }
  .tname {
    font-weight: 600;
  }
  .tfor {
    font-size: 12.5px;
    opacity: 0.65;
  }
  .toggles {
    display: flex;
    gap: 10px;
    flex-wrap: wrap;
    margin-bottom: 16px;
  }
  .tgl {
    display: flex;
    align-items: center;
    gap: 12px;
    text-align: left;
    background: #1a1d27;
    border: 1px solid #2c3040;
    border-radius: 10px;
    padding: 10px 14px;
    min-width: 230px;
  }
  .tgl:disabled {
    opacity: 0.55;
    cursor: default;
  }
  .tgl .tl {
    display: flex;
    flex-direction: column;
    font-size: 14px;
  }
  .tgl small {
    opacity: 0.7;
    font-size: 12.5px;
  }
  .track {
    flex: none;
    width: 38px;
    height: 22px;
    border-radius: 11px;
    background: #3a4055;
    position: relative;
    transition: background 0.2s;
  }
  .knob {
    position: absolute;
    top: 3px;
    left: 3px;
    width: 16px;
    height: 16px;
    border-radius: 50%;
    background: #e1e4ea;
    transition: transform 0.2s cubic-bezier(0.22, 1, 0.36, 1);
  }
  .tgl[aria-pressed='true'] .track {
    background: #1f8a5b;
  }
  .tgl[aria-pressed='true'] .knob {
    transform: translateX(16px);
  }
  .fields {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
    gap: 14px;
    align-items: start;
  }
  .fields label,
  .accent,
  .logo {
    display: flex;
    flex-direction: column;
    gap: 6px;
    font-size: 13px;
  }
  .swatches {
    display: flex;
    gap: 8px;
    flex-wrap: wrap;
    align-items: center;
  }
  .sw {
    width: 32px;
    height: 32px;
    padding: 0;
    border-radius: 50%;
    border: 2px solid #0f1117;
    box-shadow: 0 0 0 1px #3a4055;
    position: relative;
    cursor: pointer;
  }
  .sw.on {
    box-shadow: 0 0 0 2px #e1e4ea;
  }
  .sw.def {
    outline: 1px dashed #e1e4ea;
    outline-offset: 2px;
  }
  .sw.custom {
    background: conic-gradient(#f44, #fd4, #4d8, #4af, #a4f, #f44);
    overflow: hidden;
  }
  .sw.custom input {
    position: absolute;
    inset: 0;
    opacity: 0;
    width: 100%;
    height: 100%;
    cursor: pointer;
  }
  .logo-row {
    display: flex;
    gap: 10px;
    align-items: center;
    flex-wrap: wrap;
  }
  .logo-row img {
    height: 40px;
    max-width: 120px;
    object-fit: contain;
    background: repeating-conic-gradient(#2a2e3b 0 25%, #1f2230 0 50%) 0 0 / 12px 12px;
    border-radius: 6px;
  }
  .btnlike {
    background: #2c3040;
    border-radius: 8px;
    padding: 10px 14px;
    cursor: pointer;
    font-size: 14px;
  }
  .sr {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip-path: inset(50%);
    white-space: nowrap;
  }
  button:focus-visible,
  .btnlike:focus-within,
  .sw:focus-within,
  input:focus-visible {
    outline: 2px solid #8ab4ff;
    outline-offset: 2px;
  }
</style>
