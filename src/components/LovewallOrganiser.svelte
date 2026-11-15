<script lang="ts">
  import { onMount, onDestroy } from 'svelte';

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
  let blocklist = $state('');
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
    if (!settings) {
      settings = j.settings;
      blocklist = j.settings.blocklist.join(', ');
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
    if (res.ok) settings = (await res.json()).settings;
    else error = 'Could not save settings.';
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
</style>
