<script lang="ts">
  let { sponsor = null, donate = false }: { sponsor?: string | null; donate?: boolean } = $props(); // sponsor: brand overlay while the photo slides in; donate: dummy donate popup once it lands
  let donateOpen = $state(true);
  let thanksOpen = $state(false);
  let amount = $state(5);
  let src = $state<string | null>(null);
  let notFound = $state(false);
  let visible = $state(false);

  const caption = `${sponsor ? `Presented by ${sponsor}. ` : ''}My cartoon selfie from Creka Kiosk #creka`;

  let copied = $state<boolean | null>(null);

  // IG ignores caption passed via share/URL, so copy it for the user to paste.
  async function shareToIG() {
    try { await navigator.clipboard.writeText(caption); copied = true; } catch { copied = false; }
    // fetch during the 1s pause so the share sheet opens the moment it ends (keeps the tap's user activation fresh)
    const [blob] = await Promise.all([
      fetch(src!).then((r) => r.blob()),
      new Promise((r) => setTimeout(r, 1000)),
    ]);
    const file = new File([blob], 'creka.png', { type: 'image/png' });
    if (navigator.canShare?.({ files: [file] })) {
      await navigator.share({ files: [file], text: caption }).catch(() => {});
    } else {
      location.href = 'instagram://camera'; // no file share support: just open IG
    }
  }

  let sponsorShow = $state(false);
  $effect(() => {
    if (!sponsor || !visible) return;
    sponsorShow = true;
    const t = setTimeout(() => (sponsorShow = false), 5000); // matches the 5s slide-in
    return () => clearTimeout(t);
  });

  $effect(() => {
    const id = new URLSearchParams(location.search).get('id');
    src = id ? `/captures/demo/camwithnkob/${id}.png` : null;
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
    <img {src} alt="Captured" class:show={visible} onerror={() => (notFound = true)} />
    {#if visible}
      <a
        class="share"
        href={`https://wa.me/?text=${encodeURIComponent(`${caption}\n${location.href}`)}`}
        target="_blank"
        rel="noopener"
      >
        Share via WhatsApp
      </a>
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
  img {
    max-width: 90vw;
    max-height: 90vh;
    display: block;
    transform: translateY(-150vh);
    transition: transform 5s ease;
  }
  img.show {
    transform: translateY(0);
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
  .ig {
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
