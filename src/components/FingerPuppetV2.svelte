<script lang="ts">
  import { onMount, onDestroy } from "svelte";

  let canvas: HTMLCanvasElement;
  let status = $state("Initializing...");
  let handCount = $state(0);
  let handedness = $state<string[]>([]);
  let gestures = $state<string[]>([]);
  let fps = $state(0);
  let mpFps = $state(0); // MediaPipe detection FPS (after downscale)
  let mpLabel = $state("MediaPipe input — ...");
  let error = $state<string | null>(null);

  // Smoothed hand landmarks (EMA filter)
  let smoothedLandmarks: any[] | null = null;
  const SMOOTH_ALPHA = 0.35;

  // Full-res video for user display
  let video: HTMLVideoElement | null = null;
  let videoWidth = $state(0);
  let videoHeight = $state(0);
  // Offscreen canvas: downsized input to MediaPipe for faster detection
  let mpCanvas: HTMLCanvasElement | null = null;
  let stream: MediaStream | null = null;

  let handLandmarkerInstance: any;
  let running = true;
  let frameCount = 0;
  let mpFrameCount = 0;
  let lastFpsUpdate = 0;
  let lastMpFpsUpdate = 0;

  // MediaPipe receives a downscaled version of whatever the camera provides.
  // MAX_MP_DIMENSION caps the longer side of the MediaPipe input canvas.
  // Made reactive so the user can change it at runtime via the resolution buttons.
  let maxMpDimension = $state(320);
  let showSmileys = $state(true);
  let showSkeleton = $state(true);
  let detectEveryNth = $state(1);
  let smileyMaxScale = $state(5.0);
  let smileyMinScale = $state(0.1);
  let smileyDepthMultiplier = $state(8);

  // Loaded finger puppet images
  let fingerImages: Record<number, HTMLImageElement> = {};
  let fingerImagesReady = $state(false);
  let detectFrameCounter = 0;
  let lastDetectResult: any = null;

  const RESOLUTION_PRESETS = [160, 240, 320, 480, 640];

  const MODEL_URL =
    "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/latest/hand_landmarker.task";
  const WASM_CDN = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@latest/wasm";

  onMount(async () => {
    // Release camera before page unload (catches refresh/close that onDestroy misses)
    if (typeof window !== "undefined") {
      window.addEventListener("beforeunload", releaseCamera);
    }

    // Preload finger puppet images from public/img/
    let imagesLoaded = 0;
    const onImgLoad = () => { imagesLoaded++; if (imagesLoaded >= 3) fingerImagesReady = true; };
    const onImgErr = () => { imagesLoaded++; if (imagesLoaded >= 3) fingerImagesReady = true; };
    for (const [idx, path] of [[8, "/img/nkob.png"], [12, "/img/goose.png"], [16, "/img/fox.png"]] as const) {
      const img = new Image();
      img.onload = onImgLoad;
      img.onerror = onImgErr;
      img.src = path;
      fingerImages[idx] = img;
    }

    try {
      await initMediaPipe();
      await initCamera();
      status = "Ready — wiggle your fingers";
      startDetectionLoop();
    } catch (e) {
      error = e instanceof Error ? e.message : "Unknown error";
      status = "Failed to start";
    }
  });

  function releaseCamera() {
    running = false;
    if (stream) {
      stream.getTracks().forEach((t) => t.stop());
      stream = null;
    }
    if (video) {
      video.pause();
      video.srcObject = null;
      video = null;
    }
  }

  onDestroy(() => {
    if (typeof window !== "undefined") {
      window.removeEventListener("beforeunload", releaseCamera);
    }
    releaseCamera();
    if (handLandmarkerInstance) handLandmarkerInstance.close();
  });

  async function initMediaPipe() {
    const { FilesetResolver, HandLandmarker } = await import("@mediapipe/tasks-vision");
    status = "Loading hand model...";
    const vision = await FilesetResolver.forVisionTasks(WASM_CDN);

    // Try GPU first (faster on desktop with WebGL2), fall back to CPU for
    // Orange Pi / single-board computers where WebGL2 hardware acceleration
    // is incomplete and MediaPipe's inference graph crashes with:
    //   "StartRun failed; StartGraph failed"
    // The CPU delegate works on all hardware at the cost of lower FPS.
    try {
      handLandmarkerInstance = await HandLandmarker.createFromOptions(vision, {
        baseOptions: { modelAssetPath: MODEL_URL, delegate: "GPU" },
        runningMode: "VIDEO",
        numHands: 2,
      });
    } catch (gpuErr) {
      console.warn("GPU delegate failed, retrying with CPU:", gpuErr);
      status = "GPU unavailable, falling back to CPU...";
      handLandmarkerInstance = await HandLandmarker.createFromOptions(vision, {
        baseOptions: { modelAssetPath: MODEL_URL, delegate: "CPU" },
        runningMode: "VIDEO",
        numHands: 2,
      });
    }
  }

  async function initCamera() {
    status = "Opening camera...";
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: "user" },
        audio: false,
      });
    } catch (firstErr) {
      // Retry once after a delay — browsers sometimes hold the stream briefly on page refresh
      if (firstErr instanceof DOMException && firstErr.name === "NotAllowedError") {
        status = "Camera busy, retrying...";
        await new Promise((r) => setTimeout(r, 600));
        status = "Opening camera (retry)...";
        stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: "user" },
          audio: false,
        });
      } else {
        throw firstErr;
      }
    }

    // Hidden full-res video — never appended to DOM
    video = document.createElement("video");
    video.srcObject = stream;
    video.playsInline = true;
    video.muted = true;
    video.autoplay = true;
    await video.play();

    // Store actual camera resolution
    videoWidth = video.videoWidth;
    videoHeight = video.videoHeight;

    // Set main canvas to full camera resolution
    setCanvasSize(videoWidth, videoHeight);

    // Offscreen canvas: dynamically scaled down, same aspect ratio
    resizeMpCanvas();
  }

  function setCanvasSize(vw: number, vh: number) {
    if (!canvas) return;
    canvas.width = vw;
    canvas.height = vh;
  }

  function resizeMpCanvas() {
    if (!mpCanvas) {
      mpCanvas = document.createElement("canvas");
    }
    const scale = Math.min(maxMpDimension / Math.max(videoWidth, videoHeight), 1);
    const mpW = Math.round(videoWidth * scale);
    const mpH = Math.round(videoHeight * scale);
    mpCanvas.width = mpW;
    mpCanvas.height = mpH;
    updateMpBadge(mpW, mpH);
  }

  function setResolution(dim: number) {
    maxMpDimension = dim;
    if (videoWidth && videoHeight) {
      resizeMpCanvas();
    }
  }

  function updateMpBadge(w: number, h: number) {
    const factor = maxMpDimension / Math.max(w, h);
    mpLabel = `MediaPipe input — ${w}×${h} (${factor < 1 ? Math.round(factor * 100) + "%" : "full"})`;
  }

  function startDetectionLoop() {
    function detect() {
      if (!running || !video || !mpCanvas) return;
      if (handLandmarkerInstance && video.readyState >= 2) {
        const now = performance.now();

        // ── Step 1: Downscale full-res video → tiny offscreen canvas ──
        const mpCtx = mpCanvas.getContext("2d")!;
        mpCtx.drawImage(video, 0, 0, mpCanvas.width, mpCanvas.height);

        // ── Step 2: Run MediaPipe only every Nth frame (throttle) ──
        detectFrameCounter++;
        const shouldDetect = detectFrameCounter % detectEveryNth === 0;

        if (shouldDetect) {
          lastDetectResult = handLandmarkerInstance.detectForVideo(mpCanvas, now);

          // Track MediaPipe FPS separately
          mpFrameCount++;
          if (now - lastMpFpsUpdate > 1000) {
            mpFps = Math.round((mpFrameCount * 1000) / (now - lastMpFpsUpdate));
            mpFrameCount = 0;
            lastMpFpsUpdate = now;
          }
        }

        const result = lastDetectResult;

        // Landmarks are normalized 0-1, so they map to any display size perfectly
        handCount = result?.landmarks?.length ?? 0;
        handedness = (result?.handedness ?? []).map((h: any) => h[0]?.categoryName ?? "?");
        gestures = classifyGestures(result.landmarks);

        // ── Step 3: Draw full-res video with skeleton overlay ──
        drawFrame(result);

        frameCount++;
        if (now - lastFpsUpdate > 1000) {
          fps = Math.round((frameCount * 1000) / (now - lastFpsUpdate));
          frameCount = 0;
          lastFpsUpdate = now;
        }
      }
      requestAnimationFrame(detect);
    }
    requestAnimationFrame(detect);
  }

  function classifyGestures(hands: any[] | undefined): string[] {
    if (!hands) return [];
    return hands.map((landmarks: any[]) => {
      if (landmarks.length < 21) return "unknown";
      const lm = (i: number) => landmarks[i];
      const thumbExtended = lm(4).x < lm(3).x ? 1 : 0;
      const fingerExtended = (tip: number, pip: number) => (lm(tip).y < lm(pip).y ? 1 : 0);
      const indexExt  = fingerExtended(8, 6);
      const middleExt = fingerExtended(12, 10);
      const ringExt   = fingerExtended(16, 14);
      const pinkyExt  = fingerExtended(20, 18);
      const fingers = [thumbExtended, indexExt, middleExt, ringExt, pinkyExt];
      const extCount = fingers.reduce((a, b) => a + b, 0);
      if (extCount === 0) return "✊ Fist";
      if (extCount === 5) return "🖐️ Palm";
      if (indexExt && middleExt && !ringExt && !pinkyExt) return "✌️ Peace";
      if (thumbExtended && !indexExt && !middleExt && !ringExt && !pinkyExt) return "👍 Thumbs up";
      if (lm(4).y > lm(3).y && !indexExt && !middleExt && !ringExt && !pinkyExt) return "👎 Thumbs down";
      if (thumbExtended && !indexExt && !middleExt && !ringExt && pinkyExt) return "🤙 Call me";
      if (indexExt && !middleExt && !ringExt && pinkyExt) return "🤘 Rock";
      if (indexExt && !middleExt && !ringExt && !pinkyExt) return "☝️ Point";
      const thumbIndexDist = Math.hypot(lm(4).x - lm(8).x, lm(4).y - lm(8).y, lm(4).z - lm(8).z);
      if (thumbIndexDist < 0.06 && extCount <= 2) return "🤏 Pinch";
      return `${extCount} up`;
    });
  }

  function drawFingerImage(ctx: CanvasRenderingContext2D, w: number, h: number, tip: any, base: any, img: HTMLImageElement) {
    const bx = w - tip.x * w;
    const by = tip.y * h;
    const dx = bx - (w - base.x * w);
    const dy = by - base.y * h;
    const angle = Math.atan2(dy, dx);
    // Scale based on z proximity
    const scale = Math.min(smileyMaxScale, Math.max(smileyMinScale, 1 - (tip.z ?? 0) * smileyDepthMultiplier));
    const size = 36 * scale;

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

    // Draw the image centered, rotated
    ctx.drawImage(img, -size / 2, -size / 2, size, size);
    ctx.restore();
  }

  function drawSmileyFace(ctx: CanvasRenderingContext2D, w: number, h: number, tip: any, base: any) {
    const bx = w - tip.x * w;
    const by = tip.y * h;
    const dx = bx - (w - base.x * w);
    const dy = by - base.y * h;
    const angle = Math.atan2(dy, dx);
    // Zoom: z < 0 = closer (MediaPipe z is negative towards viewer), z > 0 = farther
    const scale = Math.min(smileyMaxScale, Math.max(smileyMinScale, 1 - (tip.z ?? 0) * smileyDepthMultiplier));
    const faceR = 18 * scale;

    ctx.save();
    ctx.translate(bx, by);
    ctx.rotate(angle + Math.PI / 2);

    // Glow
    const grad = ctx.createRadialGradient(0, 0, 0, 0, 0, faceR * 2);
    grad.addColorStop(0, "rgba(255, 200, 60, 0.3)");
    grad.addColorStop(1, "rgba(255, 200, 60, 0)");
    ctx.beginPath();
    ctx.arc(0, 0, faceR * 2, 0, Math.PI * 2);
    ctx.fillStyle = grad;
    ctx.fill();

    // Face
    ctx.beginPath();
    ctx.arc(0, 0, faceR, 0, Math.PI * 2);
    ctx.fillStyle = "#ffd93d";
    ctx.fill();
    ctx.strokeStyle = "rgba(0, 0, 0, 0.15)";
    ctx.lineWidth = 1.5 * scale;
    ctx.stroke();

    // Eyes
    const eyeOff = faceR * 0.35;
    const eyeR = 3 * scale;
    for (const ex of [-eyeOff, eyeOff]) {
      ctx.beginPath();
      ctx.arc(ex, -faceR * 0.2, eyeR, 0, Math.PI * 2);
      ctx.fillStyle = "#222";
      ctx.fill();
    }

    // Smile
    ctx.beginPath();
    ctx.arc(0, faceR * 0.1, faceR * 0.45, 0.15 * Math.PI, 0.85 * Math.PI);
    ctx.strokeStyle = "#222";
    ctx.lineWidth = 2.5 * scale;
    ctx.lineCap = "round";
    ctx.stroke();

    // Highlight
    ctx.beginPath();
    ctx.arc(-faceR * 0.25, -faceR * 0.35, faceR * 0.25, 0, Math.PI * 2);
    ctx.fillStyle = "rgba(255, 255, 255, 0.3)";
    ctx.fill();

    ctx.restore();
  }

  function drawFrame(result: any) {
    if (!video) return;
    const ctx = canvas.getContext("2d")!;
    const w = canvas.width;
    const h = canvas.height;

    // 1. Mirrored camera feed (full resolution)
    ctx.save();
    ctx.scale(-1, 1);
    ctx.drawImage(video, -w, 0, w, h);
    ctx.restore();

    // 2. Apply EMA smoothing to raw landmarks (same as v1)
    if (result.landmarks) {
      const raw = result.landmarks;
      if (!smoothedLandmarks || raw.length !== smoothedLandmarks.length) {
        // Initialize or reset on hand count change
        smoothedLandmarks = raw.map((hand: any[]) =>
          hand.map((lm: any) => ({ x: lm.x, y: lm.y, z: lm.z }))
        );
      } else {
        for (let h = 0; h < raw.length; h++) {
          for (let i = 0; i < raw[h].length; i++) {
            const s = smoothedLandmarks[h][i];
            const r = raw[h][i];
            s.x += (r.x - s.x) * SMOOTH_ALPHA;
            s.y += (r.y - s.y) * SMOOTH_ALPHA;
            s.z += (r.z - s.z) * SMOOTH_ALPHA;
          }
        }
      }
    }

    // 3. Draw skeleton and faces from smoothed landmarks
    if (smoothedLandmarks) {
      if (showSkeleton) {
        const CONNECTIONS = [
          [0, 1],[1, 2],[2, 3],[3, 4],
          [0, 5],[5, 6],[6, 7],[7, 8],
          [0, 9],[9,10],[10,11],[11,12],
          [0,13],[13,14],[14,15],[15,16],
          [0,17],[17,18],[18,19],[19,20],
          [5, 9],[9,13],[13,17],
        ];

        for (const landmarks of smoothedLandmarks) {
          ctx.strokeStyle = "rgba(0, 200, 255, 0.6)";
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

      // Finger puppet faces on extended fingertips (toggleable)
      if (showSmileys) {
        const FINGERTIPS = [
          { tip: 8, pip: 6, base: 5 },
          { tip: 12, pip: 10, base: 9 },
          { tip: 16, pip: 14, base: 13 },
          { tip: 20, pip: 18, base: 17 },
        ];
        for (const lm of smoothedLandmarks) {
          for (const f of FINGERTIPS) {
            const tip = lm[f.tip], pip = lm[f.pip], base = lm[f.base];
            if (!tip || !pip || !base) continue;
            if (tip.y >= pip.y) continue;
            const img = fingerImages[f.tip];
            if (fingerImagesReady && img) {
              drawFingerImage(ctx, w, h, tip, base, img);
            } else {
              drawSmileyFace(ctx, w, h, tip, base);
            }
          }
        }
      }
    }

    // 4. (no HUD overlays — FPS rendered as HTML divs)
  }

</script>

<div class="finger-puppet-v2-container">
  <canvas bind:this={canvas} class="finger-puppet-v2-canvas"></canvas>

  <!-- Resolution control bar (row 1) -->
  <div class="res-controls">
    <span class="res-label">MP res</span>
    {#each RESOLUTION_PRESETS as dim}
      <button
        class="res-btn"
        class:active={maxMpDimension === dim}
        onclick={() => setResolution(dim)}
      >{dim}</button>
    {/each}
  </div>

  <!-- Toggle controls (row 2) -->
  <div class="toggle-controls">
    <button class="res-btn" class:active={showSmileys} onclick={() => showSmileys = !showSmileys}>
      {showSmileys ? "😀" : "😑"}
    </button>
    <button class="res-btn" class:active={showSkeleton} onclick={() => showSkeleton = !showSkeleton}>
      {showSkeleton ? "🦴" : "💀"}
    </button>
    <div class="res-sep"></div>
    <span class="res-label">Detect</span>
    <button class="res-btn" class:active={detectEveryNth === 1} onclick={() => detectEveryNth = 1}>1×</button>
    <button class="res-btn" class:active={detectEveryNth === 2} onclick={() => detectEveryNth = 2}>2×</button>
    <button class="res-btn" class:active={detectEveryNth === 3} onclick={() => detectEveryNth = 3}>3×</button>
    <button class="res-btn" class:active={detectEveryNth === 4} onclick={() => detectEveryNth = 4}>4×</button>
    <button class="res-btn" class:active={detectEveryNth === 5} onclick={() => detectEveryNth = 5}>5×</button>
  </div>

  <!-- Smiley scale sliders -->
  <div class="slider-controls">
    <div class="slider-item">
      <label class="slider-label" for="zoom-range">Zoom</label>
      <input type="range" id="zoom-range" min="1.0" max="5.0" step="0.1" value={smileyMaxScale} oninput={(e) => smileyMaxScale = parseFloat((e.target as HTMLInputElement).value)} />
      <span class="slider-val">{Math.round(smileyMaxScale * 10) / 10}</span>
    </div>
    <div class="slider-item">
      <label class="slider-label" for="shrink-range">Shrink</label>
      <input type="range" id="shrink-range" min="0.05" max="1.0" step="0.05" value={smileyMinScale} oninput={(e) => smileyMinScale = parseFloat((e.target as HTMLInputElement).value)} />
      <span class="slider-val">{Math.round(smileyMinScale * 100) / 100}</span>
    </div>
    <div class="slider-item">
      <label class="slider-label" for="depth-range">Depth</label>
      <input type="range" id="depth-range" min="1" max="20" step="1" value={smileyDepthMultiplier} oninput={(e) => smileyDepthMultiplier = parseInt((e.target as HTMLInputElement).value)} />
      <span class="slider-val">{smileyDepthMultiplier}×</span>
    </div>
  </div>

  <!-- FPS overlay (HTML divs, not canvas) -->
  <div class="fps-overlay">
    <div class="fps-card detect">
      <span class="fps-label">DETECT</span>
      <span class="fps-value">{mpFps}</span>
    </div>
    <div class="fps-card render">
      <span class="fps-label">RENDER</span>
      <span class="fps-value">{fps}</span>
    </div>
    <div class="fps-card mp-info">
      <span class="fps-label">{mpLabel}</span>
    </div>
  </div>

  {#if error}
    <div class="overlay error">
      <div class="overlay-icon">⚠️</div>
      <div class="overlay-text">{error}</div>
      <div class="overlay-hint">
        Troubleshooting tips:<br>
        • Check that the MediaPipe model URL is reachable<br>
        • If using a single-board computer (Orange Pi), ensure the CPU delegate was used<br>
        • Avoid calling <code>getContext('2d')</code> on the same canvas before MediaPipe initializes<br>
        • Open DevTools → Network tab to verify <code>hand_landmarker.task</code> loads (200 OK)<br>
        • Try Chromium with <code>chrome://settings/system</code> → enable graphics acceleration
      </div>
    </div>
  {/if}
</div>

<style>
  .finger-puppet-v2-container {
    position: fixed;
    inset: 0;
    background: #000;
    overflow: hidden;
  }

  .finger-puppet-v2-canvas {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    object-fit: cover;
  }

  .res-controls {
    position: absolute;
    top: 12px;
    left: 12px;
    display: flex;
    gap: 4px;
    align-items: center;
    background: rgba(0, 0, 0, 0.55);
    padding: 6px 8px;
    border-radius: 10px;
    backdrop-filter: blur(4px);
    z-index: 10;
  }

  .toggle-controls {
    position: absolute;
    top: 52px;
    left: 12px;
    display: flex;
    gap: 4px;
    align-items: center;
    background: rgba(0, 0, 0, 0.55);
    padding: 6px 8px;
    border-radius: 10px;
    backdrop-filter: blur(4px);
    z-index: 10;
  }

  .res-label {
    color: #8b8fa3;
    font-size: 11px;
    font-family: monospace;
    margin-right: 4px;
  }

  .res-btn {
    background: rgba(255, 255, 255, 0.08);
    color: #8b8fa3;
    border: 1px solid rgba(255, 255, 255, 0.1);
    border-radius: 6px;
    padding: 4px 10px;
    font-size: 12px;
    font-family: monospace;
    cursor: pointer;
    transition: background 0.15s, color 0.15s, border-color 0.15s;
  }

  .res-btn:hover {
    background: rgba(255, 255, 255, 0.15);
    color: #e1e4ea;
  }

  .res-sep {
    width: 1px;
    height: 18px;
    background: rgba(255, 255, 255, 0.15);
    margin: 0 4px;
  }

  .slider-controls {
    position: absolute;
    top: 92px;
    left: 12px;
    display: flex;
    gap: 8px;
    background: rgba(0, 0, 0, 0.55);
    padding: 8px 12px;
    border-radius: 10px;
    backdrop-filter: blur(4px);
    z-index: 10;
    pointer-events: auto;
  }

  .slider-item {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 2px;
  }

  .slider-label {
    font-size: 10px;
    color: #8b8fa3;
    font-family: system-ui, -apple-system, sans-serif;
    text-transform: uppercase;
    letter-spacing: 0.5px;
  }

  .slider-item input[type="range"] {
    width: 80px;
    height: 4px;
    -webkit-appearance: none;
    appearance: none;
    background: rgba(167, 139, 250, 0.3);
    border-radius: 2px;
    outline: none;
    cursor: pointer;
  }

  .slider-item input[type="range"]::-webkit-slider-thumb {
    -webkit-appearance: none;
    width: 14px;
    height: 14px;
    border-radius: 50%;
    background: #a78bfa;
    border: none;
    cursor: pointer;
  }

  .slider-val {
    font-size: 11px;
    color: #a78bfa;
    font-family: monospace;
    min-width: 28px;
    text-align: center;
  }

  .res-btn.active {
    background: rgba(167, 139, 250, 0.25);
    color: #a78bfa;
    border-color: rgba(167, 139, 250, 0.4);
  }

  .fps-overlay {
    position: absolute;
    bottom: 16px;
    left: 16px;
    display: flex;
    gap: 8px;
    z-index: 10;
    pointer-events: none;
    user-select: none;
  }

  .fps-card {
    background: rgba(0, 0, 0, 0.65);
    backdrop-filter: blur(4px);
    border-radius: 12px;
    padding: 8px 14px;
    display: flex;
    flex-direction: column;
    align-items: center;
    min-width: 70px;
    box-shadow: 0 4px 20px rgba(0,0,0,0.4);
  }

  .fps-card .fps-label {
    font-size: 11px;
    font-family: system-ui, -apple-system, sans-serif;
    letter-spacing: 0.5px;
  }

  .fps-card .fps-value {
    font-size: 28px;
    font-weight: 700;
    font-family: system-ui, -apple-system, sans-serif;
    line-height: 1.2;
  }

  .fps-card.detect .fps-label {
    color: rgba(167, 139, 250, 0.6);
  }
  .fps-card.detect .fps-value {
    color: #a78bfa;
  }

  .fps-card.render .fps-label {
    color: rgba(225, 228, 234, 0.5);
  }
  .fps-card.render .fps-value {
    color: #e1e4ea;
  }

  .fps-card.mp-info {
    background: rgba(167, 139, 250, 0.12);
    border: 1px solid rgba(167, 139, 250, 0.2);
    min-width: auto;
    padding: 8px 12px;
    justify-content: center;
  }
  .fps-card.mp-info .fps-label {
    font-size: 11px;
    color: #a78bfa;
    font-family: monospace;
    letter-spacing: 0;
  }

  .overlay {
    position: absolute;
    inset: 0;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    background: rgba(0, 0, 0, 0.8);
    padding: 2rem;
  }
  .overlay.error .overlay-icon {
    font-size: 3rem;
    margin-bottom: 1rem;
  }
  .overlay-text {
    color: #f87171;
    font-size: 1.2rem;
    text-align: center;
    margin-bottom: 1.5rem;
  }
  .overlay-hint {
    color: #8b8fa3;
    font-size: 0.85rem;
    line-height: 1.6;
    text-align: left;
    max-width: 460px;
    background: rgba(255,255,255,0.05);
    padding: 1rem 1.25rem;
    border-radius: 10px;
    border: 1px solid rgba(255,255,255,0.08);
  }
  .overlay-hint code {
    background: rgba(255,255,255,0.08);
    padding: 1px 5px;
    border-radius: 4px;
    font-size: 0.8rem;
    color: #a78bfa;
  }
</style>
