<script lang="ts">
  import { onMount, onDestroy } from "svelte";

  let {
    onFaceCount,
    onFacePosition,
    onFaceSize,
    onReady,
    onStatus,
    paint = true,
    lowPower = false,
    detectMs = 100,
    debug = true,
    aspect = 0,
  }: {
    onFaceCount?: (count: number) => void;
    onFacePosition?: (normalizedX: number, bothSides: boolean) => void; // bothSides: faces on the left and the right half at once
    onFaceSize?: (normalizedWidth: number) => void; // face box width / frame width
    onReady?: (canvas: HTMLCanvasElement) => void;
    onStatus?: (st: { camera: boolean; model: boolean }) => void; // camera stream live / face model loaded
    detectMs?: number; // how often a frame goes to the face worker
    lowPower?: boolean; // idle: ask the camera for 5 fps so the Pi isn't decoding 30 fps video nobody sees
    paint?: boolean; // false: keep detecting but skip drawing the canvas (it is covered)
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
  let worker: Worker | null = null;
  let modelReady = false;
  let misses = 0; // consecutive empty results
  let busy = false; // a frame is out at the worker; skip rather than queue
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
  const DETECT_W = 320; // frames are shrunk to this width before they cross to the worker (the model sees 128px anyway)
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
    worker?.terminate();
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
        if (!worker) await initMediaPipe();
        if (!running) break;
        error = null;
        status = "Ready — looking for faces";
        lastVideoTime = -1;
        lastVideoChange = performance.now();
        reportStatus();
        if (!loopStarted) {
          loopStarted = true;
          startDetectionLoop();
        }
        break;
      } catch (e) {
        error = e instanceof Error ? e.message : "Unknown error";
        status = `Retrying (${attempt + 1})...`;
        releaseCamera();
        reportStatus();
        await sleep(Math.min(1000 * 2 ** attempt, 10000));
      }
    }
    starting = false;
  }

  const applyFps = () =>
    stream?.getVideoTracks()[0]?.applyConstraints({ frameRate: { ideal: lowPower ? 5 : 30 } }).catch(() => {});
  $effect(() => {
    lowPower; // re-run on change
    applyFps();
  });

  const reportStatus = () => onStatus?.({ camera: !!stream, model: modelReady });

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
      reportStatus();
      start();
    }
  }

  // detection lives in public/mediapipe/face-worker.js; resolves once the model is loaded
  function initMediaPipe() {
    status = "Loading face model...";
    const w = new Worker("/mediapipe/face-worker.js");
    return new Promise<void>((resolve, reject) => {
      w.onmessage = ({ data }) => {
        if (data.type === "ready") {
          worker = w;
          modelReady = true;
          reportStatus();
          resolve();
        } else if (data.type === "result") {
          busy = false;
          onResult(data);
        } else {
          busy = false;
          if (!worker) {
            w.terminate();
            reject(new Error(data.message));
          } else console.error("face worker", data.message);
        }
      };
      w.onerror = (e) => {
        if (!worker) {
          w.terminate();
          reject(new Error(e.message || "face worker failed"));
        }
      };
    });
  }

  // worker result -> same callbacks as before. Boxes arrive in the shrunk frame; scale them to the canvas
  function onResult({ w, detections }: { w: number; detections: any[] }) {
    const k = canvas.width / w;
    lastResult = {
      detections: detections.map((d) => ({
        ...d,
        boundingBox: d.boundingBox && {
          originX: d.boundingBox.originX * k,
          originY: d.boundingBox.originY * k,
          width: d.boundingBox.width * k,
          height: d.boundingBox.height * k,
        },
      })),
    };
    // at ~1 sample/s one empty result (a blink, a head turn) mustn't read as "left": needs two in a row
    misses = detections.length ? 0 : misses + 1;
    if (detections.length || misses >= (detectMs >= 500 ? 2 : 1)) {
      faceCount = detections.length;
      onFaceCount?.(faceCount);
    }
    const box = detections[0]?.boundingBox;
    if (box) {
      // mirrored on screen, so flip the center before normalizing
      const xs = detections.map((d) => 1 - (d.boundingBox.originX + d.boundingBox.width / 2) / w);
      onFacePosition?.(xs[0], xs.some((x) => x < 0.5) && xs.some((x) => x > 0.5));
      onFaceSize?.(box.width / w);
    }
  }

  // crop + shrink the current frame and hand it to the worker (the bitmap is transferred, not copied)
  async function sendFrame() {
    if (!video || !worker) return;
    busy = true;
    try {
      const bmp = await createImageBitmap(video, crop.x, crop.y, crop.w, crop.h, {
        resizeWidth: DETECT_W,
        resizeHeight: Math.round((DETECT_W * crop.h) / crop.w),
      });
      worker.postMessage({ bmp }, [bmp]);
    } catch (e) {
      busy = false;
      console.error("send frame failed", e);
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

    applyFps(); // a restarted camera starts at full rate
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
        if (!worker || !video || video.readyState < 2) return;
        const now = performance.now();

        // detection runs in the worker; here we only post a frame every detectMs
        if (!busy && now - lastDetect >= detectMs) {
          lastDetect = now;
          sendFrame();
        }

        // Single canvas: mirrored video + bbox/keypoints + HUD
        if (paint) drawFrame(lastResult);

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
