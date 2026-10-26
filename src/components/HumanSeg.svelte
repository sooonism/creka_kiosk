<script lang="ts">
  import { onMount, onDestroy } from "svelte";

  let canvas: HTMLCanvasElement;
  let status = $state("Initializing...");
  let fps = $state(0);
  let error = $state<string | null>(null);

  let video: HTMLVideoElement | null = null;
  let stream: MediaStream | null = null;
  let segmenterInstance: any;
  let running = true;
  let frameCount = 0;
  let lastFpsUpdate = 0;

  let mode = $state<"silhouette" | "background" | "mask">("silhouette");

  const MODEL =
    "https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_segmenter/float16/latest/selfie_segmenter.tflite";
  const WASM_CDN = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@latest/wasm";

  onMount(async () => {
    try {
      await initSegmenter();
      await initCamera();
      status = "Segmenting...";
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
    if (segmenterInstance) segmenterInstance.close();
  });

  async function initSegmenter() {
    const { ImageSegmenter, FilesetResolver } = await import("@mediapipe/tasks-vision");
    const vision = await FilesetResolver.forVisionTasks(WASM_CDN);
    status = "Loading segmentation model...";
    segmenterInstance = await ImageSegmenter.createFromOptions(vision, {
      baseOptions: { modelAssetPath: MODEL, delegate: "GPU" },
      runningMode: "VIDEO",
      outputCategoryMask: true,
      outputConfidenceMasks: false,
    });
  }

  async function initCamera() {
    status = "Opening camera...";
    stream = await navigator.mediaDevices.getUserMedia({
      video: { width: { ideal: 640 }, height: { ideal: 480 }, facingMode: "user" },
      audio: false,
    });
    video = document.createElement("video");
    video.srcObject = stream;
    video.playsInline = true;
    video.muted = true;
    video.autoplay = true;
    await video.play();
    if (!canvas) return;
    canvas.width = video.videoWidth || 640;
    canvas.height = video.videoHeight || 480;
  }

  function startLoop() {
    function frame() {
      if (!running || !video || !segmenterInstance) return;
      if (video.readyState >= 2) {
        const now = performance.now();
        segmenterInstance.segmentForVideo(video, now, (result: any) => {
          drawFrame(result);
        });
        frameCount++;
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

  function drawFrame(result: any) {
    if (!video || !canvas) return;
    const ctx = canvas.getContext("2d")!;
    const w = canvas.width;
    const h = canvas.height;

    // Draw the mirrored video frame
    ctx.save();
    ctx.scale(-1, 1);
    ctx.drawImage(video, -w, 0, w, h);
    ctx.restore();

    if (!result?.categoryMask) return;

    const mask = result.categoryMask;
    const maskW = mask.width;
    const maskH = mask.height;
    const maskData = mask.getAsFloat32Array();

    if (!maskData || maskData.length === 0) return;

    // Get current canvas pixels
    const imageData = ctx.getImageData(0, 0, w, h);
    const pixels = imageData.data;

    // Scale: mask may be smaller than canvas (e.g. 256x256)
    const scaleX = maskW / w;
    const scaleY = maskH / h;

    if (mode === "silhouette") {
      // Person in color, background darkened + blurred effect (dark overlay)
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const mx = Math.round((w - 1 - x) * scaleX);
          const my = Math.round(y * scaleY);
          const mi = my * maskW + mx;
          const pi = (y * w + x) * 4;
          const isPerson = mi < maskData.length && maskData[mi] > 0.5;
          if (!isPerson) {
            // Darken background
            pixels[pi] = pixels[pi] * 0.15;
            pixels[pi + 1] = pixels[pi + 1] * 0.15;
            pixels[pi + 2] = pixels[pi + 2] * 0.15;
          }
        }
      }
    } else if (mode === "background") {
      // Full person silhouette on a solid dark background
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const mx = Math.round((w - 1 - x) * scaleX);
          const my = Math.round(y * scaleY);
          const mi = my * maskW + mx;
          const pi = (y * w + x) * 4;
          const isPerson = mi < maskData.length && maskData[mi] > 0.5;
          if (!isPerson) {
            pixels[pi] = 10;
            pixels[pi + 1] = 10;
            pixels[pi + 2] = 15;
          }
        }
      }
    } else if (mode === "mask") {
      // Show the raw mask as grayscale
      const maskImage = ctx.createImageData(w, h);
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const mx = Math.round((w - 1 - x) * scaleX);
          const my = Math.round(y * scaleY);
          const mi = my * maskW + mx;
          const pi = (y * w + x) * 4;
          const val = mi < maskData.length ? Math.round(maskData[mi] * 255) : 0;
          maskImage.data[pi] = val;
          maskImage.data[pi + 1] = val;
          maskImage.data[pi + 2] = val;
          maskImage.data[pi + 3] = 255;
        }
      }
      ctx.putImageData(maskImage, 0, 0);
      drawHUD(ctx, w, h);
      return;
    }

    ctx.putImageData(imageData, 0, 0);
    drawHUD(ctx, w, h);
  }

  function drawHUD(ctx: CanvasRenderingContext2D, w: number, h: number) {
    // FPS
    ctx.save();
    ctx.fillStyle = "rgba(0, 0, 0, 0.45)";
    ctx.beginPath();
    ctx.roundRect(12, 12, 70, 22, 6);
    ctx.fill();
    ctx.fillStyle = "#00dcff";
    ctx.font = "11px monospace";
    ctx.textBaseline = "middle";
    ctx.textAlign = "left";
    ctx.fillText(`${fps} fps`, 18, 23);

    // Mode label
    ctx.fillStyle = "rgba(0, 0, 0, 0.45)";
    ctx.beginPath();
    ctx.roundRect(12, 40, 100, 22, 6);
    ctx.fill();
    ctx.fillStyle = "#34d399";
    ctx.font = "10px monospace";
    ctx.textBaseline = "middle";
    ctx.textAlign = "left";
    ctx.fillText(mode, 18, 51);
    ctx.restore();

    // Status bar
    const barH = 28;
    const statusText = `●  ${status}`;
    ctx.font = "12px monospace";
    const sw = ctx.measureText(statusText).width;
    const barW = sw + 24;
    const bx = (w - barW) / 2;
    const by = h - 44;

    ctx.save();
    ctx.shadowColor = "rgba(0,0,0,0.5)";
    ctx.shadowBlur = 12;
    ctx.fillStyle = "rgba(0, 20, 40, 0.7)";
    ctx.beginPath();
    ctx.roundRect(bx, by, barW, barH, 14);
    ctx.fill();
    ctx.shadowBlur = 0;
    ctx.fillStyle = "#34d399";
    ctx.textBaseline = "middle";
    ctx.textAlign = "center";
    ctx.fillText(statusText, bx + barW / 2, by + barH / 2);
    ctx.restore();
  }
</script>

<div class="seg-page">
  <div class="seg-container">
    <canvas bind:this={canvas} class="seg-canvas"></canvas>
    {#if error}
      <div class="overlay error">
        <div class="overlay-icon">⚠️</div>
        <div class="overlay-text">{error}</div>
      </div>
    {/if}
  </div>
  <div class="seg-controls">
    <button
      class="mode-btn"
      class:active={mode === "silhouette"}
      onclick={() => mode = "silhouette"}
    >Silhouette</button>
    <button
      class="mode-btn"
      class:active={mode === "background"}
      onclick={() => mode = "background"}
    >Background</button>
    <button
      class="mode-btn"
      class:active={mode === "mask"}
      onclick={() => mode = "mask"}
    >Mask</button>
  </div>
  <div class="seg-footer">
    <span class="footer-label">Human Seg — selfie segmentation</span>
  </div>
</div>

<style>
  .seg-page {
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

  .seg-container {
    position: relative;
    background: #000;
    border-radius: 16px;
    overflow: hidden;
    box-shadow:
      0 0 60px rgba(0, 0, 0, 0.8),
      0 0 120px rgba(100, 100, 200, 0.06);
    flex-shrink: 0;
    max-width: 100%;
    max-height: calc(100vh - 140px);
    display: flex;
    align-items: center;
    justify-content: center;
  }

  .seg-canvas {
    display: block;
    max-width: 100%;
    max-height: calc(100vh - 140px);
    object-fit: contain;
    border-radius: 16px;
  }

  .seg-controls {
    display: flex;
    gap: 8px;
  }

  .mode-btn {
    padding: 8px 16px;
    border-radius: 8px;
    border: 1px solid rgba(255,255,255,0.08);
    background: rgba(255,255,255,0.04);
    color: #8b8fa3;
    font-family: monospace;
    font-size: 0.75rem;
    cursor: pointer;
    transition: background 0.15s, color 0.15s, border-color 0.15s;
  }

  .mode-btn:hover {
    background: rgba(255,255,255,0.08);
    color: #e1e4ea;
  }

  .mode-btn.active {
    background: rgba(52, 211, 153, 0.1);
    border-color: #34d399;
    color: #34d399;
  }

  .seg-footer {
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
