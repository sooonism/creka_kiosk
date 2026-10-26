<script lang="ts">
  let { sponsor = null }: { sponsor?: string | null } = $props(); // brand shown as an overlay while the photo slides in
  let src = $state<string | null>(null);
  let notFound = $state(false);
  let visible = $state(false);

  const caption = 'My cartoon selfie from Creka Kiosk #creka';

  // IG ignores caption passed via share/URL, so copy it for the user to paste.
  async function shareToIG() {
    try { await navigator.clipboard.writeText(caption); } catch {}
    const blob = await (await fetch(src!)).blob();
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
    <small>presented by</small>
    <strong>{sponsor}</strong>
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
        href={`https://wa.me/?text=${encodeURIComponent(location.href)}`}
        target="_blank"
        rel="noopener"
      >
        Share via WhatsApp
      </a>
      <button class="share ig" onclick={shareToIG}>Share to Instagram</button>
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
