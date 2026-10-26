<script lang="ts">
  import { onMount, onDestroy } from "svelte";

  let {
    onFaceCount,
    onFacePosition,
    onFaceSize,
    onReady,
    debug = true,
    aspect = 0,
  }: {
    onFaceCount?: (count: number) => void;
    onFacePosition?: (normalizedX: number) => void;
    onFaceSize?: (normalizedWidth: number) => void; // face box width / frame width
    onReady?: (canvas: HTMLCanvasElement) => void;
    debug?: boolean; // face boxes/keypoints + HUD overlays on the canvas
    aspect?: number; // w/h; crops the feed to this ratio and letterboxes it instead of cover-filling the screen (0 = off)
  } = $props();

  let canvas: HTMLCanvasElement;
  let status = $state("Initializing camera...");
  let faceCount = $state(0);
  let fps = $state(0);
  let error = $state<string | null>(null);

  // Hidden video element — created in JS, never appended to DOM
  let video: HTMLVideoElement | null = null;
  let stream: MediaStream | null = null;

  // source crop rect in video pixels (full frame unless aspect)
  let crop = { x: 0, y: 0, w: 640, h: 480 };

  // Detection state
  let frameCount = 0;
  let lastFpsUpdate = 0;

  // MediaPipe
  let faceDetectorInstance: any;
  let running = true;

  // vendored in public/mediapipe/ (copied from node_modules/@mediapipe/tasks-vision/wasm) so the kiosk doesn't need the network
  const MODEL_URL = "/mediapipe/blaze_face_short_range.tflite";
  const WASM_URL = "/mediapipe/";

  const STALL_MS = 3000; // no new video frame for this long -> restart the camera
  let starting = false;
  let loopStarted = false;
  let watchdog: any;
  let lastVideoTime = -1;
  let lastVideoChange = 0;
  const DETECT_MS = 100; // ~10 detections/s is plenty for presence + position
  let lastDetect = 0;
  let lastResult: any = {};

  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  onMount(() => {
    onReady?.(canvas);
    start();
    watchdog = setInterval(checkHealth, 1000);
  });

  onDestroy(() => {
    running = false;
    clearInterval(watchdog);
    releaseCamera();
    if (faceDetectorInstance) faceDetectorInstance.close();
  });

  function releaseCamera() {
    stream?.getTracks().forEach((t) => t.stop());
    stream = null;
    if (video) {
      video.pause();
      video.srcObject = null;
      video = null;
    }
  }

  // Camera first (so a model problem can't take it down), retry forever with capped backoff
  async function start() {
    if (starting) return;
    starting = true;
    for (let attempt = 0; running; attempt++) {
      try {
        await initCamera();
        if (!faceDetectorInstance) await initMediaPipe();
        if (!running) break;
        error = null;
        status = "Ready — looking for faces";
        lastVideoTime = -1;
        lastVideoChange = performance.now();
        if (!loopStarted) {
          loopStarted = true;
          startDetectionLoop();
        }
        break;
      } catch (e) {
        error = e instanceof Error ? e.message : "Unknown error";
        status = `Retrying (${attempt + 1})...`;
        releaseCamera();
        await sleep(Math.min(1000 * 2 ** attempt, 10000));
      }
    }
    starting = false;
  }

  // track ended (unplug/power save) or video frozen -> tear down and restart
  function checkHealth() {
    if (starting || !running || !video || !stream) return;
    const track = stream.getTracks()[0];
    const now = performance.now();
    if (video.currentTime !== lastVideoTime) {
      lastVideoTime = video.currentTime;
      lastVideoChange = now;
    }
    if (track?.readyState === "ended" || now - lastVideoChange > STALL_MS) {
      status = "Camera lost — restarting...";
      onFaceCount?.(0); // don't leave a stale "face present" while the feed is down
      releaseCamera();
      start();
    }
  }

  async function initMediaPipe() {
    const { FilesetResolver, FaceDetector } = await import(
      "@mediapipe/tasks-vision"
    );
    status = "Loading face model...";
    const vision = await FilesetResolver.forVisionTasks(WASM_URL);

    const create = (delegate: "GPU" | "CPU") =>
      FaceDetector.createFromOptions(vision, {
        baseOptions: { modelAssetPath: MODEL_URL, delegate },
        runningMode: "VIDEO",
        minDetectionConfidence: 0.5,
      });
    try {
      faceDetectorInstance = await create("GPU");
    } catch {
      faceDetectorInstance = await create("CPU"); // GPU delegate unavailable
    }
  }

  async function initCamera() {
    status = "Opening camera...";
    stream = await navigator.mediaDevices.getUserMedia({
      video: {
        width: { ideal: 1280 },
        height: { ideal: 720 },
        facingMode: "user",
      },
      audio: false,
    });
    if (!running) return releaseCamera();

    // Create hidden video element in JS only — never added to DOM
    video = document.createElement("video");
    video.srcObject = stream;
    video.playsInline = true;
    video.muted = true;
    video.autoplay = true;
    await video.play();

    // Sync canvas dimensions
    setCanvasSize();
  }

  function setCanvasSize() {
    if (!video || !canvas) return;
    const vw = video.videoWidth || 640;
    const vh = video.videoHeight || 480;
    crop = { x: 0, y: 0, w: vw, h: vh };
    if (aspect) {
      if (vw / vh > aspect) {
        crop.w = Math.round(vh * aspect);
        crop.x = (vw - crop.w) / 2;
      } else {
        crop.h = Math.round(vw / aspect);
        crop.y = (vh - crop.h) / 2;
      }
    }
    canvas.width = crop.w;
    canvas.height = crop.h;
  }

  function startDetectionLoop() {
    let animId: number;

    function detect() {
      if (!running) return;
      animId = requestAnimationFrame(detect); // scheduled first so a throw below can't kill the loop

      try {
        if (!faceDetectorInstance || !video || video.readyState < 2) return;
        const now = performance.now();

        // detection is the slow part: run it throttled, but paint the video every frame
        if (now - lastDetect >= DETECT_MS) {
          lastDetect = now;
          lastResult = faceDetectorInstance.detectForVideo(video, now);
          faceCount = lastResult.detections?.length ?? 0;
          onFaceCount?.(faceCount);

          const box = lastResult.detections?.[0]?.boundingBox;
          if (box && canvas.width) {
            // mirrored on screen, so flip the raw center before normalizing
            const mirroredCenterX = crop.w - (box.originX + box.width / 2 - crop.x);
            onFacePosition?.(mirroredCenterX / crop.w);
            onFaceSize?.(box.width / crop.w);
          }
        }

        // Single canvas: mirrored video + bbox/keypoints + HUD
        drawFrame(lastResult);

        frameCount++;
        if (now - lastFpsUpdate > 1000) {
          fps = Math.round((frameCount * 1000) / (now - lastFpsUpdate));
          frameCount = 0;
          lastFpsUpdate = now;
        }
      } catch (e) {
        console.error("detect frame failed", e);
      }
    }

    animId = requestAnimationFrame(detect);
  }

  function drawFrame(result: any) {
    if (!video) return;
    const ctx = canvas.getContext("2d")!;
    const w = canvas.width;
    const h = canvas.height;

    // 1. Mirrored camera feed
    ctx.save();
    ctx.scale(-1, 1);
    ctx.drawImage(video, crop.x, crop.y, crop.w, crop.h, -w, 0, w, h);
    ctx.restore();

    if (!debug) return;

    // 2. Face boxes + keypoints (mirrored coords to match)
    if (result.detections) {
      for (const detection of result.detections) {
        drawFaceBox(ctx, detection, w, h);
      }
    }

    // 3. HUD overlays
    drawVersionBadge(ctx, w, h);
    drawFaceIndicator(ctx, w, h, result.detections?.length ?? 0);
    drawCamStatusBar(ctx, w, h);
  }

  function drawVersionBadge(ctx: CanvasRenderingContext2D, w: number, h: number) {
    ctx.save();
    ctx.fillStyle = "rgba(0, 0, 0, 0.4)";
    ctx.beginPath();
    ctx.roundRect(12, 12, 56, 24, 6);
    ctx.fill();
    ctx.fillStyle = "#666";
    ctx.font = "11px monospace";
    ctx.textBaseline = "middle";
    ctx.textAlign = "center";
    ctx.fillText("v0.2.0", 12 + 28, 12 + 12);
    ctx.restore();
  }

  function drawFaceIndicator(ctx: CanvasRenderingContext2D, w: number, h: number, count: number) {
    const padding = 16;
    const cardW = 200;
    const cardH = 44;
    const x = w - padding - cardW;
    const y = padding + 8;
    ctx.save();
    ctx.shadowColor = "rgba(0,0,0,0.4)";
    ctx.shadowBlur = 12;
    ctx.fillStyle = "rgba(0, 0, 0, 0.55)";
    ctx.beginPath();
    ctx.roundRect(x, y, cardW, cardH, 10);
    ctx.fill();
    ctx.shadowBlur = 0;
    if (count === 0) {
      ctx.fillStyle = "#555";
      ctx.font = "14px system-ui, -apple-system, sans-serif";
      ctx.textBaseline = "middle";
      ctx.fillText("😶  No face detected", x + 12, y + cardH / 2);
    } else {
      ctx.fillStyle = "#8b8fa3";
      ctx.font = "14px system-ui, -apple-system, sans-serif";
      ctx.textBaseline = "middle";
      ctx.fillText(`😀  ${count} face${count > 1 ? "s" : ""}`, x + 12, y + cardH / 2);
      ctx.fillStyle = "#00ff88";
      ctx.beginPath();
      ctx.arc(x + cardW - 20, y + cardH / 2, 6, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }

  function drawCamStatusBar(ctx: CanvasRenderingContext2D, w: number, h: number) {
    const barH = 32;
    const pad = 12;
    const fpsText = `${fps} fps`;
    const dotText = faceCount > 0 ? "●" : "○";
    const statusText = `${dotText}  ${status}`;
    ctx.font = "13px monospace";
    const statusW = ctx.measureText(statusText).width;
    const fpsW = ctx.measureText(fpsText).width;
    const barW = statusW + fpsW + pad * 4;
    const bx = (w - barW) / 2;
    const by = h - 48;
    ctx.save();
    ctx.shadowColor = "rgba(0,0,0,0.4)";
    ctx.shadowBlur = 12;
    ctx.fillStyle = "rgba(0, 0, 0, 0.55)";
    ctx.beginPath();
    ctx.roundRect(bx, by, barW, barH, 16);
    ctx.fill();
    ctx.shadowBlur = 0;
    ctx.fillStyle = faceCount > 0 ? "#00ff88" : "#555";
    ctx.textBaseline = "middle";
    ctx.fillText(dotText, bx + pad, by + barH / 2);
    ctx.fillStyle = "#ccc";
    ctx.fillText(status, bx + pad + 16, by + barH / 2);
    ctx.fillStyle = "#666";
    ctx.fillText(fpsText, bx + barW - pad - fpsW, by + barH / 2);
    ctx.restore();
  }

  function drawFaceBox(
    ctx: CanvasRenderingContext2D,
    detection: any,
    w: number,
    h: number
  ) {
    const box = detection.boundingBox;
    if (box) {
      const x = w - box.originX - box.width; // mirror
      ctx.strokeStyle = "#00ff88";
      ctx.lineWidth = 2;
      ctx.strokeRect(x, box.originY, box.width, box.height);
    }

    for (const kp of detection.keypoints ?? []) {
      const x = w - kp.x * w;
      const y = kp.y * h;
      ctx.beginPath();
      ctx.arc(x, y, 3, 0, Math.PI * 2);
      ctx.fillStyle = "#00ff88";
      ctx.fill();
    }
  }
</script>

<div class="cam-container">
  <!-- Only the canvas renders — video lives in JS memory, never in the DOM -->
  <canvas bind:this={canvas} class="cam-canvas" class:fixed={!!aspect} style:--aspect={aspect || null}></canvas>

  {#if error}
    <div class="overlay error">
      <div class="overlay-icon">⚠️</div>
      <div class="overlay-text">{error}</div>
    </div>
  {/if}
</div>

<style>
  .cam-container {
    position: fixed;
    inset: 0;
    background: #000;
    overflow: hidden;
  }

  .cam-canvas {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    object-fit: cover;
  }

  .cam-canvas.fixed {
    inset: auto;
    top: 50%;
    left: 50%;
    width: min(100vw - 40px, (100vh - 40px) * var(--aspect)); /* 20px padding all round */
    height: auto;
    aspect-ratio: var(--aspect);
    transform: translate(-50%, -50%);
    object-fit: contain;
  }

  .overlay {
    position: absolute;
    inset: 0;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    background: rgba(0, 0, 0, 0.8);
    z-index: 10;
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
