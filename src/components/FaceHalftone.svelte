<script lang="ts">
  import { onMount, onDestroy } from "svelte";

  let canvas: HTMLCanvasElement;
  let status = $state("Initializing...");
  let fps = $state(0);
  let error = $state<string | null>(null);

  let video: HTMLVideoElement | null = null;
  let stream: MediaStream | null = null;
  let faceLandmarkerInstance: any;
  let running = true;
  let frameCount = 0;
  let lastFpsUpdate = 0;

  let faceDetected = $state(false);

  // Halftone settings
  let dotSize = $state(6);
  let dotGap = $state(0);
  let contrast = $state(1.0);
  let minDot = $state(0.5);
  let colorMode = $state<"color" | "mono" | "invert">("color");
  let dotShape = $state<"circle" | "square" | "diamond">("circle");
  let hue = $state(200); // for mono tint
  let bgMode = $state<"black" | "white">("black");
  let bgAlpha = $state(0.85);
  let showMesh = $state(true);
  let saved = $state(false);
  let savedTimer: ReturnType<typeof setTimeout> | null = null;

  function saveSettings() {
    const data = { dotSize, dotGap, contrast, minDot, colorMode, dotShape, hue, bgMode, bgAlpha, showMesh };
    localStorage.setItem("creka_face_halftone", JSON.stringify(data));
    saved = true;
    if (savedTimer) clearTimeout(savedTimer);
    savedTimer = setTimeout(() => { saved = false; }, 1500);
  }

  function loadSettings() {
    const raw = localStorage.getItem("creka_face_halftone");
    if (!raw) return;
    try {
      const d = JSON.parse(raw);
      if (d.dotSize !== undefined) dotSize = d.dotSize;
      if (d.dotGap !== undefined) dotGap = d.dotGap;
      if (d.contrast !== undefined) contrast = d.contrast;
      if (d.minDot !== undefined) minDot = d.minDot;
      if (d.colorMode !== undefined) colorMode = d.colorMode;
      if (d.dotShape !== undefined) dotShape = d.dotShape;
      if (d.hue !== undefined) hue = d.hue;
      if (d.bgMode !== undefined) bgMode = d.bgMode;
      if (d.bgAlpha !== undefined) bgAlpha = d.bgAlpha;
      if (d.showMesh !== undefined) showMesh = d.showMesh;
    } catch { /* ignore */ }
  }

  let smoothedFace: any[] | null = null;
  const SMOOTH_ALPHA = 0.35;

  const FACE_MODEL =
    "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/latest/face_landmarker.task";
  const WASM_CDN = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@latest/wasm";

  const FACE_CONTOUR: number[][] = [
    [10, 338, 297, 332, 284, 251, 389, 356, 454, 323, 361, 288, 397, 365, 379, 378, 400, 377, 152, 148, 176, 149, 150, 136, 172, 58, 132, 93, 234, 127, 162, 21, 54, 103, 67, 109, 10],
    [33, 7, 163, 144, 145, 153, 154, 155, 133, 173, 157, 158, 159, 160, 161, 246, 33],
    [362, 382, 381, 380, 374, 373, 390, 249, 263, 466, 388, 387, 386, 385, 384, 398, 362],
    [46, 53, 52, 65, 55, 70, 63, 105, 66, 107],
    [276, 283, 282, 295, 285, 300, 293, 334, 296, 336],
    [61, 146, 91, 181, 84, 17, 314, 405, 321, 375, 291, 409, 270, 269, 267, 0, 37, 39, 40, 185, 61],
    [78, 191, 80, 81, 82, 13, 312, 311, 310, 415, 308, 324, 318, 402, 317, 14, 87, 178, 88, 95, 78],
    [168, 6, 197, 195, 5],
  ];

  onMount(async () => {
    try {
      await initMediaPipe();
      await initCamera();
      loadSettings();
      status = "Halftoning...";
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
    if (faceLandmarkerInstance) faceLandmarkerInstance.close();
  });

  async function initMediaPipe() {
    const { FilesetResolver, FaceLandmarker } = await import("@mediapipe/tasks-vision");
    const vision = await FilesetResolver.forVisionTasks(WASM_CDN);
    status = "Loading face model...";
    faceLandmarkerInstance = await FaceLandmarker.createFromOptions(vision, {
      baseOptions: { modelAssetPath: FACE_MODEL, delegate: "GPU" },
      runningMode: "VIDEO",
      outputFaceBlendshapes: false,
      outputFacialTransformationMatrixes: false,
      numFaces: 1,
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
    function detect() {
      if (!running || !video) return;
      if (video.readyState >= 2) {
        const now = performance.now();
        const result = faceLandmarkerInstance
          ? faceLandmarkerInstance.detectForVideo(video, now)
          : null;

        const raw = result?.faceLandmarks?.[0] ?? null;

        if (raw) {
          if (!smoothedFace || smoothedFace.length !== raw.length) {
            smoothedFace = raw.map((lm: any) => ({ x: lm.x, y: lm.y, z: lm.z }));
          } else {
            for (let i = 0; i < raw.length; i++) {
              const s = smoothedFace[i], r = raw[i];
              if (s && r) {
                s.x += (r.x - s.x) * SMOOTH_ALPHA;
                s.y += (r.y - s.y) * SMOOTH_ALPHA;
                s.z += (r.z - s.z) * SMOOTH_ALPHA;
              }
            }
          }
          faceDetected = true;
        } else {
          smoothedFace = null;
          faceDetected = false;
        }

        drawFrame();
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

  function drawFrame() {
    if (!video) return;
    const ctx = canvas.getContext("2d")!;
    const w = canvas.width;
    const h = canvas.height;

    ctx.save();
    ctx.scale(-1, 1);
    ctx.drawImage(video, -w, 0, w, h);
    ctx.restore();

    if (bgMode === "black") {
      ctx.fillStyle = `rgba(0, 0, 0, ${bgAlpha})`;
    } else {
      ctx.fillStyle = `rgba(255, 255, 255, ${bgAlpha})`;
    }
    ctx.fillRect(0, 0, w, h);

    if (!smoothedFace) { drawHUD(ctx, w, h); return; }

    // Face bounding box
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const p of smoothedFace) {
      if (!p) continue;
      const mx = w - p.x * w, my = p.y * h;
      if (mx < minX) minX = mx;
      if (mx > maxX) maxX = mx;
      if (my < minY) minY = my;
      if (my > maxY) maxY = my;
    }
    const padX = (maxX - minX) * 0.2, padY = (maxY - minY) * 0.2;
    const fx = Math.max(0, minX - padX), fy = Math.max(0, minY - padY);
    const fw = Math.min(w - fx, maxX - minX + padX * 2), fh = Math.min(h - fy, maxY - minY + padY * 2);

    // Original pixels for sampling
    const offscreen = new OffscreenCanvas(w, h);
    const offCtx = offscreen.getContext("2d")!;
    offCtx.save();
    offCtx.scale(-1, 1);
    offCtx.drawImage(video, -w, 0, w, h);
    offCtx.restore();
    const orig = offCtx.getImageData(0, 0, w, h).data;

    // Face contour points for point-in-polygon
    const facePoints = FACE_CONTOUR[0].map(idx => {
      const p = smoothedFace[idx];
      return p ? { x: w - p.x * w, y: p.y * h } : null;
    }).filter(p => p !== null) as { x: number; y: number }[];

    // Compute mono lookup table for speed
    const cell = Math.max(2, dotSize);
    const step = cell + dotGap;
    const rows = Math.ceil(fh / step);
    const cols = Math.ceil(fw / step);

    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const cx = fx + c * step + cell / 2;
        const cy = fy + r * step + cell / 2;

        // Point-in-polygon
        let inside = false;
        for (let i = 0, j = facePoints.length - 1; i < facePoints.length; j = i++) {
          const pi = facePoints[i], pj = facePoints[j];
          if (pi.y > cy !== pj.y > cy && cx < (pj.x - pi.x) * (cy - pi.y) / (pj.y - pi.y) + pi.x) inside = !inside;
        }
        if (!inside) continue;

        const sx = Math.min(Math.floor(cx), w - 1);
        const sy = Math.min(Math.floor(cy), h - 1);
        const pi = (sy * w + sx) * 4;

        const rVal = orig[pi], gVal = orig[pi + 1], bVal = orig[pi + 2];
        const br = (rVal * 0.299 + gVal * 0.587 + bVal * 0.114) / 255;
        let dotR = (cell / 2) * Math.pow(1 - br, contrast) * 0.9;
        if (dotR < minDot) continue;

        // Color
        let fill: string;
        if (colorMode === "mono") {
          const shade = Math.round(br * 255);
          fill = `hsl(${hue}, 0%, ${shade}%)`;
        } else if (colorMode === "invert") {
          fill = `rgb(${255 - rVal},${255 - gVal},${255 - bVal})`;
        } else {
          fill = `rgb(${rVal},${gVal},${bVal})`;
        }

        ctx.fillStyle = fill;

        if (dotShape === "circle") {
          ctx.beginPath();
          ctx.arc(cx, cy, dotR, 0, Math.PI * 2);
          ctx.fill();
        } else if (dotShape === "square") {
          ctx.fillRect(cx - dotR, cy - dotR, dotR * 2, dotR * 2);
        } else if (dotShape === "diamond") {
          ctx.save();
          ctx.translate(cx, cy);
          ctx.rotate(Math.PI / 4);
          ctx.fillRect(-dotR, -dotR, dotR * 2, dotR * 2);
          ctx.restore();
        }
      }
    }

    // Face mesh
    if (showMesh) {
      ctx.save();
      ctx.strokeStyle = "rgba(0, 220, 255, 0.25)";
      ctx.lineWidth = 1;
      for (const contour of FACE_CONTOUR) {
        ctx.beginPath();
        for (let i = 0; i < contour.length; i++) {
          const p = smoothedFace[contour[i]];
          if (!p) continue;
          const x = w - p.x * w, y = p.y * h;
          if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
        }
        ctx.stroke();
      }
      ctx.restore();
    }

    drawHUD(ctx, w, h);
  }

  function drawHUD(ctx: CanvasRenderingContext2D, w: number, h: number) {
    ctx.save();
    ctx.fillStyle = "rgba(0, 0, 0, 0.45)";
    ctx.beginPath(); ctx.roundRect(12, 12, 70, 22, 6); ctx.fill();
    ctx.fillStyle = "#00dcff";
    ctx.font = "11px monospace";
    ctx.textBaseline = "middle"; ctx.textAlign = "left";
    ctx.fillText(`${fps} fps`, 18, 23);
    if (faceDetected) {
      ctx.fillStyle = "rgba(0, 0, 0, 0.45)";
      ctx.beginPath(); ctx.roundRect(12, 40, 80, 22, 6); ctx.fill();
      ctx.fillStyle = "#00dcff";
      ctx.font = "10px monospace";
      ctx.fillText("● face mesh", 18, 51);
    }
    ctx.restore();
    const barH = 28;
    const statusText = faceDetected ? "●  face mesh halftone" : "○  no face";
    ctx.font = "12px monospace";
    const sw = ctx.measureText(statusText).width;
    const barW = sw + 24;
    const bx = (w - barW) / 2, by = h - 44;
    ctx.save();
    ctx.shadowColor = "rgba(0,0,0,0.5)"; ctx.shadowBlur = 12;
    ctx.fillStyle = faceDetected ? "rgba(0, 20, 40, 0.7)" : "rgba(0, 0, 0, 0.5)";
    ctx.beginPath(); ctx.roundRect(bx, by, barW, barH, 14); ctx.fill();
    ctx.shadowBlur = 0;
    ctx.fillStyle = faceDetected ? "#00dcff" : "#888";
    ctx.textBaseline = "middle"; ctx.textAlign = "center";
    ctx.fillText(statusText, bx + barW / 2, by + barH / 2);
    ctx.restore();
  }
</script>

<div class="halftone-page">
  <div class="halftone-container">
    <canvas bind:this={canvas} class="halftone-canvas"></canvas>
    {#if error}
      <div class="overlay error">
        <div class="overlay-icon">⚠️</div>
        <div class="overlay-text">{error}</div>
      </div>
    {/if}
  </div>
  <div class="halftone-controls">
    <div class="control-group">
      <span class="group-label">Dot</span>
      <label class="slider-label">
        <span>Size</span>
        <input type="range" bind:value={dotSize} min="2" max="40" class="slider" />
        <span class="slider-val">{dotSize}px</span>
      </label>
      <label class="slider-label">
        <span>Gap</span>
        <input type="range" bind:value={dotGap} min="-20" max="20" class="slider" />
        <span class="slider-val">{dotGap}px</span>
      </label>
      <label class="slider-label">
        <span>Min</span>
        <input type="range" bind:value={minDot} min="0" max="3" step="0.1" class="slider" />
        <span class="slider-val">{minDot.toFixed(1)}</span>
      </label>
      <label class="slider-label">
        <span>Contrast</span>
        <input type="range" bind:value={contrast} min="0.2" max="2.0" step="0.1" class="slider" />
        <span class="slider-val">{contrast.toFixed(1)}</span>
      </label>
    </div>
    <div class="control-group">
      <span class="group-label">Shape</span>
      <div class="btn-row">
        <button class="mode-btn" class:active={dotShape === "circle"} onclick={() => dotShape = "circle"}>Circle</button>
        <button class="mode-btn" class:active={dotShape === "square"} onclick={() => dotShape = "square"}>Square</button>
        <button class="mode-btn" class:active={dotShape === "diamond"} onclick={() => dotShape = "diamond"}>Diamond</button>
      </div>
    </div>
    <div class="control-group">
      <span class="group-label">Color</span>
      <div class="btn-row">
        <button class="mode-btn" class:active={colorMode === "color"} onclick={() => colorMode = "color"}>Color</button>
        <button class="mode-btn" class:active={colorMode === "mono"} onclick={() => colorMode = "mono"}>Mono</button>
        <button class="mode-btn" class:active={colorMode === "invert"} onclick={() => colorMode = "invert"}>Invert</button>
      </div>
      {#if colorMode === "mono"}
        <label class="slider-label">
          <span>Hue</span>
          <input type="range" bind:value={hue} min="0" max="360" class="slider" />
          <span class="slider-val">{hue}°</span>
        </label>
      {/if}
    </div>
    <div class="control-group">
      <span class="group-label">BG</span>
      <div class="btn-row">
        <button class="mode-btn" class:active={bgMode === "black"} onclick={() => bgMode = "black"}>Black</button>
        <button class="mode-btn" class:active={bgMode === "white"} onclick={() => bgMode = "white"}>White</button>
      </div>
    </div>
    <div class="control-group">
      <span class="group-label">Mesh</span>
      <div class="btn-row">
        <button class="mode-btn" class:active={showMesh} onclick={() => showMesh = !showMesh}>{showMesh ? "On" : "Off"}</button>
      </div>
      <label class="slider-label">
        <span>Alpha</span>
        <input type="range" bind:value={bgAlpha} min="0" max="1" step="0.05" class="slider" />
        <span class="slider-val">{bgAlpha.toFixed(2)}</span>
      </label>
    </div>
  </div>
  <div class="halftone-footer">
    <span class="footer-label">Face Halftone — face mesh + stippled halftone</span>
    <button class="save-btn" onclick={saveSettings}>
      {saved ? "✓ Saved" : "Save"}
    </button>
  </div>
</div>

<style>
  .halftone-page {
    position: fixed;
    inset: 0;
    background: #0a0a0f;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    padding: 24px;
    gap: 12px;
  }

  .halftone-container {
    position: relative;
    background: #000;
    border-radius: 16px;
    overflow: hidden;
    box-shadow: 0 0 60px rgba(0, 0, 0, 0.8), 0 0 120px rgba(100, 100, 200, 0.06);
    flex-shrink: 0;
    max-width: 100%;
    max-height: calc(100vh - 180px);
    display: flex;
    align-items: center;
    justify-content: center;
  }

  .halftone-canvas {
    display: block;
    max-width: 100%;
    max-height: calc(100vh - 180px);
    object-fit: contain;
    border-radius: 16px;
  }

  .halftone-controls {
    display: flex;
    gap: 16px;
    flex-wrap: wrap;
    justify-content: center;
    max-width: 100%;
  }

  .control-group {
    display: flex;
    flex-direction: column;
    gap: 4px;
    padding: 8px 10px;
    border-radius: 10px;
    background: rgba(255,255,255,0.03);
    border: 1px solid rgba(255,255,255,0.05);
  }

  .group-label {
    font-size: 0.6rem;
    font-family: monospace;
    color: rgba(255,255,255,0.2);
    text-transform: uppercase;
    letter-spacing: 0.1em;
    margin-bottom: 2px;
  }

  .btn-row {
    display: flex;
    gap: 4px;
  }

  .slider-label {
    display: flex;
    align-items: center;
    gap: 6px;
    color: #888;
    font-size: 0.7rem;
    font-family: monospace;
  }

  .slider {
    width: 80px;
    height: 4px;
    -webkit-appearance: none;
    appearance: none;
    background: #2a2d37;
    border-radius: 2px;
    outline: none;
    cursor: pointer;
  }

  .slider::-webkit-slider-thumb {
    -webkit-appearance: none;
    appearance: none;
    width: 12px;
    height: 12px;
    border-radius: 50%;
    background: #00dcff;
    cursor: pointer;
    border: none;
  }

  .slider-val {
    color: #00dcff;
    min-width: 32px;
    text-align: right;
    font-size: 0.65rem;
  }

  .mode-btn {
    padding: 4px 10px;
    border-radius: 6px;
    border: 1px solid rgba(255,255,255,0.08);
    background: rgba(255,255,255,0.04);
    color: #8b8fa3;
    font-family: monospace;
    font-size: 0.65rem;
    cursor: pointer;
    transition: background 0.15s, color 0.15s, border-color 0.15s;
  }

  .mode-btn:hover {
    background: rgba(255,255,255,0.08);
    color: #e1e4ea;
  }

  .mode-btn.active {
    background: rgba(0, 220, 255, 0.1);
    border-color: #00dcff;
    color: #00dcff;
  }

  .halftone-footer {
    text-align: center;
    opacity: 0.4;
  }

  .footer-label {
    color: #666;
    font-size: 0.75rem;
    font-family: monospace;
    letter-spacing: 0.05em;
  }

  .save-btn {
    padding: 4px 14px;
    border-radius: 6px;
    border: 1px solid rgba(255,255,255,0.1);
    background: rgba(255,255,255,0.04);
    color: #8b8fa3;
    font-family: monospace;
    font-size: 0.65rem;
    cursor: pointer;
    transition: background 0.15s, color 0.15s;
    flex-shrink: 0;
  }
  .save-btn:hover {
    background: rgba(255,255,255,0.08);
    color: #e1e4ea;
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
  .overlay.error .overlay-icon { font-size: 3rem; margin-bottom: 1rem; }
  .overlay-text { color: #f87171; font-size: 1.2rem; }
</style>
