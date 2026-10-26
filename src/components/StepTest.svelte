<script lang="ts">
  import { onMount, onDestroy } from "svelte";

  let canvas: HTMLCanvasElement;
  let status = $state("Initializing...");
  let error = $state<string | null>(null);

  // Camera
  let video: HTMLVideoElement | null = null;
  let stream: MediaStream | null = null;
  let videoWidth = $state(0);
  let videoHeight = $state(0);

  // MediaPipe
  let handLandmarker: any = null;
  let mpCanvas: HTMLCanvasElement | null = null;
  let running = true;
  let frameCount = 0;
  let detectFrameCount = 0;
  let lastFpsTime = 0;
  let lastDetectFpsTime = 0;
  let renderFps = $state(0);
  let detectFps = $state(0);
  let mpLabel = $state("MP: ...");

  const RESOLUTIONS = [80, 120, 160, 224, 320, 480, 640];
  const CANVAS_RES = [
    { label: "Full", dim: 0 },
    { label: "640",  dim: 640 },
    { label: "480",  dim: 480 },
    { label: "360",  dim: 360 },
    { label: "240",  dim: 240 },
    { label: "160",  dim: 160 },
  ];
  let mpDim = $state(80);
  let canvasMaxDim = $state(160); // 0 = full camera resolution
  let detectEveryNth = $state(10);
  let showSkeleton = $state(true);
  let showNkob = $state(true);

  // Camera resolution presets
  const CAM_RES = [
    { label: "Full", w: 0, h: 0 },
    { label: "640",  w: 640, h: 480 },
    { label: "480",  w: 480, h: 360 },
    { label: "320",  w: 320, h: 240 },
    { label: "240",  w: 240, h: 180 },
    { label: "160",  w: 160, h: 120 },
  ];
  let camResIndex = $state(4); // default 240×180

  // GPU / CPU delegate
  let delegate = $state<"GPU" | "CPU">("CPU");
  // Number of hands
  let numHands = $state(1);

  // Render framerate cap (0 = uncapped)
  const RENDER_FPS_OPTIONS = [
    { label: "60", fps: 0 },
    { label: "30", fps: 30 },
    { label: "24", fps: 24 },
    { label: "15", fps: 15 },
    { label: "10", fps: 10 },
    { label: "5",  fps: 5 },
  ];
  let targetRenderFps = $state(5);
  let lastRenderTime = 0;

  // CSS display scale (independent of canvas pixel resolution)
  const CSS_SCALES = [
    { label: "Fill", pct: 100 },
    { label: "75%",  pct: 75 },
    { label: "50%",  pct: 50 },
    { label: "25%",  pct: 25 },
  ];
  let cssScale = $state(100);

  // Preloaded images
  let nkobImg: HTMLImageElement | null = null;

  // Monotonically increasing timestamp for MediaPipe (avoids "timestamp mismatch" errors)
  let mpTimestamp = 0;

  const MODEL_URL = "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/latest/hand_landmarker.task";
  const WASM_CDN = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@latest/wasm";

  onMount(async () => {
    try {
      await initMediaPipe();
      await initCamera();

      // Preload nkob
      nkobImg = new Image();
      nkobImg.src = "/img/nkob.png";

      status = "Running";
      startLoop();
    } catch (e) {
      error = e instanceof Error ? e.message : "Unknown error";
      status = "Failed";
    }
  });

  onDestroy(() => {
    running = false;
    releaseCamera();
    if (handLandmarker) handLandmarker.close();
  });

  function releaseCamera() {
    if (stream) { stream.getTracks().forEach(t => t.stop()); stream = null; }
    if (video) { video.pause(); video.srcObject = null; video = null; }
  }

  async function initMediaPipe() {
    const { FilesetResolver, HandLandmarker: HL } = await import("@mediapipe/tasks-vision");
    status = "Loading model...";
    const vision = await FilesetResolver.forVisionTasks(WASM_CDN);
    try {
      handLandmarker = await HL.createFromOptions(vision, {
        baseOptions: { modelAssetPath: MODEL_URL, delegate },
        runningMode: "VIDEO",
        numHands,
      });
    } catch {
      if (delegate === "GPU") {
        status = "GPU failed, retrying CPU...";
        handLandmarker = await HL.createFromOptions(vision, {
          baseOptions: { modelAssetPath: MODEL_URL, delegate: "CPU" },
          runningMode: "VIDEO",
          numHands,
        });
      } else {
        throw new Error("Model failed on CPU");
      }
    }
  }

  async function initCamera() {
    status = "Opening camera...";

    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error("Camera not available. Make sure you're on HTTPS and the browser supports getUserMedia. On OrangePi, try Chromium with '--enable-usermedia-screen-capturing'");
    }

    const res = CAM_RES[camResIndex];
    const constraints: any = { facingMode: "user" };
    if (res.w > 0) { constraints.width = { ideal: res.w }; constraints.height = { ideal: res.h }; }
    stream = await navigator.mediaDevices.getUserMedia({
      video: constraints,
      audio: false,
    });
    video = document.createElement("video");
    video.srcObject = stream;
    video.playsInline = true;
    video.muted = true;
    video.autoplay = true;
    await video.play();

    videoWidth = video.videoWidth;
    videoHeight = video.videoHeight;
    applyCanvasSize();

    mpCanvas = document.createElement("canvas");
    resizeMpCanvas();
  }

  function applyCanvasSize() {
    if (canvasMaxDim === 0) {
      canvas.width = videoWidth;
      canvas.height = videoHeight;
    } else {
      const scale = Math.min(canvasMaxDim / Math.max(videoWidth, videoHeight), 1);
      canvas.width = Math.round(videoWidth * scale);
      canvas.height = Math.round(videoHeight * scale);
    }
  }

  function setCanvasDim(dim: number) {
    canvasMaxDim = dim;
    applyCanvasSize();
  }

  function resizeMpCanvas() {
    if (!mpCanvas || !videoWidth) return;
    const scale = Math.min(mpDim / Math.max(videoWidth, videoHeight), 1);
    mpCanvas.width = Math.round(videoWidth * scale);
    mpCanvas.height = Math.round(videoHeight * scale);
    mpLabel = `MP: ${mpCanvas.width}×${mpCanvas.height}`;
  }

  function setMpDim(dim: number) {
    mpDim = dim;
    resizeMpCanvas();
  }

  let detectCounter = 0;
  let lastResult: any = null;

  function startLoop() {
    function frame() {
      if (!running || !video || !canvas) return;
      const ctx = canvas.getContext("2d")!;
      const w = canvas.width;
      const h = canvas.height;

      if (video.readyState >= 2 && handLandmarker) {
        frameCount++;
        detectCounter++;

        const now = performance.now();
        const minInterval = targetRenderFps > 0 ? 1000 / targetRenderFps : 0;
        const shouldRender = minInterval === 0 || (now - lastRenderTime >= minInterval);

        // Detection (every Nth frame) — runs regardless of render cap
        if (detectCounter % detectEveryNth === 0) {
          const mpCtx = mpCanvas!.getContext("2d")!;
          mpCtx.drawImage(video, 0, 0, mpCanvas!.width, mpCanvas!.height);

          mpTimestamp += 1000;
          lastResult = handLandmarker.detectForVideo(mpCanvas!, mpTimestamp);

          detectFrameCount++;
          if (now - lastDetectFpsTime > 1000) {
            detectFps = Math.round((detectFrameCount * 1000) / (now - lastDetectFpsTime));
            detectFrameCount = 0;
            lastDetectFpsTime = now;
          }
        }

        // Render (capped at target fps)
        if (shouldRender) {
          lastRenderTime = now;

          // Draw mirrored video
          ctx.save();
          ctx.scale(-1, 1);
          ctx.drawImage(video, -w, 0, w, h);
          ctx.restore();

        // Draw skeleton from cached result (every frame, no flicker)
        if (showSkeleton && lastResult?.landmarks) {
          const CONNECTIONS = [
            [0,1],[1,2],[2,3],[3,4],[0,5],[5,6],[6,7],[7,8],
            [0,9],[9,10],[10,11],[11,12],[0,13],[13,14],[14,15],[15,16],
            [0,17],[17,18],[18,19],[19,20],[5,9],[9,13],[13,17]
          ];
          for (const landmarks of lastResult.landmarks) {
            ctx.strokeStyle = "rgba(0,200,255,0.6)";
            ctx.lineWidth = 2;
            for (const [a, b] of CONNECTIONS) {
              ctx.beginPath();
              ctx.moveTo(w - landmarks[a].x * w, landmarks[a].y * h);
              ctx.lineTo(w - landmarks[b].x * w, landmarks[b].y * h);
              ctx.stroke();
            }
            for (const lm of landmarks) {
              ctx.beginPath();
              ctx.arc(w - lm.x * w, lm.y * h, 3, 0, Math.PI * 2);
              ctx.fillStyle = "#00ccff";
              ctx.fill();
            }
          }
        }

        // Draw nkob on extended index finger
        if (showNkob && lastResult?.landmarks && nkobImg) {
          for (const landmarks of lastResult.landmarks) {
            const tip = landmarks[8], pip = landmarks[6], base = landmarks[5];
            if (!tip || !pip || !base) continue;
            if (tip.y >= pip.y) continue; // not extended

            // Position (mirrored)
            const bx = w - tip.x * w;
            const by = tip.y * h;
            const dx = bx - (w - base.x * w);
            const dy = by - base.y * h;
            const angle = Math.atan2(dy, dx);

            const size = 40;
            ctx.save();
            ctx.translate(bx, by);
            ctx.rotate(angle + Math.PI / 2);

            // Glow
            const grad = ctx.createRadialGradient(0, 0, 0, 0, 0, size);
            grad.addColorStop(0, "rgba(255, 200, 60, 0.3)");
            grad.addColorStop(1, "rgba(255, 200, 60, 0)");
            ctx.fillStyle = grad;
            ctx.beginPath();
            ctx.arc(0, 0, size, 0, Math.PI * 2);
            ctx.fill();

            ctx.drawImage(nkobImg!, -size / 2, -size / 2, size, size);
            ctx.restore();
          }
        }
        }

        // Render FPS
        if (now - lastFpsTime > 1000) {
          renderFps = Math.round((frameCount * 1000) / (now - lastFpsTime));
          frameCount = 0;
          lastFpsTime = now;
        }
      }
      requestAnimationFrame(frame);
    }
    requestAnimationFrame(frame);
  }

  function restart() {
    running = false;
    setTimeout(async () => {
      releaseCamera();
      await initCamera();
      running = true;
      status = "Running";
      startLoop();
    }, 100);
  }

  function changeCamRes(idx: number) {
    camResIndex = idx;
    restart();
  }

  async function reloadModel() {
    running = false;
    await new Promise(r => setTimeout(r, 50));
    if (handLandmarker) handLandmarker.close();
    await initMediaPipe();
    running = true;
    status = "Running";
    startLoop();
  }

  function setDelegate(d: "GPU" | "CPU") {
    delegate = d;
    reloadModel();
  }

  function setNumHands(n: number) {
    numHands = n;
    reloadModel();
  }
</script>

<div class="step-container">
  <div class="canvas-wrapper" style="max-width: {cssScale}%; max-height: {cssScale}%;">
    <canvas bind:this={canvas} class="step-canvas"></canvas>
  </div>

  <!-- Controls -->
  <div class="controls">
    <div class="ctrl-row">
      <span class="ctrl-label">MP</span>
      {#each RESOLUTIONS as d}
        <button class="ctrl-btn" class:active={mpDim === d} onclick={() => setMpDim(d)} tabindex="0">{d}</button>
      {/each}
      <span class="ctrl-sep"></span>
      <span class="ctrl-label">Skip</span>
      {#each [1,2,3,5,10] as n}
        <button class="ctrl-btn" class:active={detectEveryNth === n} onclick={() => detectEveryNth = n} tabindex="0">{n}×</button>
      {/each}
      <span class="ctrl-sep"></span>
      <span class="ctrl-label">Hands</span>
      {#each [1, 2] as n}
        <button class="ctrl-btn" class:active={numHands === n} onclick={() => setNumHands(n)} tabindex="0">{n}</button>
      {/each}
      <span class="ctrl-sep"></span>
      <button class="ctrl-btn" class:active={delegate === "GPU"} onclick={() => setDelegate("GPU")} tabindex="0">GPU</button>
      <button class="ctrl-btn" class:active={delegate === "CPU"} onclick={() => setDelegate("CPU")} tabindex="0">CPU</button>
    </div>
    <div class="ctrl-row">
      <span class="ctrl-label">Cam</span>
      {#each CAM_RES as r, i}
        <button class="ctrl-btn" class:active={camResIndex === i} onclick={() => changeCamRes(i)} tabindex="0">{r.label}</button>
      {/each}
    </div>
    <div class="ctrl-row">
      <span class="ctrl-label">Canvas</span>
      {#each CANVAS_RES as r}
        <button class="ctrl-btn" class:active={canvasMaxDim === r.dim} onclick={() => setCanvasDim(r.dim)} tabindex="0">{r.label}</button>
      {/each}
    </div>
    <div class="ctrl-row">
      <span class="ctrl-label">FPS</span>
      {#each RENDER_FPS_OPTIONS as opt}
        <button class="ctrl-btn" class:active={targetRenderFps === opt.fps} onclick={() => targetRenderFps = opt.fps} tabindex="0">{opt.label}</button>
      {/each}
    </div>
    <div class="ctrl-row">
      <button class="ctrl-btn" class:active={showSkeleton} onclick={() => showSkeleton = !showSkeleton} tabindex="0">
        {showSkeleton ? "🦴 Skeleton" : "💀 Off"}
      </button>
      <button class="ctrl-btn" class:active={showNkob} onclick={() => showNkob = !showNkob} tabindex="0">
        {showNkob ? "🦊 Nkob" : "⛔ Nkob"}
      </button>
      <button class="ctrl-btn" onclick={restart} tabindex="0">🔄 Restart</button>
    </div>
    <div class="ctrl-row">
      <span class="ctrl-label">CSS</span>
      {#each CSS_SCALES as s}
        <button class="ctrl-btn" class:active={cssScale === s.pct} onclick={() => cssScale = s.pct} tabindex="0">{s.label}</button>
      {/each}
    </div>
  </div>

  <!-- FPS -->
  <div class="fps-overlay">
    <div class="fps-card">
      <span class="fps-label">RENDER</span>
      <span class="fps-value">{renderFps}</span>
    </div>
    <div class="fps-card detect">
      <span class="fps-label">DETECT</span>
      <span class="fps-value">{detectFps}</span>
    </div>
    <div class="fps-card mp">
      <span class="fps-label">{mpLabel}</span>
    </div>
    <div class="fps-card canvas">
      <span class="fps-label">Canvas: {canvas?.width ?? 0}×{canvas?.height ?? 0}</span>
    </div>
    <div class="fps-card info">
      <span class="fps-label">Cap: {targetRenderFps || "60"}fps</span>
    </div>
  </div>

  {#if error}
    <div class="overlay error">
      <div class="overlay-icon">⚠️</div>
      <div class="overlay-text">{error}</div>
    </div>
  {/if}

  {#if status !== "Running" && !error}
    <div class="overlay loading">
      <div class="spinner"></div>
      <div class="overlay-text">{status}</div>
    </div>
  {/if}
</div>

<style>
  .step-container { position: fixed; inset: 0; background: #000; overflow: hidden; }

  .canvas-wrapper {
    position: absolute;
    inset: 0;
    margin: auto;
    display: flex;
    align-items: center;
    justify-content: center;
    overflow: hidden;
  }

  .step-canvas {
    width: 100%;
    height: 100%;
    object-fit: contain;
  }

  .controls {
    position: absolute; top: 8px; left: 8px; right: 8px;
    display: flex; flex-direction: column; gap: 4px; z-index: 10;
    pointer-events: none;
  }
  .ctrl-row {
    display: flex; gap: 3px; align-items: center;
    background: rgba(0,0,0,0.6); padding: 4px 6px; border-radius: 8px;
    backdrop-filter: blur(4px); pointer-events: auto; flex-wrap: wrap;
  }
  .ctrl-label {
    color: #6b6f83; font-size: 10px; font-family: monospace;
    text-transform: uppercase; letter-spacing: 0.5px; margin-right: 2px; white-space: nowrap;
  }
  .ctrl-btn {
    background: rgba(255,255,255,0.06); color: #8b8fa3;
    border: 1px solid rgba(255,255,255,0.08); border-radius: 5px;
    padding: 3px 7px; font-size: 10px; font-family: monospace;
    cursor: pointer; transition: 0.12s; white-space: nowrap; outline: none;
  }
  .ctrl-btn:focus-visible { outline: 2px solid rgba(167,139,250,0.6); outline-offset: 1px; }
  .ctrl-btn:hover { background: rgba(255,255,255,0.12); color: #e1e4ea; }
  .ctrl-btn.active { background: rgba(167,139,250,0.2); color: #a78bfa; border-color: rgba(167,139,250,0.35); }
  .ctrl-sep { width: 1px; height: 16px; background: rgba(255,255,255,0.1); margin: 0 3px; flex-shrink: 0; }

  .fps-overlay {
    position: absolute; bottom: 10px; left: 10px;
    display: flex; gap: 5px; z-index: 10; pointer-events: none; user-select: none;
  }
  .fps-card {
    background: rgba(0,0,0,0.6); backdrop-filter: blur(4px);
    border-radius: 8px; padding: 5px 10px;
    display: flex; flex-direction: column; align-items: center;
    min-width: 55px; box-shadow: 0 3px 12px rgba(0,0,0,0.4);
  }
  .fps-card .fps-label { font-size: 9px; font-family: monospace; opacity: 0.6; }
  .fps-card .fps-value { font-size: 20px; font-weight: 700; line-height: 1.2; }
  .fps-card.detect .fps-label { color: rgba(167,139,250,0.5); }
  .fps-card.detect .fps-value { color: #a78bfa; }
  .fps-card.mp { min-width: auto; padding: 5px 8px; }
  .fps-card.mp .fps-label { font-size: 9px; color: #6b6f83; }
  .fps-card.canvas { min-width: auto; padding: 5px 8px; }
  .fps-card.canvas .fps-label { font-size: 9px; color: #6b6f83; }
  .fps-card.info { min-width: auto; padding: 5px 8px; }
  .fps-card.info .fps-label { font-size: 9px; color: #6b6f83; }

  .overlay {
    position: absolute; inset: 0; display: flex; flex-direction: column;
    align-items: center; justify-content: center;
    background: rgba(0,0,0,0.8); padding: 2rem; z-index: 20;
  }
  .overlay.error .overlay-icon { font-size: 3rem; margin-bottom: 1rem; }
  .overlay-text { color: #f87171; font-size: 1.2rem; text-align: center; margin-bottom: 1.5rem; }

  .loading .overlay-text { color: #8b8fa3; }
  .spinner {
    width: 32px; height: 32px;
    border: 3px solid rgba(167,139,250,0.15); border-top-color: #a78bfa;
    border-radius: 50%; animation: spin 0.8s linear infinite; margin-bottom: 1rem;
  }
  @keyframes spin { to { transform: rotate(360deg); } }
</style>
