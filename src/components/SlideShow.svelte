<script lang="ts">
  let currentIndex = $state(0);
  let animating = $state(false);
  let autoPlay = $state(true);
  let timer: ReturnType<typeof setInterval> | null = null;

  let currentImg: HTMLImageElement;
  let nextImg: HTMLImageElement;

  const images = [
    { src: "/img/nkob.png",  label: "Nkob" },
    { src: "/img/goose.png", label: "Goose" },
    { src: "/img/fox.png",   label: "Fox" },
    { src: "/img/astro.svg", label: "Astro" },
    { src: "/img/background.svg", label: "Background" },
  ];

  // Pre-compute next index without mutating currentIndex yet
  let pendingIndex = $state(0);
  let pendingDir = $state(1);

  function slideTo(nextIdx: number, dir: number) {
    if (animating) return;
    pendingDir = dir;
    pendingIndex = nextIdx;

    // Animate current image out
    const outDir = dir === 1 ? "-30%" : "30%";
    const currentEl = currentImg;
    if (!currentEl) { currentIndex = nextIdx; return; }

    // Set next image source and position off-screen
    const nextEl = nextImg;
    nextEl.style.transform = dir === 1 ? "translateX(30%)" : "translateX(-30%)";
    nextEl.style.opacity = "0";
    nextImg.src = images[nextIdx].src;
    nextImg.alt = images[nextIdx].label;

    animating = true;

    // Animate out: current slides away
    const outAnim = currentEl.animate(
      [{ transform: "translateX(0)", opacity: 1 },
       { transform: dir === 1 ? "translateX(-30%)" : "translateX(30%)", opacity: 0 }],
      { duration: 300, easing: "ease-out", fill: "forwards" }
    );

    // Animate in: next slides in
    const inAnim = nextEl.animate(
      [{ transform: dir === 1 ? "translateX(30%)" : "translateX(-30%)", opacity: 0 },
       { transform: "translateX(0)", opacity: 1 }],
      { duration: 300, easing: "ease-out", fill: "forwards" }
    );

    inAnim.onfinish = () => {
      // Reset transforms
      currentEl.style.transform = "";
      currentEl.style.opacity = "";
      nextEl.style.transform = "";
      nextEl.style.opacity = "";
      currentIndex = nextIdx;
      animating = false;
    };
  }

  function next() {
    slideTo((currentIndex + 1) % images.length, 1);
  }

  function prev() {
    slideTo((currentIndex - 1 + images.length) % images.length, -1);
  }

  function goTo(i: number) {
    const dir = i > currentIndex ? 1 : -1;
    slideTo(i, dir);
  }

  function toggleAuto() {
    autoPlay = !autoPlay;
  }

  $effect(() => {
    if (timer) clearInterval(timer);
    if (autoPlay) {
      timer = setInterval(next, 3000);
    }
    return () => { if (timer) clearInterval(timer); };
  });
</script>

<div class="slideshow-page">
  <div class="slide-container">
    <img
      bind:this={currentImg}
      src={images[currentIndex].src}
      alt={images[currentIndex].label}
      class="slide-image"
    />
    <img
      bind:this={nextImg}
      src={images[currentIndex].src}
      alt=""
      class="slide-image next-slide"
    />
    <div class="slide-label">{images[currentIndex].label}</div>
  </div>

  <div class="controls">
    <button class="ctrl-btn" onclick={prev} tabindex="0">◀ Prev</button>
    <div class="dots">
      {#each images as _, i}
        <button
          class="dot"
          class:active={currentIndex === i}
          onclick={() => goTo(i)}
          tabindex="0"
        ></button>
      {/each}
    </div>
    <button class="ctrl-btn" onclick={next} tabindex="0">Next ▶</button>
    <button class="ctrl-btn auto-btn" class:active={autoPlay} onclick={toggleAuto} tabindex="0">
      {autoPlay ? "⏸ Pause" : "▶ Auto"}
    </button>
  </div>

  <div class="counter">{currentIndex + 1} / {images.length}</div>
</div>

<style>
  .slideshow-page {
    position: fixed;
    inset: 0;
    background: #0a0a0f;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 24px;
    padding: 32px;
  }

  .slide-container {
    position: relative;
    display: flex;
    align-items: center;
    justify-content: center;
    width: 90vw;
    height: 70vh;
    max-width: 90vw;
    max-height: 70vh;
    border-radius: 16px;
    overflow: hidden;
    box-shadow: 0 0 80px rgba(0,0,0,0.6);
    background: #111;
  }

  .slide-image {
    display: block;
    max-width: 100%;
    max-height: 100%;
    object-fit: contain;
    position: absolute;
  }

  .next-slide {
    pointer-events: none;
  }

  .slide-label {
    position: absolute;
    bottom: 12px;
    left: 50%;
    transform: translateX(-50%);
    background: rgba(0,0,0,0.6);
    color: #a78bfa;
    font-family: monospace;
    font-size: 0.8rem;
    padding: 4px 14px;
    border-radius: 8px;
    backdrop-filter: blur(4px);
    z-index: 10;
  }

  .controls {
    display: flex;
    gap: 12px;
    align-items: center;
  }

  .ctrl-btn {
    background: rgba(255,255,255,0.08);
    color: #8b8fa3;
    border: 1px solid rgba(255,255,255,0.1);
    border-radius: 8px;
    padding: 8px 18px;
    font-size: 14px;
    font-family: monospace;
    cursor: pointer;
    transition: 0.15s;
    outline: none;
  }

  .ctrl-btn:hover {
    background: rgba(255,255,255,0.15);
    color: #e1e4ea;
  }

  .ctrl-btn:focus-visible {
    outline: 2px solid rgba(167,139,250,0.6);
    outline-offset: 2px;
  }

  .auto-btn.active {
    background: rgba(167,139,250,0.2);
    color: #a78bfa;
    border-color: rgba(167,139,250,0.35);
  }

  .dots {
    display: flex;
    gap: 8px;
  }

  .dot {
    width: 10px;
    height: 10px;
    border-radius: 50%;
    border: 1px solid rgba(255,255,255,0.2);
    background: transparent;
    cursor: pointer;
    transition: 0.15s;
    outline: none;
  }

  .dot:hover {
    background: rgba(255,255,255,0.15);
  }

  .dot.active {
    background: #a78bfa;
    border-color: #a78bfa;
  }

  .dot:focus-visible {
    outline: 2px solid rgba(167,139,250,0.6);
    outline-offset: 2px;
  }

  .counter {
    color: #6b6f83;
    font-family: monospace;
    font-size: 0.75rem;
  }
</style>
