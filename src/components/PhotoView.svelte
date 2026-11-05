<script lang="ts">
  import { onMount } from 'svelte';
  let { sponsor = null, donate = false }: { sponsor?: string | null; donate?: boolean } = $props(); // sponsor: brand overlay while the photo slides in; donate: dummy donate popup once it lands
  let donateOpen = $state(true);
  let thanksOpen = $state(false);
  let amount = $state(5);
  let src = $state<string | null>(null);
  let notFound = $state(false);
  let visible = $state(false);

  const caption = `${sponsor ? `Presented by ${sponsor}. ` : ''}My cartoon selfie from Creka Kiosk #creka`;

  let copied = $state<boolean | null>(null);

  // count what the visitor does, per kiosk (the QR carries ?kiosk=<id>); a tap, not proof the share was sent
  function track(type: 'open' | 'whatsapp' | 'instagram') {
    const q = new URLSearchParams(location.search);
    const kiosk = q.get('kiosk');
    if (kiosk) fetch(`/api/event?kiosk=${kiosk}`, { method: 'POST', body: JSON.stringify({ type, photo: q.get('id') }), keepalive: true }).catch(() => {});
  }
  onMount(() => track('open'));

  // IG ignores caption passed via share/URL, so copy it for the user to paste.
  async function shareToIG() {
    track('instagram');
    try { await navigator.clipboard.writeText(caption); copied = true; } catch { copied = false; }
    // build the file during the 1s pause so the share sheet opens the moment it ends (keeps the tap's user activation fresh)
    const [file] = await Promise.all([photoFile(), new Promise((r) => setTimeout(r, 1000))]);
    if (navigator.canShare?.({ files: [file] })) {
      await navigator.share({ files: [file], text: caption }).catch(() => {});
    } else {
      location.href = 'instagram://camera'; // no file share support: just open IG
    }
  }

  // WhatsApp: attach the (doodled) image together with the link; no file share support: link-only wa.me
  async function shareToWA() {
    track('whatsapp');
    const text = `${caption}\n${location.href}`;
    const file = await photoFile();
    if (navigator.canShare?.({ files: [file] })) {
      await navigator.share({ files: [file], text }).catch(() => {});
    } else {
      window.open(`https://wa.me/?text=${encodeURIComponent(text)}`, '_blank', 'noopener');
    }
  }

  // doodle layer: a canvas over the photo at the photo's natural resolution
  let img = $state<HTMLImageElement>();
  let doodle = $state<HTMLCanvasElement>();
  let color = $state('#dd257e');
  let drawing = false;
  let hinted = $state(false); // hide the hint after the first stroke

  function sizeDoodle() {
    doodle!.width = img!.naturalWidth;
    doodle!.height = img!.naturalHeight;
  }

  function pos(e: PointerEvent) {
    const r = doodle!.getBoundingClientRect();
    return [((e.clientX - r.left) * doodle!.width) / r.width, ((e.clientY - r.top) * doodle!.height) / r.height];
  }

  function down(e: PointerEvent) {
    drawing = true;
    hinted = true;
    doodle!.setPointerCapture(e.pointerId);
    const ctx = doodle!.getContext('2d')!;
    ctx.strokeStyle = color;
    ctx.lineWidth = doodle!.width / 100;
    ctx.lineCap = ctx.lineJoin = 'round';
    ctx.beginPath();
    const [x, y] = pos(e);
    ctx.moveTo(x, y);
    ctx.lineTo(x + 0.1, y); // a tap leaves a dot
    ctx.stroke();
  }

  function move(e: PointerEvent) {
    if (!drawing) return;
    const ctx = doodle!.getContext('2d')!;
    const [x, y] = pos(e);
    ctx.lineTo(x, y);
    ctx.stroke();
  }

  // photo + doodle flattened into one PNG
  async function photoFile() {
    const c = document.createElement('canvas');
    c.width = doodle!.width;
    c.height = doodle!.height;
    const ctx = c.getContext('2d')!;
    ctx.drawImage(img!, 0, 0);
    ctx.drawImage(doodle!, 0, 0);
    const blob = await new Promise<Blob>((res) => c.toBlob((b) => res(b!), 'image/png'));
    return new File([blob], 'creka.png', { type: 'image/png' });
  }

  let sponsorShow = $state(false);
  $effect(() => {
    if (!sponsor || !visible) return;
    sponsorShow = true;
    const t = setTimeout(() => (sponsorShow = false), 5000); // matches the 5s slide-in
    return () => clearTimeout(t);
  });

  $effect(() => {
    const q = new URLSearchParams(location.search);
    const id = q.get('id');
    const kiosk = q.get('kiosk');
    src = id ? `/captures/demo/camwithnkob/${kiosk ? kiosk + '/' : ''}${id}.png` : null;
    if (src) {
      visible = false;
      const t = setTimeout(() => (visible = true), 1000);
      return () => clearTimeout(t);
    }
  });
</script>

{#if sponsor}
  <div class="sponsor" class:show={sponsorShow}>
    <div class="sponsor-box">
      <small>presented by</small>
      <strong>{sponsor}</strong>
    </div>
  </div>
{/if}

{#if donate && visible && donateOpen}
  <div class="donate-backdrop">
    <div class="donate-box">
      <strong>Support Creka</strong>
      <select bind:value={amount}>
        {#each [5, 10, 20, 50, 100] as n}
          <option value={n}>RM {n}</option>
        {/each}
      </select>
      <!-- dummy: no payment, just swaps to the thank-you popup -->
      <button onclick={() => { donateOpen = false; thanksOpen = true; }}>Donate</button>
    </div>
  </div>
{/if}

{#if thanksOpen}
  <div class="donate-backdrop" role="button" tabindex="0" onclick={() => (thanksOpen = false)} onkeydown={() => (thanksOpen = false)}>
    <div class="donate-box">
      <strong>Thank you for your donation!</strong>
      <small>Tap anywhere to close</small>
    </div>
  </div>
{/if}

<div class="wrap">
  <img class="logo" src="/img/demo/camwithnkob/nkoblogo_b.svg" alt="Nkob" />
  {#if !src}
    <p>No photo id given. Visit this page as <code>/photo?id=&lt;id&gt;</code>.</p>
  {:else if notFound}
    <p>No photo found for that id.</p>
  {:else}
    <div class="photo" class:show={visible}>
      <img bind:this={img} {src} alt="Captured" onload={sizeDoodle} onerror={() => (notFound = true)} />
      <canvas
        bind:this={doodle}
        onpointerdown={down}
        onpointermove={move}
        onpointerup={() => (drawing = false)}
        onpointercancel={() => (drawing = false)}
      ></canvas>
      {#if !hinted}<span class="hint">✏️ Doodle on me!</span>{/if}
    </div>
    {#if visible}
      <div class="tools">
        <input type="color" bind:value={color} aria-label="Doodle color" />
        <button class="share clear" onclick={sizeDoodle}>Clear</button>
      </div>
      <button class="share" onclick={shareToWA}>Share via WhatsApp</button>
      <button class="share ig" onclick={shareToIG}>Share to Instagram</button>
      {#if copied !== null}
        <p class="caption-note">{copied ? 'Caption copied. Paste it in Instagram:' : 'Copy this caption:'} {caption}</p>
      {/if}
    {/if}
  {/if}
</div>

<style>
  .wrap {
    min-height: 100vh;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 20px;
    background: #0f1117 url("/img/demo/camwithnkob/bg.png") center / cover no-repeat; /* same as the kiosk */
    color: #e1e4ea;
    font-family: system-ui, -apple-system, sans-serif;
    overflow: hidden;
  }
  .photo {
    position: relative;
    transform: translateY(-150vh);
    transition: transform 5s ease;
  }
  .photo.show {
    transform: translateY(0);
  }
  .photo img {
    max-width: 90vw;
    max-height: 80vh;
    display: block;
  }
  .photo canvas {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    touch-action: none; /* draw instead of scroll */
    cursor: crosshair;
  }
.hint {
    position: absolute;
    top: 10px;
    right: 10px;
    padding: 6px 14px;
    border-radius: 999px;
    background: rgba(15, 17, 23, 0.75);
    color: #fff;
    font: 600 13px system-ui, -apple-system, sans-serif;
    pointer-events: none; /* let strokes through */
  }
  .tools {
    display: flex;
    gap: 12px;
    align-items: center;
  }
  .clear {
    border: 0;
    cursor: pointer;
    background: #666;
  }
  .sponsor {
    position: fixed;
    inset: 0;
    z-index: 10;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 8px;
    background: rgba(15, 17, 23, 0.55);
    color: #fff;
    font-family: system-ui, -apple-system, sans-serif;
    opacity: 0;
    transition: opacity 0.5s ease;
    pointer-events: none;
  }
  .sponsor.show {
    opacity: 1;
  }
  .caption-note {
    position: fixed;
    top: 16px;
    left: 50%;
    transform: translateX(-50%);
    z-index: 20;
    width: min(90vw, 480px);
    margin: 0;
    padding: 12px 16px;
    border-radius: 12px;
    background: rgba(15, 17, 23, 0.92);
    color: #fff;
    font: 600 14px/1.4 system-ui, -apple-system, sans-serif;
    text-align: center;
    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.35);
  }
  .donate-backdrop {
    position: fixed;
    inset: 0;
    z-index: 30;
    display: flex;
    align-items: center;
    justify-content: center;
    background: rgba(15, 17, 23, 0.55);
  }
  .donate-box {
    display: flex;
    flex-direction: column;
    gap: 14px;
    width: min(85vw, 320px);
    padding: 24px;
    border-radius: 16px;
    background: #fff;
    color: #222;
    font-family: system-ui, -apple-system, sans-serif;
    text-align: center;
  }
  .donate-box select,
  .donate-box button {
    font: 600 16px system-ui, -apple-system, sans-serif;
    padding: 12px;
    border-radius: 8px;
    border: 1px solid #ccc;
  }
  .donate-box button {
    border: 0;
    background: #dd257e;
    color: #fff;
    cursor: pointer;
  }
  .sponsor-box {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 8px;
    padding: 4vmin 8vmin;
    border: 3px solid #fff;
    border-radius: 16px;
    background: rgba(15, 17, 23, 0.4);
  }
  .sponsor strong {
    font-size: 15vmin;
    letter-spacing: 0.05em;
  }
  img.logo {
    position: absolute;
    top: 4vh;
    left: 50%;
    width: min(50vw, 220px);
    max-width: none;
    max-height: none;
    transform: translateX(-50%); /* not the photo's slide-in */
    transition: none;
  }
  .ig,
  button.share {
    border: 0;
    cursor: pointer;
  }
  .share {
    display: inline-block;
    font: 600 14px system-ui, -apple-system, sans-serif;
    padding: 10px 20px;
    border-radius: 8px;
    background: #40a8de;
    color: #fff;
    text-decoration: none;
  }
</style>
