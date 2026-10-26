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

  // ── Zone state ──
  const ZONE_COUNT = 5;
  let zoneOffsets: number[] = [];
  let zoneWidths: number[] = [];
  let activeZones = $state<boolean[]>([false, false, false, false, false]);
  let facesInZone = $state<number[]>([0, 0, 0, 0, 0]);
  let minFaceSize = $state(160); // px min face bounding box height
  let facingThreshold = $state(0.28); // max nose deviation ratio
  let faceDetected = $state(false);
  let saved = $state(false); // brief "Saved" feedback

  // ── Draggable divider handles ──
  let dividers: number[] = []; // 4 divider x-positions (px on canvas)
  let draggingDivider = $state(-1); // index being dragged, -1 = none
  const MIN_ZONE = 40; // minimum px per zone
  const HANDLE_RADIUS = 8; // click radius for handle

  // ── Zone intensity level for indicator ──
  let zoneLevel = $derived.by(() => {
    if (activeZones[2]) return 3;          // zone 3 → 100%
    if (activeZones[1] || activeZones[3]) return 2;  // zone 2 or 4 → 50%
    if (activeZones[0] || activeZones[4]) return 1;  // zone 1 or 5 → 20%
    return 0;
  });
  let zoneOpacity = $derived([0, 0.2, 0.5, 1.0][zoneLevel]);
  let zoneTransition = $derived(`${[1, 1, 2, 3][zoneLevel]}s ease-in-out`);

  // EMA smoothing
  let smoothedFaces: any[][] | null = null;
  const SMOOTH_ALPHA = 0.35;

  const FACE_MODEL =
    "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/latest/face_landmarker.task";
  const WASM_CDN = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@latest/wasm";

  const ZONE_LABELS = ["1", "2", "3", "4", "5"];
  const ZONE_COLORS = [
    "#00dcff", // cyan
    "#ff6b9d", // pink
    "#a78bfa", // purple
    "#fbbf24", // amber
    "#34d399", // emerald
  ];

  // Key face landmarks
  const NOSE_TIP = 1;
  const LEFT_EYE_INNER = 33;
  const RIGHT_EYE_INNER = 263;
  const LEFT_EYE_OUTER = 234;
  const RIGHT_EYE_OUTER = 454;

  onMount(async () => {
    try {
      await initMediaPipe();
      await initCamera();
      loadSavedSettings();
      status = "Waiting for faces...";
      startDetectionLoop();
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
      numFaces: 5,
    });
  }

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
    canvas.width = video.videoWidth || 640;
    canvas.height = video.videoHeight || 480;
    // Zone 3 = 50%, zones 1,2,4,5 split the other 50% equally
    const w = canvas.width;
    const q = w / 8;        // 12.5%
    const hw = w / 2;        // 50%
    dividers = [q, 2 * q, 2 * q + hw, 3 * q + hw];
    recalcZones();
  }

  function recalcZones() {
    const zw: number[] = [];
    const zo: number[] = [];
    let prev = 0;
    for (let i = 0; i < ZONE_COUNT; i++) {
      zo.push(prev);
      const end = i < ZONE_COUNT - 1 ? dividers[i] : canvas.width;
      zw.push(end - prev);
      prev = end;
    }
    zoneWidths = zw;
    zoneOffsets = zo;
  }

  // ── Face analysis ──

  function getZoneIndex(x: number): number {
    for (let i = 0; i < ZONE_COUNT; i++) {
      if (x >= zoneOffsets[i] && x < zoneOffsets[i] + zoneWidths[i]) return i;
    }
    return ZONE_COUNT - 1;
  }

  function getFaceBboxHeight(lm: any[], h: number): number {
    let minY = Infinity, maxY = -Infinity;
    for (const p of lm) {
      if (!p) continue;
      const y = p.y * h;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
    return maxY - minY;
  }

  function getFaceBboxWidth(lm: any[], w: number): number {
    let minX = Infinity, maxX = -Infinity;
    for (const p of lm) {
      if (!p) continue;
      const x = p.x * w;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
    }
    return maxX - minX;
  }

  /** Returns true if the face is facing roughly toward the camera */
  function isFacingCamera(lm: any[]): boolean {
    const nose = lm[NOSE_TIP];
    const leftEye = lm[LEFT_EYE_OUTER];
    const rightEye = lm[RIGHT_EYE_OUTER];
    if (!nose || !leftEye || !rightEye) return false;

    // Eye midpoint (in camera-normalized coords)
    const eyeMidX = (leftEye.x + rightEye.x) / 2;
    // Face width as inter-ocular distance
    const faceWidth = Math.abs(leftEye.x - rightEye.x);
    if (faceWidth < 0.01) return false;

    // How far nose is from eye midpoint, normalized by face width
    const deviation = Math.abs(nose.x - eyeMidX) / faceWidth;
    return deviation < facingThreshold;
  }

  /** Get face center x in mirrored pixel coords using nose */
  function getFaceCenterX(lm: any[], w: number): number {
    const nose = lm[NOSE_TIP];
    return nose ? w - nose.x * w : w / 2;
  }

  function startDetectionLoop() {
    function detect() {
      if (!running || !video) return;
      if (video.readyState >= 2) {
        const now = performance.now();
        const result = faceLandmarkerInstance
          ? faceLandmarkerInstance.detectForVideo(video, now)
          : null;

        const rawFaces: any[][] = result?.faceLandmarks ?? [];

        // Smooth
        if (rawFaces.length > 0) {
          if (!smoothedFaces || smoothedFaces.length !== rawFaces.length) {
            smoothedFaces = rawFaces.map((face: any[]) =>
              face.map((lm: any) => ({ x: lm.x, y: lm.y, z: lm.z }))
            );
          } else {
            for (let f = 0; f < rawFaces.length; f++) {
              for (let i = 0; i < rawFaces[f].length; i++) {
                const s = smoothedFaces[f][i];
                const r = rawFaces[f][i];
                if (s && r) {
                  s.x += (r.x - s.x) * SMOOTH_ALPHA;
                  s.y += (r.y - s.y) * SMOOTH_ALPHA;
                  s.z += (r.z - s.z) * SMOOTH_ALPHA;
                }
              }
            }
          }
        } else {
          smoothedFaces = null;
        }

        // Detect zones from raw faces (not smoothed — faster response)
        const newActive = [false, false, false, false, false];
        const newCount = [0, 0, 0, 0, 0];
        const w = canvas.width;
        const h = canvas.height;
        let anyValid = false;

        for (const lm of rawFaces) {
          // 1. Must be close enough (large bbox)
          const bboxH = getFaceBboxHeight(lm, h);
          if (bboxH < minFaceSize) continue;

          // 2. Must be facing camera
          if (!isFacingCamera(lm)) continue;

          anyValid = true;
          const cx = getFaceCenterX(lm, w);
          const zi = getZoneIndex(cx);
          newActive[zi] = true;
          newCount[zi]++;
        }

        faceDetected = anyValid;
        activeZones = newActive;
        facesInZone = newCount;

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

  let savedTimer: ReturnType<typeof setTimeout> | null = null;

  function saveSettings() {
    const data = {
      dividerRatios: dividers.map(d => d / canvas.width),
      minFaceSize,
      facingThreshold,
    };
    localStorage.setItem("creka_zone_detect", JSON.stringify(data));
    saved = true;
    if (savedTimer) clearTimeout(savedTimer);
    savedTimer = setTimeout(() => { saved = false; }, 1500);
  }

  function loadSavedSettings() {
    const raw = localStorage.getItem("creka_zone_detect");
    if (!raw) return;
    try {
      const data = JSON.parse(raw);
      if (data.minFaceSize) minFaceSize = data.minFaceSize;
      if (data.facingThreshold) facingThreshold = data.facingThreshold;
      if (data.dividerRatios && data.dividerRatios.length === 4) {
        dividers = data.dividerRatios.map((r: number) => r * canvas.width);
        recalcZones();
      }
    } catch { /* ignore corrupt data */ }
  }

  // ── Mouse drag handling ──

  function getCanvasCoords(e: MouseEvent | TouchEvent): { x: number; y: number } {
    const rect = canvas.getBoundingClientRect();
    const clientX = 'touches' in e ? (e as TouchEvent).touches[0].clientX : (e as MouseEvent).clientX;
    const clientY = 'touches' in e ? (e as TouchEvent).touches[0].clientY : (e as MouseEvent).clientY;
    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;
    return { x: (clientX - rect.left) * scaleX, y: (clientY - rect.top) * scaleY };
  }

  function handlePointerDown(e: MouseEvent | TouchEvent) {
    const { x } = getCanvasCoords(e);
    for (let i = 0; i < dividers.length; i++) {
      if (Math.abs(x - dividers[i]) <= HANDLE_RADIUS) {
        draggingDivider = i;
        e.preventDefault();
        return;
      }
    }
  }

  function handlePointerMove(e: MouseEvent | TouchEvent) {
    if (draggingDivider < 0) return;
    const { x } = getCanvasCoords(e);
    const i = draggingDivider;
    // Clamp between neighbors
    const leftBound = i > 0 ? dividers[i - 1] + MIN_ZONE : MIN_ZONE;
    const rightBound = i < dividers.length - 1 ? dividers[i + 1] - MIN_ZONE : canvas.width - MIN_ZONE;
    dividers[i] = Math.max(leftBound, Math.min(rightBound, x));
    recalcZones();
    e.preventDefault();
  }

  function handlePointerUp() {
    draggingDivider = -1;
  }

  // ── Drawing ──

  function drawFrame() {
    if (!video) return;
    const ctx = canvas.getContext("2d")!;
    const w = canvas.width;
    const h = canvas.height;

    // Mirrored webcam
    ctx.save();
    ctx.scale(-1, 1);
    ctx.drawImage(video, -w, 0, w, h);
    ctx.restore();

    // Draw zones
    drawZones(ctx, w, h);

    // Draw divider handles
    drawHandles(ctx, w, h);

    // Draw face indicators
    if (smoothedFaces) {
      for (let f = 0; f < smoothedFaces.length; f++) {
        const lm = smoothedFaces[f];
        const bboxH = getFaceBboxHeight(lm, h);
        if (bboxH < minFaceSize) continue;
        const facing = isFacingCamera(lm);
        const cx = getFaceCenterX(lm, w);
        const zi = getZoneIndex(cx);
        drawFaceIndicator(ctx, lm, w, h, ZONE_COLORS[zi], facing);
      }
    }

    // HUD
    drawHUD(ctx, w, h);
  }

  function drawZones(ctx: CanvasRenderingContext2D, w: number, h: number) {
    for (let i = 0; i < ZONE_COUNT; i++) {
      const x = zoneOffsets[i];
      const zw = zoneWidths[i];
      const active = activeZones[i];
      const color = ZONE_COLORS[i];
      const alpha = active ? 0.7 : 0.3;

      ctx.fillStyle = `${color}${Math.round(alpha * 255).toString(16).padStart(2, "0")}`;
      ctx.fillRect(x, 0, zw, h);

      // Borders
      ctx.strokeStyle = active ? color : "rgba(255,255,255,0.08)";
      ctx.lineWidth = active ? 2 : 1;
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, h);
      ctx.stroke();

      // Label
      ctx.save();
      ctx.shadowColor = "rgba(0,0,0,0.6)";
      ctx.shadowBlur = 8;
      ctx.fillStyle = active ? color : "rgba(255,255,255,0.15)";
      ctx.font = `bold ${active ? 16 : 12}px system-ui, sans-serif`;
      ctx.textAlign = "center";
      ctx.textBaseline = "top";
      ctx.fillText(`Zone ${ZONE_LABELS[i]}`, x + zw / 2, 12);
      ctx.shadowBlur = 0;

      if (active && facesInZone[i] > 0) {
        ctx.fillStyle = "#ffffff";
        ctx.font = "10px monospace";
        ctx.textBaseline = "bottom";
        ctx.fillText(`${facesInZone[i]} ${facesInZone[i] === 1 ? "face" : "faces"}`, x + zw / 2, h - 12);
      }
      ctx.restore();
    }

    // Rightmost border
    ctx.strokeStyle = "rgba(255,255,255,0.08)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(w, 0);
    ctx.lineTo(w, h);
    ctx.stroke();
  }

  function drawHandles(ctx: CanvasRenderingContext2D, w: number, h: number) {
    const handleH = 24;
    const handleW = 10;
    const y = h - handleH - 4;
    for (let i = 0; i < dividers.length; i++) {
      const cx = dividers[i];
      const x = cx - handleW / 2;
      ctx.save();
      ctx.shadowColor = "rgba(0,0,0,0.5)";
      ctx.shadowBlur = 8;
      ctx.fillStyle = draggingDivider === i ? "#ffffff" : "rgba(255,255,255,0.7)";
      ctx.beginPath();
      ctx.roundRect(x, y, handleW, handleH, 4);
      ctx.fill();
      ctx.shadowBlur = 0;
      ctx.strokeStyle = draggingDivider === i ? "#a78bfa" : "rgba(0,0,0,0.2)";
      ctx.lineWidth = 1;
      for (let g = 0; g < 3; g++) {
        const gy = y + 5 + g * 7;
        ctx.beginPath();
        ctx.moveTo(cx - 2.5, gy);
        ctx.lineTo(cx + 2.5, gy);
        ctx.stroke();
      }
      ctx.restore();
    }
  }

  /** Face contour key indices for drawing */
  const FACE_CONTOURS: number[][] = [
    [10, 338, 297, 332, 284, 251, 389, 356, 454, 323, 361, 288, 397, 365, 379, 378, 400, 377, 152, 148, 176, 149, 150, 136, 172, 58, 132, 93, 234, 127, 162, 21, 54, 103, 67, 109, 10],
    [46, 53, 52, 65, 55, 70, 63, 105, 66, 107],
    [276, 283, 282, 295, 285, 300, 293, 334, 296, 336],
  ];

  function drawFaceIndicator(
    ctx: CanvasRenderingContext2D,
    lm: any[],
    w: number,
    h: number,
    color: string,
    facing: boolean
  ) {
    ctx.save();
    ctx.globalAlpha = facing ? 0.55 : 0.2;

    // Face contour
    ctx.strokeStyle = color;
    ctx.lineWidth = facing ? 1.5 : 0.8;
    for (const contour of FACE_CONTOURS) {
      ctx.beginPath();
      for (let i = 0; i < contour.length; i++) {
        const p = lm[contour[i]];
        if (!p) continue;
        const x = w - p.x * w, y = p.y * h;
        if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      }
      ctx.stroke();
    }

    // Eye dots
    for (const idx of [LEFT_EYE_INNER, RIGHT_EYE_INNER, LEFT_EYE_OUTER, RIGHT_EYE_OUTER]) {
      const p = lm[idx];
      if (!p) continue;
      ctx.beginPath();
      ctx.arc(w - p.x * w, p.y * h, facing ? 3 : 1.5, 0, Math.PI * 2);
      ctx.fillStyle = facing ? color : "rgba(255,255,255,0.2)";
      ctx.fill();
    }

    // Nose tip (more prominent)
    const nose = lm[NOSE_TIP];
    if (nose) {
      const nx = w - nose.x * w, ny = nose.y * h;
      ctx.beginPath();
      ctx.arc(nx, ny, facing ? 4 : 2, 0, Math.PI * 2);
      ctx.fillStyle = facing ? "#ffffff" : "rgba(255,255,255,0.15)";
      ctx.fill();
    }

    // Facing badge
    if (!facing) {
      const nose2 = lm[NOSE_TIP];
      if (nose2) {
        ctx.fillStyle = "rgba(255,255,255,0.15)";
        ctx.font = "9px monospace";
        ctx.textAlign = "center";
        ctx.textBaseline = "bottom";
        ctx.fillText("turned", w - nose2.x * w, nose2.y * h - 16);
      }
    }

    ctx.restore();
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
    ctx.restore();

    // Legend at bottom-left
    const legendY = h - 40;
    ctx.save();
    ctx.fillStyle = "rgba(0, 0, 0, 0.45)";
    ctx.beginPath();
    ctx.roundRect(12, legendY, 160, 28, 8);
    ctx.fill();

    let lx = 20;
    for (let i = 0; i < ZONE_COUNT; i++) {
      ctx.fillStyle = activeZones[i] ? ZONE_COLORS[i] : "rgba(255,255,255,0.12)";
      ctx.beginPath();
      ctx.arc(lx, legendY + 14, 4, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = activeZones[i] ? ZONE_COLORS[i] : "rgba(255,255,255,0.12)";
      ctx.font = "8px monospace";
      ctx.textAlign = "center";
      ctx.textBaseline = "top";
      ctx.fillText(ZONE_LABELS[i], lx, legendY + 18);
      lx += 26;
    }
    ctx.restore();

    // Status bar
    const barH = 28;
    const statusText = faceDetected
      ? `●  ${activeZones.filter(Boolean).length} zone(s) active`
      : "○  no face in range / facing away";
    ctx.font = "12px monospace";
    const sw = ctx.measureText(statusText).width;
    const barW = sw + 24;
    const bx = (w - barW) / 2;
    const by = h - 48;

    ctx.save();
    ctx.shadowColor = "rgba(0,0,0,0.5)";
    ctx.shadowBlur = 12;
    ctx.fillStyle = faceDetected ? "rgba(0, 20, 40, 0.7)" : "rgba(0, 0, 0, 0.5)";
    ctx.beginPath();
    ctx.roundRect(bx, by, barW, barH, 14);
    ctx.fill();
    ctx.shadowBlur = 0;
    ctx.fillStyle = faceDetected ? "#a78bfa" : "#888";
    ctx.textBaseline = "middle";
    ctx.textAlign = "center";
    ctx.fillText(statusText, bx + barW / 2, by + barH / 2);
    ctx.restore();
  }
</script>

<div class="zone-detect-page">
  <div class="zone-detect-container">
    <canvas bind:this={canvas}
      class="zone-detect-canvas"
      onmousedown={handlePointerDown}
      onmousemove={handlePointerMove}
      onmouseup={handlePointerUp}
      onmouseleave={handlePointerUp}
      ontouchstart={handlePointerDown}
      ontouchmove={handlePointerMove}
      ontouchend={handlePointerUp}
      ontouchcancel={handlePointerUp}
      class:dragging={draggingDivider >= 0}
    ></canvas>
    {#if error}
      <div class="overlay error">
        <div class="overlay-icon">⚠️</div>
        <div class="overlay-text">{error}</div>
      </div>
    {/if}
  </div>
  <div class="zone-detect-controls">
    <label class="slider-label">
      <span>Min face size</span>
      <input type="range" bind:value={minFaceSize} min="60" max="400" class="slider" />
      <span class="slider-val">{minFaceSize}px</span>
    </label>
    <label class="slider-label">
      <span>Facing tolerance</span>
      <input type="range" bind:value={facingThreshold} min="0.08" max="0.50" step="0.01" class="slider" />
      <span class="slider-val">{facingThreshold.toFixed(2)}</span>
    </label>
    <div class="zone-legend">
      {#each ZONE_LABELS as label, i}
        <div class="zone-dot" class:active={activeZones[i]} style="--zone-color: {ZONE_COLORS[i]}">
          <span class="zone-dot-label">{label}</span>
        </div>
      {/each}
    </div>
    <div class="zone-indicator" style="opacity: {zoneOpacity}; transition: opacity {zoneTransition}"></div>
    <button class="save-btn" onclick={saveSettings}>
      {saved ? "✓ Saved" : "Save"}
    </button>
  </div>
  <div class="zone-detect-footer">
    <span class="footer-label">Zone Detect — face proximity + facing-camera detection</span>
  </div>
</div>

<style>
  .zone-detect-page {
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

  .zone-detect-container {
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

  .zone-detect-canvas {
    display: block;
    max-width: 100%;
    max-height: calc(100vh - 140px);
    object-fit: contain;
    border-radius: 16px;
    touch-action: none;
  }

  .zone-detect-canvas.dragging {
    cursor: grabbing;
  }

  .zone-detect-controls {
    display: flex;
    gap: 24px;
    align-items: center;
  }

  .slider-label {
    display: flex;
    align-items: center;
    gap: 8px;
    color: #888;
    font-size: 0.75rem;
    font-family: monospace;
  }

  .slider {
    width: 120px;
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
    width: 14px;
    height: 14px;
    border-radius: 50%;
    background: #a78bfa;
    cursor: pointer;
    border: none;
  }

  .slider-val {
    color: #a78bfa;
    min-width: 40px;
    text-align: right;
  }

  .zone-legend {
    display: flex;
    gap: 8px;
    align-items: center;
  }

  .zone-dot {
    width: 28px;
    height: 28px;
    border-radius: 8px;
    background: color-mix(in srgb, var(--zone-color) 30%, transparent);
    border: 1px solid color-mix(in srgb, var(--zone-color) 20%, transparent);
    display: flex;
    align-items: center;
    justify-content: center;
    transition: background 0.15s, border-color 0.15s;
  }

  .zone-dot.active {
    background: color-mix(in srgb, var(--zone-color) 70%, transparent);
    border-color: var(--zone-color);
  }

  .zone-dot-label {
    font-size: 0.65rem;
    font-family: monospace;
    color: rgba(255, 255, 255, 0.5);
  }

  .zone-dot.active .zone-dot-label {
    color: #ffffff;
  }

  .zone-indicator {
    width: 144px;
    height: 48px;
    border-radius: 12px;
    background: #ffffff;
    flex-shrink: 0;
  }

  .save-btn {
    height: 48px;
    padding: 0 20px;
    border-radius: 12px;
    border: 1px solid rgba(255,255,255,0.1);
    background: rgba(255,255,255,0.04);
    color: #8b8fa3;
    font-family: monospace;
    font-size: 0.8rem;
    cursor: pointer;
    transition: background 0.15s, color 0.15s, border-color 0.15s;
    flex-shrink: 0;
  }

  .save-btn:hover {
    background: rgba(255,255,255,0.08);
    color: #e1e4ea;
    border-color: rgba(255,255,255,0.2);
  }

  .zone-detect-footer {
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
