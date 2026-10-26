<script lang="ts">
  import { onMount, onDestroy } from "svelte";
  import CamWithMe from "./CamWithMe.svelte";

  let { src }: { src: string } = $props();
  let faceDetected = $state(false);
  let faceOnRight = $state(false);
  let camCanvas: HTMLCanvasElement | null = null;
  let nkobEl: HTMLImageElement;
  let previewCanvas: HTMLCanvasElement;

  let translateX = $derived(faceOnRight ? -100 : 100);
  let translateY = $derived(faceDetected ? 0 : 400);
  let rotate = $derived(faceOnRight ? 15 : -15);

  let flashOpacity = $state(0);
  let flashTransitioning = $state(false);
  let capturedSrc = $state<string | null>(null);
  let capturedPhase = $state<"hidden" | "shown" | "exiting">("hidden");
  let capturedInstant = $state(false);
  let capturedExitTimer: any = null;
  let savedPhotoId = $state<string | null>(null);

  let previewLoopId = 0;

  // Kiosk flow: idle -> waking -> reveal -> countdown -> snapped -> idle
  const STAGES = ["idle", "waking", "reveal", "countdown", "snapped"] as const;
  type Stage = (typeof STAGES)[number];
  let stage = $state<Stage>("idle");
  let mode = $state<"actual" | "debug">("actual");
  let count = $state(5);
  let stageTimer: any = null;
  let countTimer: any = null;

  function setStage(next: Stage) {
    clearTimeout(stageTimer);
    clearInterval(countTimer);
    stage = next;
    if (next === "waking") {
      stageTimer = setTimeout(() => setStage("reveal"), 2000); // pause before the slide-out
    } else if (next === "reveal") {
      stageTimer = setTimeout(() => setStage("countdown"), 1000); // matches overlay slide duration
    } else if (next === "countdown") {
      if (mode === "debug") return setStage("snapped");
      count = 5;
      countTimer = setInterval(() => {
        if (--count <= 0) setStage("snapped");
      }, 1000);
    } else if (next === "snapped") {
      triggerFlash();
      stageTimer = setTimeout(() => setStage("idle"), 14000); // 11s hold + 3s slide-out
    }
  }

  // face held in frame for 1s while idle -> wake up
  $effect(() => {
    if (stage !== "idle" || !faceDetected) return;
    const t = setTimeout(() => setStage("waking"), 1000);
    return () => clearTimeout(t);
  });

  onMount(() => {
    const loop = () => {
      drawPreview();
      previewLoopId = requestAnimationFrame(loop);
    };
    previewLoopId = requestAnimationFrame(loop);
  });

  onDestroy(() => {
    if (previewLoopId) cancelAnimationFrame(previewLoopId);
    if (capturedExitTimer) clearTimeout(capturedExitTimer);
    clearTimeout(stageTimer);
    clearInterval(countTimer);
  });

  // Canvas #2: a live composite (cam feed + nkob) rendered every frame so it
  // can be previewed continuously, separate from CamWithMe's own render canvas.
  function drawPreview() {
    if (!camCanvas || !previewCanvas || !nkobEl) return;
    const ctx = previewCanvas.getContext("2d");
    if (!ctx) return;

    if (previewCanvas.width !== camCanvas.width || previewCanvas.height !== camCanvas.height) {
      previewCanvas.width = camCanvas.width;
      previewCanvas.height = camCanvas.height;
    }

    ctx.drawImage(camCanvas, 0, 0);

    const camRect = camCanvas.getBoundingClientRect();
    if (!camRect.width || !camRect.height) return;
    // camCanvas renders with object-fit:cover, so its on-screen box and its
    // internal buffer can have different aspect ratios — map between them with
    // a single uniform "cover" scale, not independent X/Y factors (that stretched nkob)
    const coverScale = Math.max(
      previewCanvas.width / camRect.width,
      previewCanvas.height / camRect.height
    );
    const offsetX = (previewCanvas.width - camRect.width * coverScale) / 2;
    const offsetY = (previewCanvas.height - camRect.height * coverScale) / 2;

    // measure nkob's unrotated box this frame by zeroing rotation for one synchronous read
    const prevTransition = nkobEl.style.transition;
    const liveTransform = nkobEl.style.transform;
    nkobEl.style.transition = "none";
    nkobEl.style.transform = liveTransform.replace(/rotate\([^)]*\)/, "rotate(0deg)");
    const rect = nkobEl.getBoundingClientRect();
    nkobEl.style.transform = liveTransform;
    void nkobEl.offsetWidth; // force reflow before restoring the transition
    nkobEl.style.transition = prevTransition;

    const cx = (rect.left + rect.width / 2 - camRect.left) * coverScale + offsetX;
    const cy = (rect.top + rect.height / 2 - camRect.top) * coverScale + offsetY;
    const dw = rect.width * coverScale;
    const dh = rect.height * coverScale;

    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate((rotate * Math.PI) / 180);
    ctx.drawImage(nkobEl, -dw / 2, -dh / 2, dw, dh);
    ctx.restore();
  }

  function triggerFlash() {
    captureNow();

    flashTransitioning = false;
    flashOpacity = 1;
    // double rAF: force the instant opacity:1 to paint before switching on the slow fade
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        flashTransitioning = true;
        flashOpacity = 0;
      });
    });
  }

  function captureNow() {
    if (!previewCanvas) return;
    capturedSrc = buildFramedCapture();

    if (capturedExitTimer) clearTimeout(capturedExitTimer);
    // snap instantly back to the above-top-right origin (no transition) in case
    // it's mid-exit from a previous capture, then let the next frame animate in
    capturedInstant = true;
    capturedPhase = "hidden";
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        capturedInstant = false;
        capturedPhase = "shown";
        // 3s slide-in + 8s hold, then slide out
        capturedExitTimer = setTimeout(() => {
          capturedPhase = "exiting";
        }, 11000);
      });
    });

    saveCapture(capturedSrc);
  }

  // Bakes the white polaroid border + "Hello World" caption into the actual
  // PNG, matching the .preview-frame proportions (280px reference width) so
  // the saved file looks the same as the on-screen frame, not just the raw feed.
  function buildFramedCapture(): string {
    const scale = previewCanvas.width / 280;
    const border = 12 * scale;
    const bottom = 128 * scale;
    const w = previewCanvas.width + border * 2;
    const h = previewCanvas.height + border + bottom;

    const out = document.createElement("canvas");
    out.width = w;
    out.height = h;
    const ctx = out.getContext("2d")!;
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, w, h);
    ctx.drawImage(previewCanvas, border, border);

    ctx.fillStyle = "#333";
    ctx.font = `600 ${16 * scale}px system-ui, -apple-system, sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText("Hello World", w / 2, h - bottom / 2);

    return out.toDataURL("image/png");
  }

  async function saveCapture(image: string) {
    savedPhotoId = null;
    const res = await fetch("/api/save-capture", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ image }),
    });
    if (!res.ok) return;
    const { id } = await res.json();
    savedPhotoId = id;
  }
</script>

<CamWithMe
  onFaceCount={(count) => (faceDetected = count > 0)}
  onFacePosition={(x) => (faceOnRight = x > 0.5)}
  onReady={(canvas) => (camCanvas = canvas)}
/>
<div class="slot">
  <img
    bind:this={nkobEl}
    {src}
    alt="Nkob"
    style="transform: translateX({translateX}%) translateY({translateY}%) rotate({rotate}deg) scale(4);"
  />
</div>

<div class="cover" class:out={stage !== "idle" && stage !== "waking"}>
  <img class="cover-nkob" {src} alt="Nkob" />
  <div class="cover-text">{stage === "waking" ? "waking up..." : "idling..."}</div>
</div>

{#if stage === "countdown"}
  <div class="countdown">{count}</div>
{/if}

<aside class="debug">
  <h4>Debug</h4>
  <div class="row">
    {#each ["actual", "debug"] as m}
      <button class:active={mode === m} onclick={() => (mode = m as typeof mode)}>{m}</button>
    {/each}
  </div>
  <small>{mode === "actual" ? "5s countdown, then snap" : "countdown skipped, snaps instantly"}</small>
  <h4>Stage</h4>
  {#each STAGES as s}
    <button class:active={stage === s} onclick={() => setStage(s)}>{s}</button>
  {/each}
  <h4>Capture</h4>
  <button onclick={triggerFlash}>Debug Capture</button>
  {#if savedPhotoId}
    <a href={`/photo?id=${savedPhotoId}`} target="_blank">View saved photo</a>
  {/if}
</aside>

<div class="preview-frame">
  <canvas bind:this={previewCanvas} class="preview"></canvas>
  <div class="preview-caption">Hello World</div>
</div>

{#if capturedSrc}
  <div
    class="captured"
    class:show={capturedPhase === "shown"}
    class:exiting={capturedPhase === "exiting"}
    class:instant={capturedInstant}
  >
    <img src={capturedSrc} alt="Captured" />
  </div>
{/if}

<div
  class="flash"
  style="opacity: {flashOpacity}; transition: {flashTransitioning ? 'opacity 2s ease' : 'none'};"
></div>

<style>
  .slot {
    position: fixed;
    inset: 0;
    z-index: 5;
    display: flex;
    align-items: center;
    justify-content: center;
    pointer-events: none;
    overflow: hidden;
  }
  img {
    max-width: 50%;
    max-height: 50%;
    transition: transform 0.4s ease;
  }
  .cover {
    position: fixed;
    inset: 0;
    z-index: 12;
    background: #000;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 24px;
    transition: transform 1s ease;
  }
  .cover.out {
    transform: translateY(-100%);
  }
  .cover-nkob {
    max-width: 40%;
    max-height: 40%;
    transition: none;
  }
  .cover-text {
    font: 600 28px system-ui, -apple-system, sans-serif;
    color: #aaa;
  }
  .countdown {
    position: fixed;
    inset: 0;
    z-index: 11;
    display: flex;
    align-items: center;
    justify-content: center;
    font: 700 32vmin system-ui, -apple-system, sans-serif;
    color: #fff;
    text-shadow: 0 0 40px rgba(0, 0, 0, 0.6);
    pointer-events: none;
  }
  .debug {
    position: fixed;
    top: 0;
    left: 0;
    bottom: 0;
    width: 180px;
    z-index: 30;
    padding: 12px;
    display: flex;
    flex-direction: column;
    gap: 6px;
    background: rgba(15, 17, 23, 0.85);
    color: #e1e4ea;
    font: 13px system-ui, -apple-system, sans-serif;
    overflow-y: auto;
  }
  .debug h4 {
    margin: 10px 0 2px;
    font-size: 11px;
    text-transform: uppercase;
    color: #8b8fa3;
  }
  .debug .row {
    display: flex;
    gap: 6px;
  }
  .debug .row button {
    flex: 1;
  }
  .debug button {
    font: 600 13px system-ui, -apple-system, sans-serif;
    padding: 8px 10px;
    border-radius: 6px;
    border: 1px solid #333;
    background: #1c1f2a;
    color: #e1e4ea;
    cursor: pointer;
  }
  .debug button.active {
    background: #a78bfa;
    color: #0f1117;
    border-color: #a78bfa;
  }
  .debug a {
    color: #a78bfa;
  }
  .preview-frame {
    display: none;
  }
  .preview {
    display: block;
    width: 100%;
    height: auto;
  }
  .preview-caption {
    position: absolute;
    bottom: 0;
    left: 0;
    right: 0;
    height: 128px;
    display: flex;
    align-items: center;
    justify-content: center;
    font: 600 16px system-ui, -apple-system, sans-serif;
    color: #333;
  }
  .flash {
    position: fixed;
    inset: 0;
    z-index: 20;
    background: #fff;
    pointer-events: none;
  }
  .captured {
    position: fixed;
    top: 24px;
    right: 24px;
    z-index: 15;
    width: 280px;
    border-radius: 6px;
    overflow: hidden;
    box-shadow: 0 10px 30px rgba(0, 0, 0, 0.4);
    transform: translate(0, -150vh);
    transition: transform 3s ease;
    pointer-events: none;
  }
  .captured.show {
    transform: translate(0, 0);
  }
  .captured.exiting {
    transform: translate(160vw, 0);
  }
  .captured.instant {
    transition: none;
  }
  .captured img {
    display: block;
    width: 100%;
    height: auto;
    max-width: none;
    max-height: none;
  }
</style>
