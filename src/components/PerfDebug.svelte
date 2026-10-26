<script lang="ts">
  import { onMount, onDestroy } from "svelte";

  let canvas: HTMLCanvasElement;
  let status = $state("Initializing...");
  let error = $state<string | null>(null);

  // ── Camera state ──
  let video: HTMLVideoElement | null = null;
  let stream: MediaStream | null = null;
  let videoWidth = $state(0);
  let videoHeight = $state(0);
  let camLabel = $state("—");

  // ── Performance counters ──
  let canvasReady = $state(false);  // set true after first successful draw
  let renderFps = $state(0);
  let detectFps = $state(0);
  let frameCount = 0;
  let detectFrameCount = 0;
  let lastRenderFpsTime = 0;
  let lastDetectFpsTime = 0;
  let skippedFrames = $state(0);
  let frameTimeMs = $state(0);
  let detectTimeMs = $state(0);
  let running = true;

  // ── Controls (all button-based) ──

  // Guard against concurrent restartCamera() calls
  let restarting = false;

  // Camera resolution presets
  const CAM_RES = [
    { label: "160×120",  w: 160,  h: 120 },
    { label: "240×180",  w: 240,  h: 180 },
    { label: "320×240",  w: 320,  h: 240 },
    { label: "480×360",  w: 480,  h: 360 },
    { label: "640×480",  w: 640,  h: 480 },
    { label: "800×600",  w: 800,  h: 600 },
    { label: "1280×720", w: 1280, h: 720 },
  ];
  let camResIndex = $state(3); // default 480×360
  let facingMode = $state<"user" | "environment">("user");

  // MediaPipe input downscale (longest side)
  const MP_DIMS = [80, 120, 160, 224, 256, 320, 480, 640];
  let mpDim = $state(160);

  // Model selection
  type ModelSet = "none" | "face" | "hand" | "pose" | "face+hand" | "all";
  const MODEL_OPTIONS: { label: string; value: ModelSet }[] = [
    { label: "○ None",   value: "none" },
    { label: "☺ Face",   value: "face" },
    { label: "✋ Hand",   value: "hand" },
    { label: "🧍 Pose",   value: "pose" },
    { label: "☺+✋",      value: "face+hand" },
    { label: "All",      value: "all" },
  ];
  let activeModels = $state<ModelSet>("hand");

  // Delegate
  let delegate = $state<"GPU" | "CPU">("GPU");

  // Detection skip (process every Nth frame)
  const SKIP_OPTIONS = [1, 2, 3, 4, 5, 10, 15, 30];
  let detectEveryNth = $state(1);

  // Render skip (draw canvas every Nth frame)
  const RENDER_SKIP = [1, 2, 3, 5, 10];
  let renderEveryNth = $state(1);

  // Toggle flags
  let drawVideo = $state(true);
  let drawLandmarks = $state(true);
  let drawSkeleton = $state(true);
  let drawBbox = $state(false);
  let mirror = $state(true);
  let showHud = $state(true);

  // ── Benchmark mode ──
  let benchmarking = $state(false);
  let benchLog: { label: string; fps: number }[] = $state([]);
  let benchPhase = $state("");
  let benchTimer: ReturnType<typeof setTimeout> | null = null;
  let benchFrameCount = 0;

  // ── Internal ──
  let modelsLoaded = false;
  let currentFrameCount = 0;

  // Model instances
  let faceLandmarker: any = null;
  let handLandmarker: any = null;
  let poseLandmarker: any = null;

  // Cached detection results (to avoid re-detecting in render section)
  let lastFaceResult: any = null;
  let lastHandResult: any = null;
  let lastPoseResult: any = null;

  // Offscreen canvas for MP input
  let mpCanvas: HTMLCanvasElement;
  let mpCtx: CanvasRenderingContext2D | null = null;
  let mpW = $state(0);
  let mpH = $state(0);
  let mpLabel = $state("MP: —");

  const VISION_WASM = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@latest/wasm";
  const MODEL_URLS = {
    face: "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task",
    hand: "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/latest/hand_landmarker.task",
    pose: "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker/float16/latest/pose_landmarker.task",
  };

  // ── Lifecycle ──

  onMount(() => {
    initCamera();
    // Safety timeout: if canvas never renders, show hint
    setTimeout(() => {
      if (!canvasReady && !error) {
        console.warn('[PerfDebug] Canvas not ready after 10s. Video:', 
          video?.readyState, 'Models:', modelsLoaded, 'Status:', status);
      }
    }, 10000);
  });

  onDestroy(() => {
    running = false;
    releaseCamera();
    closeModels();
    if (benchTimer) clearTimeout(benchTimer);
  });

  function releaseCamera() {
    if (stream) { stream.getTracks().forEach(t => t.stop()); stream = null; }
    if (video) { video.pause(); video.srcObject = null; video = null; }
  }

  function closeModels() {
    if (faceLandmarker) { faceLandmarker.close(); faceLandmarker = null; }
    if (handLandmarker) { handLandmarker.close(); handLandmarker = null; }
    if (poseLandmarker) { poseLandmarker.close(); poseLandmarker = null; }
    modelsLoaded = false;
  }

  // ── Camera ──

  async function initCamera() {
    try {
      error = null; // clear previous errors
      releaseCamera();
      status = "Opening camera...";
      const res = CAM_RES[camResIndex];
      stream = await navigator.mediaDevices.getUserMedia({
        video: {
          width: { ideal: res.w },
          height: { ideal: res.h },
          facingMode: facingMode,
        },
        audio: false,
      });

      video = document.createElement("video");
      video.srcObject = stream;
      video.playsInline = true;
      video.muted = true;
      video.autoplay = true;
      await video.play();

      // Use actual camera resolution
      videoWidth = video.videoWidth;
      videoHeight = video.videoHeight;
      camLabel = `${videoWidth}×${videoHeight}`;

      // Set canvas size
      canvas.width = videoWidth;
      canvas.height = videoHeight;

      // Offscreen canvas for MP
      mpCanvas = document.createElement("canvas");
      resizeMpCanvas();

      // Load models if needed
      await loadModels();

      status = "Running";
      startLoop();
    } catch (e) {
      error = e instanceof Error ? e.message : "Camera failed";
      status = "Failed";
    }
  }

  function resizeMpCanvas() {
    const scale = Math.min(mpDim / Math.max(videoWidth, videoHeight), 1);
    mpW = Math.round(videoWidth * scale);
    mpH = Math.round(videoHeight * scale);
    mpCanvas.width = mpW;
    mpCanvas.height = mpH;
    mpCtx = mpCanvas.getContext("2d")!;
    mpLabel = `MP: ${mpW}×${mpH}`;
  }

  // ── Model loading ──

  async function loadModels() {
    closeModels();
    if (activeModels === "none") { modelsLoaded = true; return; }

    status = "Loading models...";
    const { FilesetResolver, FaceLandmarker: FaceCls, HandLandmarker: HandCls, PoseLandmarker: PoseCls }
      = await import("@mediapipe/tasks-vision");
    const vision = await FilesetResolver.forVisionTasks(VISION_WASM);

    const needs = (m: ModelSet) => activeModels === m || activeModels === "all"
      || (m === "face" && (activeModels === "face+hand"))
      || (m === "hand" && (activeModels === "face+hand"));

    const tryLoad = async (name: string, Cls: any, url: string): Promise<any> => {
      try {
        return await Cls.createFromOptions(vision, {
          baseOptions: { modelAssetPath: url, delegate: delegate },
          runningMode: "VIDEO",
        });
      } catch (e) {
        console.warn(`${name} with ${delegate} failed:`, e);
        if (delegate === "GPU") {
          // Retry with CPU
          try {
            return await Cls.createFromOptions(vision, {
              baseOptions: { modelAssetPath: url, delegate: "CPU" },
              runningMode: "VIDEO",
            });
          } catch (e2) {
            console.error(`${name} CPU also failed:`, e2);
            return null;
          }
        }
        return null;
      }
    };

    if (needs("face")) {
      faceLandmarker = await tryLoad("Face", FaceCls, MODEL_URLS.face);
    }
    if (needs("hand")) {
      handLandmarker = await tryLoad("Hand", HandCls, MODEL_URLS.hand);
    }
    if (needs("pose")) {
      poseLandmarker = await tryLoad("Pose", PoseCls, MODEL_URLS.pose);
    }
    modelsLoaded = true;
  }

  // ── Re-initialize ──

  async function restartCamera() {
    if (restarting) return;
    restarting = true;
    canvasReady = false;
    running = false;
    await new Promise(r => setTimeout(r, 50));
    closeModels();
    await initCamera();
    restarting = false;
  }

  async function changeModels(m: ModelSet) {
    activeModels = m;
    await loadModels();
  }

  async function changeDelegate(d: "GPU" | "CPU") {
    delegate = d;
    await loadModels();
  }

  function changeMpDim(dim: number) {
    mpDim = dim;
    if (videoWidth) resizeMpCanvas();
  }

  function changeCamRes(idx: number) {
    camResIndex = idx;
    restartCamera();
  }

  function toggleFacing() {
    facingMode = facingMode === "user" ? "environment" : "user";
    restartCamera();
  }

  // ── Main loop ──

  // Monotonically increasing timestamp for MediaPipe detectForVideo.
  // rAF timestamps can conflict across overlapping callbacks (1μs precision),
  // causing the "Packet timestamp mismatch" error. Using our own counter
  // guarantees strict monotonic increase.
  let mpTimestamp = 0;

  function startLoop() {
    function frame(timestamp: number) {
      if (!running || !video || !canvas) return;
      const ctx = canvas.getContext("2d")!;
      const w = canvas.width;
      const h = canvas.height;

      if (video.readyState >= 1 && video.videoWidth > 0) {
        currentFrameCount++;

        // ── Step 1: Always draw video (independent of model state) ──
        const renderStart = performance.now();
        if (currentFrameCount % renderEveryNth === 0) {
          ctx.clearRect(0, 0, w, h);
          if (drawVideo) {
            ctx.save();
            if (mirror) {
              ctx.scale(-1, 1);
              ctx.drawImage(video, -w, 0, w, h);
            } else {
              ctx.drawImage(video, 0, 0, w, h);
            }
            ctx.restore();
          }
          canvasReady = true;

          // ── FPS tracking (per-render-frame) ──
          frameCount++;
          if (timestamp - lastRenderFpsTime > 1000) {
            renderFps = Math.round((frameCount * 1000) / (timestamp - lastRenderFpsTime));
            frameCount = 0;
            lastRenderFpsTime = timestamp;
          }
        } else {
          skippedFrames++;
        }
        frameTimeMs = Math.round(performance.now() - renderStart);

        // ── Step 2: Detection (if models ready) ──
        // Use our own monotonically increasing counter for MediaPipe timestamps.
        // Each model gets a unique timestamp to guarantee strict monotonic increase
        // across all models and all frames, preventing "Packet timestamp mismatch".
        if (modelsLoaded && video.readyState >= 2) {
          if (currentFrameCount % detectEveryNth === 0 && activeModels !== "none") {
            const detectStart = performance.now();
            if (mpCtx) {
              mpCtx.drawImage(video, 0, 0, mpW, mpH);
            }
            if (faceLandmarker) { mpTimestamp += 1000; lastFaceResult = faceLandmarker.detectForVideo(mpCanvas, mpTimestamp); }
            if (handLandmarker) { mpTimestamp += 1000; lastHandResult = handLandmarker.detectForVideo(mpCanvas, mpTimestamp); }
            if (poseLandmarker) { mpTimestamp += 1000; lastPoseResult = poseLandmarker.detectForVideo(mpCanvas, mpTimestamp); }
            const detectElapsed = performance.now() - detectStart;
            detectTimeMs = Math.round(detectElapsed);
            detectFrameCount++;
            if (timestamp - lastDetectFpsTime > 1000) {
              detectFps = Math.round((detectFrameCount * 1000) / (timestamp - lastDetectFpsTime));
              detectFrameCount = 0;
              lastDetectFpsTime = timestamp;
            }
          }
        }

        // ── Step 3: Overlays from cached results ──
        if ((drawLandmarks || drawSkeleton || drawBbox) && (lastFaceResult || lastHandResult || lastPoseResult)) {
            // Face landmarks
            if (lastFaceResult?.faceLandmarks && drawLandmarks) {
              for (const landmarks of lastFaceResult.faceLandmarks) {
                for (const lm of landmarks) {
                  const lx = mirror ? w - lm.x * w : lm.x * w;
                  ctx.beginPath();
                  ctx.arc(lx, lm.y * h, 1.5, 0, Math.PI * 2);
                  ctx.fillStyle = "rgba(255,200,100,0.5)";
                  ctx.fill();
                }
              }
            }

            // Hand landmarks + skeleton
            if (lastHandResult?.landmarks && (drawLandmarks || drawSkeleton)) {
              const HAND_CONNECTIONS = [
                [0,1],[1,2],[2,3],[3,4],[0,5],[5,6],[6,7],[7,8],
                [0,9],[9,10],[10,11],[11,12],[0,13],[13,14],[14,15],[15,16],
                [0,17],[17,18],[18,19],[19,20],[5,9],[9,13],[13,17]
              ];
              for (const landmarks of lastHandResult.landmarks) {
                if (drawSkeleton) {
                  ctx.strokeStyle = "rgba(0,200,255,0.5)";
                  ctx.lineWidth = 2;
                  for (const [a, b] of HAND_CONNECTIONS) {
                    ctx.beginPath();
                    ctx.moveTo(mirror ? w - landmarks[a].x * w : landmarks[a].x * w, landmarks[a].y * h);
                    ctx.lineTo(mirror ? w - landmarks[b].x * w : landmarks[b].x * w, landmarks[b].y * h);
                    ctx.stroke();
                  }
                }
                if (drawLandmarks) {
                  for (const lm of landmarks) {
                    const lx = mirror ? w - lm.x * w : lm.x * w;
                    ctx.beginPath();
                    ctx.arc(lx, lm.y * h, 3, 0, Math.PI * 2);
                    ctx.fillStyle = "#00ccff";
                    ctx.fill();
                  }
                }
              }
            }

            // Pose skeleton
            if (lastPoseResult?.landmarks && (drawLandmarks || drawSkeleton)) {
              const POSE_CONNECTIONS = [
                [0,1],[1,2],[2,3],[3,7],[0,4],[4,5],[5,6],[6,8],
                [9,10],[11,12],[11,13],[13,15],[15,17],[15,19],[15,21],
                [17,19],[12,14],[14,16],[16,18],[16,20],[16,22],
                [18,20],[11,23],[23,25],[25,27],[27,29],[29,31],
                [23,24],[24,26],[26,28],[28,30],[30,32],
              ];
              for (const landmarks of lastPoseResult.landmarks) {
                if (drawSkeleton) {
                  ctx.strokeStyle = "rgba(255,200,0,0.5)";
                  ctx.lineWidth = 2;
                  for (const [a, b] of POSE_CONNECTIONS) {
                    ctx.beginPath();
                    ctx.moveTo(mirror ? w - landmarks[a].x * w : landmarks[a].x * w, landmarks[a].y * h);
                    ctx.lineTo(mirror ? w - landmarks[b].x * w : landmarks[b].x * w, landmarks[b].y * h);
                    ctx.stroke();
                  }
                }
                if (drawLandmarks) {
                  for (const lm of landmarks) {
                    const lx = mirror ? w - lm.x * w : lm.x * w;
                    ctx.beginPath();
                    ctx.arc(lx, lm.y * h, 2, 0, Math.PI * 2);
                    ctx.fillStyle = "#ffcc00";
                    ctx.fill();
                  }
                }
              }
            }

            // Bounding boxes (from cached hand result)
            if (lastHandResult?.landmarks && drawBbox) {
              for (const landmarks of lastHandResult.landmarks) {
                let minX = 1, minY = 1, maxX = 0, maxY = 0;
                for (const lm of landmarks) {
                  if (lm.x < minX) minX = lm.x;
                  if (lm.y < minY) minY = lm.y;
                  if (lm.x > maxX) maxX = lm.x;
                  if (lm.y > maxY) maxY = lm.y;
                }
                const padding = 0.05;
                minX = Math.max(0, minX - padding);
                minY = Math.max(0, minY - padding);
                maxX = Math.min(1, maxX + padding);
                maxY = Math.min(1, maxY + padding);
                const bx = mirror ? w - maxX * w : minX * w;
                const bw = mirror ? (maxX - minX) * w : (maxX - minX) * w;
                ctx.strokeStyle = "rgba(255,100,100,0.6)";
                ctx.lineWidth = 2;
                ctx.strokeRect(bx, minY * h, bw, (maxY - minY) * h);
              }
            }
          }

      // Track frame for benchmark (read by startBenchmark)
      if (benchmarking) benchFrameCount++;

      requestAnimationFrame(frame);
    }
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
}

  // ── Benchmark ──

  async function startBenchmark() {
    benchmarking = true;
    benchLog = [];
    benchPhase = "Starting...";

    const phases = [
      ...CAM_RES.map((r, i) => ({ type: "res" as const, idx: i, label: r.label })),
      ...MP_DIMS.map(d => ({ type: "mpdim" as const, dim: d, label: `MP${d}` })),
    ];

    for (const phase of phases) {
      if (!benchmarking) break;
      benchPhase = phase.label;

      if (phase.type === "res") {
        camResIndex = phase.idx;
        await restartCamera();
      } else {
        changeMpDim(phase.dim);
      }

      // Settle then sample 3 seconds
      await new Promise(r => setTimeout(r, 600));
      benchFrameCount = 0;
      await new Promise(r => { benchTimer = setTimeout(r, 3000); });
      if (benchmarking) {
        const fps = Math.round((benchFrameCount * 1000) / 3000);
        benchLog = [...benchLog, { label: phase.label, fps }];
      }
    }

    benchmarking = false;
    benchPhase = "Done";
  }

  function stopBenchmark() {
    benchmarking = false;
    if (benchTimer) clearTimeout(benchTimer);
    benchPhase = "Stopped";
  }

  // ── Helpers ──

  function resetCounters() {
    frameCount = 0;
    detectFrameCount = 0;
    renderFps = 0;
    detectFps = 0;
    skippedFrames = 0;
  }
</script>

<div class="debug-container">
  <canvas bind:this={canvas} class="debug-canvas"></canvas>

  <!-- ─── Control rows ─── -->
  <div class="controls" class:hud-hidden={!showHud}>

    <!-- Row 1: Camera resolution -->
    <div class="ctrl-row">
      <span class="ctrl-label">Cam Res</span>
      {#each CAM_RES as res, i}
        <button
          class="ctrl-btn"
          class:active={camResIndex === i}
          onclick={() => changeCamRes(i)}
          disabled={benchmarking}
          tabindex="0"
        >{res.label}</button>
      {/each}
      <span class="ctrl-sep"></span>
      <button class="ctrl-btn ctrl-icon" onclick={toggleFacing} disabled={benchmarking} tabindex="0">
        {facingMode === "user" ? "📷 Selfie" : "📷 World"}
      </button>
    </div>

    <!-- Row 2: MP input resolution -->
    <div class="ctrl-row">
      <span class="ctrl-label">MP Dim</span>
      {#each MP_DIMS as dim}
        <button
          class="ctrl-btn"
          class:active={mpDim === dim}
          onclick={() => changeMpDim(dim)}
          disabled={benchmarking}
          tabindex="0"
        >{dim}</button>
      {/each}
    </div>

    <!-- Row 3: Model selection + delegate -->
    <div class="ctrl-row">
      <span class="ctrl-label">Model</span>
      {#each MODEL_OPTIONS as opt}
        <button
          class="ctrl-btn"
          class:active={activeModels === opt.value}
          onclick={() => changeModels(opt.value)}
          disabled={benchmarking}
          tabindex="0"
        >{opt.label}</button>
      {/each}
      <span class="ctrl-sep"></span>
      <button
        class="ctrl-btn"
        class:active={delegate === "GPU"}
        onclick={() => changeDelegate("GPU")}
        disabled={benchmarking}
        tabindex="0"
      >GPU</button>
      <button
        class="ctrl-btn"
        class:active={delegate === "CPU"}
        onclick={() => changeDelegate("CPU")}
        disabled={benchmarking}
        tabindex="0"
      >CPU</button>
    </div>

    <!-- Row 4: Process skip -->
    <div class="ctrl-row">
      <span class="ctrl-label">Detect</span>
      {#each SKIP_OPTIONS as n}
        <button
          class="ctrl-btn"
          class:active={detectEveryNth === n}
          onclick={() => { detectEveryNth = n; resetCounters(); }}
          tabindex="0"
        >{n}×</button>
      {/each}
      <span class="ctrl-sep"></span>
      <span class="ctrl-label">Render</span>
      {#each RENDER_SKIP as n}
        <button
          class="ctrl-btn"
          class:active={renderEveryNth === n}
          onclick={() => { renderEveryNth = n; resetCounters(); }}
          tabindex="0"
        >{n}×</button>
      {/each}
    </div>

    <!-- Row 5: Toggle flags -->
    <div class="ctrl-row">
      <button class="ctrl-btn" class:active={drawVideo} onclick={() => drawVideo = !drawVideo} tabindex="0">
        {drawVideo ? "📹 Video" : "📹 Off"}
      </button>
      <button class="ctrl-btn" class:active={drawLandmarks} onclick={() => drawLandmarks = !drawLandmarks} tabindex="0">
        {drawLandmarks ? "◎ LM" : "◎ Off"}
      </button>
      <button class="ctrl-btn" class:active={drawSkeleton} onclick={() => drawSkeleton = !drawSkeleton} tabindex="0">
        {drawSkeleton ? "🦴 Bone" : "🦴 Off"}
      </button>
      <button class="ctrl-btn" class:active={drawBbox} onclick={() => drawBbox = !drawBbox} tabindex="0">
        {drawBbox ? "▭ BBox" : "▭ Off"}
      </button>
      <button class="ctrl-btn" class:active={mirror} onclick={() => mirror = !mirror} tabindex="0">
        {mirror ? "🪞 Mir" : "🪞 Raw"}
      </button>
      <button class="ctrl-btn" class:active={showHud} onclick={() => showHud = !showHud} tabindex="0">
        {showHud ? "📊 HUD" : "📊 Off"}
      </button>
    </div>

    <!-- Row 6: Benchmark + Reset -->
    <div class="ctrl-row">
      {#if !benchmarking}
        <button class="ctrl-btn bench-btn" onclick={startBenchmark} tabindex="0">
          ⏱ Benchmark
        </button>
      {:else}
        <button class="ctrl-btn bench-btn active" onclick={stopBenchmark} tabindex="0">
          ⏹ Stop
        </button>
      {/if}
      <span class="ctrl-sep"></span>
      <button class="ctrl-btn" onclick={restartCamera} tabindex="0">🔄 Restart</button>
      <button class="ctrl-btn" onclick={resetCounters} tabindex="0">🔄 Reset FPS</button>
      {#if benchPhase}
        <span class="bench-phase">{benchPhase}</span>
      {/if}
    </div>
  </div>

  <!-- ─── FPS overlay ─── -->
  {#if showHud}
    <div class="fps-overlay">
      <div class="fps-card render">
        <span class="fps-label">RENDER</span>
        <span class="fps-value">{renderFps}</span>
        <span class="fps-sub">{frameTimeMs}ms</span>
      </div>
      <div class="fps-card detect">
        <span class="fps-label">DETECT</span>
        <span class="fps-value">{detectFps}</span>
        <span class="fps-sub">{detectTimeMs}ms</span>
      </div>
      <div class="fps-card info">
        <span class="fps-label">CAM</span>
        <span class="fps-value">{camLabel}</span>
      </div>
      <div class="fps-card info">
        <span class="fps-label">{mpLabel}</span>
      </div>
      <div class="fps-card info">
        <span class="fps-label">Skip {skippedFrames}</span>
      </div>
      <div class="fps-card info">
        <span class="fps-label">{delegate} / {activeModels}</span>
      </div>
      {#if benchLog.length > 0}
        <div class="fps-card bench-log">
          <div class="bench-scroll">
            {#each benchLog as entry}
              <span class="bench-entry">{entry.label}: {entry.fps}fps</span>
            {/each}
          </div>
        </div>
      {/if}
    </div>
  {/if}

  {#if !canvasReady && !error}
    <div class="overlay loading">
      <div class="spinner"></div>
      <div class="overlay-text">{status}</div>
    </div>
  {/if}

  {#if error}
    <div class="overlay error">
      <div class="overlay-icon">⚠️</div>
      <div class="overlay-text">{error}</div>
      <div class="overlay-hint">
        Troubleshooting:<br>
        • Is another app using the camera?<br>
        • Try a lower resolution (320×240 or 480×360)<br>
        • On OrangePi, use CPU delegate and MP dim ≤160<br>
        • Open DevTools → Network to check model URLs load (200 OK)<br>
        • Try Chromium with <code>--disable-gpu</code> flag to force CPU path
      </div>
    </div>
  {/if}
</div>

<style>
  .debug-container {
    position: fixed;
    inset: 0;
    background: #000;
    overflow: hidden;
  }

  .debug-canvas {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    object-fit: cover;
  }

  /* ─── Controls ─── */
  .controls {
    position: absolute;
    top: 8px;
    left: 8px;
    right: 8px;
    display: flex;
    flex-direction: column;
    gap: 4px;
    z-index: 10;
    pointer-events: none;
    max-height: 50%;
    overflow-y: auto;
  }

  .controls.hud-hidden {
    display: none;
  }

  .ctrl-row {
    display: flex;
    gap: 3px;
    align-items: center;
    background: rgba(0, 0, 0, 0.6);
    padding: 4px 6px;
    border-radius: 8px;
    backdrop-filter: blur(4px);
    pointer-events: auto;
    flex-wrap: wrap;
  }

  .ctrl-label {
    color: #6b6f83;
    font-size: 10px;
    font-family: monospace;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    margin-right: 2px;
    white-space: nowrap;
  }

  .ctrl-btn {
    background: rgba(255, 255, 255, 0.06);
    color: #8b8fa3;
    border: 1px solid rgba(255, 255, 255, 0.08);
    border-radius: 5px;
    padding: 3px 7px;
    font-size: 10px;
    font-family: monospace;
    cursor: pointer;
    transition: background 0.12s, color 0.12s, border-color 0.12s;
    white-space: nowrap;
    outline: none;
  }

  .ctrl-btn:focus-visible {
    outline: 2px solid rgba(167, 139, 250, 0.6);
    outline-offset: 1px;
  }

  .ctrl-btn:hover {
    background: rgba(255, 255, 255, 0.12);
    color: #e1e4ea;
  }

  .ctrl-btn.active {
    background: rgba(167, 139, 250, 0.2);
    color: #a78bfa;
    border-color: rgba(167, 139, 250, 0.35);
  }

  .ctrl-btn:disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }

  .ctrl-sep {
    width: 1px;
    height: 16px;
    background: rgba(255, 255, 255, 0.1);
    margin: 0 3px;
    flex-shrink: 0;
  }

  .bench-btn {
    background: rgba(250, 200, 100, 0.1);
    color: #f0c040;
    border-color: rgba(250, 200, 100, 0.2);
  }
  .bench-btn:hover {
    background: rgba(250, 200, 100, 0.2);
    color: #ffd866;
  }
  .bench-btn.active {
    background: rgba(255, 100, 100, 0.2);
    color: #f87171;
    border-color: rgba(255, 100, 100, 0.35);
  }

  .bench-phase {
    color: #f0c040;
    font-size: 10px;
    font-family: monospace;
    margin-left: 4px;
  }

  /* ─── FPS Overlay ─── */
  .fps-overlay {
    position: absolute;
    bottom: 10px;
    left: 10px;
    display: flex;
    gap: 5px;
    z-index: 10;
    pointer-events: none;
    user-select: none;
    flex-wrap: wrap;
    max-width: 90%;
  }

  .fps-card {
    background: rgba(0, 0, 0, 0.6);
    backdrop-filter: blur(4px);
    border-radius: 8px;
    padding: 5px 10px;
    display: flex;
    flex-direction: column;
    align-items: center;
    min-width: 55px;
    box-shadow: 0 3px 12px rgba(0,0,0,0.4);
  }

  .fps-card .fps-label {
    font-size: 9px;
    font-family: monospace;
    letter-spacing: 0.3px;
    opacity: 0.6;
  }

  .fps-card .fps-value {
    font-size: 20px;
    font-weight: 700;
    font-family: system-ui, -apple-system, sans-serif;
    line-height: 1.2;
  }

  .fps-card .fps-sub {
    font-size: 9px;
    font-family: monospace;
    opacity: 0.5;
  }

  .fps-card.render .fps-label { color: #e1e4ea; }
  .fps-card.render .fps-value { color: #e1e4ea; }

  .fps-card.detect .fps-label { color: rgba(167, 139, 250, 0.5); }
  .fps-card.detect .fps-value { color: #a78bfa; }

  .fps-card.info { min-width: auto; padding: 5px 8px; }
  .fps-card.info .fps-label { font-size: 9px; color: #6b6f83; }

  .fps-card.bench-log {
    min-width: 120px;
    max-height: 80px;
    overflow: hidden;
  }

  .bench-scroll {
    display: flex;
    flex-direction: column;
    gap: 1px;
    font-size: 9px;
    font-family: monospace;
    overflow-y: auto;
  }

  .bench-entry {
    color: #f0c040;
  }

  /* ─── Overlay ─── */
  .overlay {
    position: absolute;
    inset: 0;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    background: rgba(0, 0, 0, 0.8);
    padding: 2rem;
    z-index: 20;
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

  .loading .overlay-text {
    color: #8b8fa3;
  }

  .spinner {
    width: 32px;
    height: 32px;
    border: 3px solid rgba(167, 139, 250, 0.15);
    border-top-color: #a78bfa;
    border-radius: 50%;
    animation: spin 0.8s linear infinite;
    margin-bottom: 1rem;
  }

  @keyframes spin {
    to { transform: rotate(360deg); }
  }
</style>
