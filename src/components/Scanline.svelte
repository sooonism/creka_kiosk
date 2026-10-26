<script lang="ts">
  import { onMount, onDestroy } from "svelte";

  let canvas: HTMLCanvasElement;
  let status = $state("Initializing camera...");
  let fps = $state(0);
  let canvasWidth = $state(0);
  let canvasHeight = $state(0);
  let error = $state<string | null>(null);

  let video: HTMLVideoElement | null = null;
  let stream: MediaStream | null = null;
  let running = true;
  let frameCount = 0;
  let lastFpsUpdate = 0;

  onMount(async () => {
    try {
      await initCamera();
      status = "Scanning...";
      startLoop();
    } catch (e) {
      error = e instanceof Error ? e.message : "Unknown error";
      status = "Failed";
    }
  });

  onDestroy(() => {
    running = false;
    if (stream) stream.getTracks().forEach((t) => t.stop());
    if (video) { video.pause(); video.srcObject = null; }
  });

  async function initCamera() {
    status = "Opening camera...";
    stream = await navigator.mediaDevices.getUserMedia({
      video: { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: "user" },
      audio: false,
    });
    video = document.createElement("video");
    video.srcObject = stream;
    video.playsInline = true;
    video.muted = true;
    video.autoplay = true;
    await video.play();
    setCanvasSize();
  }

  function setCanvasSize() {
    if (!video || !canvas) return;
    const vw = video.videoWidth || 640;
    const vh = video.videoHeight || 480;
    canvas.width = vw;
    canvas.height = vh;
    canvasWidth = vw;
    canvasHeight = vh;
  }

  function startLoop() {
    function frame() {
      if (!running || !video) return;
      if (video.readyState >= 2) {
        const ctx = canvas.getContext("2d")!;
        const w = canvas.width;
        const h = canvas.height;

        // Mirror the webcam
        ctx.save();
        ctx.scale(-1, 1);
        ctx.drawImage(video, -w, 0, w, h);
        ctx.restore();

        frameCount++;
        const now = performance.now();
        if (now - lastFpsUpdate > 1000) {
          fps = Math.round((frameCount * 1000) / (now - lastFpsUpdate));
          frameCount = 0;
          lastFpsUpdate = now;
        }
      }
      requestAnimationFrame(frame);
    }
    requestAnimationFrame(frame);
  }
</script>

<div class="scanline-page">
  <div class="scanline-container">
    <canvas
      bind:this={canvas}
      class="scanline-canvas"
      style="width: {canvasWidth}px; height: {canvasHeight}px;"
    ></canvas>
    {#if error}
      <div class="overlay error">
        <div class="overlay-icon">⚠️</div>
        <div class="overlay-text">{error}</div>
      </div>
    {/if}
    <div class="scanline-hud">
      <span class="hud-fps">{fps} fps</span>
      <span class="hud-status">{status}</span>
    </div>
    <div class="scanline-crosshair">
      <div class="crosshair-h" />
      <div class="crosshair-v" />
    </div>
  </div>

  <div class="scanline-footer">
    <span class="footer-label">Scanline — live webcam feed</span>
  </div>
</div>

<style>
  .scanline-page {
    position: fixed;
    inset: 0;
    background: #0a0a0f;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    padding: 32px;
    gap: 16px;
  }

  .scanline-container {
    position: relative;
    background: #000;
    border-radius: 16px;
    overflow: hidden;
    box-shadow:
      0 0 60px rgba(0, 0, 0, 0.8),
      0 0 120px rgba(100, 100, 200, 0.06);
    flex-shrink: 0;
    max-width: 100%;
    max-height: calc(100vh - 100px);
    display: flex;
    align-items: center;
    justify-content: center;
  }

  .scanline-canvas {
    display: block;
    max-width: 100%;
    max-height: calc(100vh - 100px);
    object-fit: contain;
    border-radius: 16px;
  }

  /* ── HUD ── */
  .scanline-hud {
    position: absolute;
    top: 12px;
    left: 12px;
    display: flex;
    gap: 8px;
  }

  .hud-fps,
  .hud-status {
    background: rgba(0, 0, 0, 0.55);
    color: #888;
    font-family: monospace;
    font-size: 0.7rem;
    padding: 4px 10px;
    border-radius: 8px;
    backdrop-filter: blur(4px);
  }

  .hud-fps {
    color: #00dcff;
  }

  /* ── Crosshair ── */
  .scanline-crosshair {
    position: absolute;
    inset: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    pointer-events: none;
    opacity: 0.12;
  }

  .crosshair-h,
  .crosshair-v {
    position: absolute;
    background: #00dcff;
  }

  .crosshair-h {
    width: 40px;
    height: 1px;
  }

  .crosshair-v {
    width: 1px;
    height: 40px;
  }

  .scanline-footer {
    text-align: center;
    opacity: 0.4;
  }

  .footer-label {
    color: #666;
    font-size: 0.75rem;
    font-family: monospace;
    letter-spacing: 0.05em;
  }

  .overlay {
    position: absolute;
    inset: 0;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    background: rgba(0, 0, 0, 0.85);
    border-radius: 16px;
  }

  .overlay.error .overlay-icon {
    font-size: 3rem;
    margin-bottom: 1rem;
  }

  .overlay-text {
    color: #f87171;
    font-size: 1.2rem;
  }
</style>
