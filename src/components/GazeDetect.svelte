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

  // ── Gaze state ──
  let faceDetected = $state(false);
  let headYaw = $state(0);    // -1 (left) to +1 (right)
  let eyeOffsetX = $state(0);  // -1 to +1 combined from both eyes
  let gazeX = $state(0);       // -1 to +1 combined
  let gazeY = $state(0);       // -1 to +1 combined
  let gazeZone = $state("—");
  let activePanel = $state<{ row: number; col: number } | null>(null);
  let panelKey = $state<string | null>(null);
  const GRID_ROWS = 2;
  const GRID_COLS = 4;
  const PANEL_NAMES = ["A1","A2","A3","A4","B1","B2","B3","B4"];

  // ── Per-panel transition tracking ──
  let panelAlpha = $state([0, 0, 0, 0, 0, 0, 0, 0]); // 0–1 displayed alpha per panel
  let panelLastGaze = $state([0, 0, 0, 0, 0, 0, 0, 0]); // timestamp when gaze left each panel
  let panelGazeNow = $state([false, false, false, false, false, false, false, false]);
  let panelGazeEnter = $state([0, 0, 0, 0, 0, 0, 0, 0]);
  let prevFrameTime = $state(0);

  // ── Stable gaze (updated every 1s) ──
  let stableGazeX = $state(0);
  let stableGazeY = $state(0);
  let stableGazeZone = $state("—");
  let lastGazeUpdate = $state(0);

  // EMA
  let smoothedFace: any[] | null = null;
  const SMOOTH_ALPHA = 0.35;

  const FACE_MODEL =
    "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/latest/face_landmarker.task";
  const WASM_CDN = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@latest/wasm";

  // Key landmarks
  const NOSE = 1;
  const NOSE_BRIDGE = 168;
  const LE_INNER = 33;   // left eye inner corner (near nose)
  const LE_OUTER = 133;  // left eye outer corner
  const RE_INNER = 362;  // right eye inner corner
  const RE_OUTER = 263;  // right eye outer corner
  const L_IRIS = 468;    // left iris center
  const R_IRIS = 473;    // right iris center
  const L_EAR = 234;     // left side of face (ear level)
  const R_EAR = 454;     // right side of face

  // Face contour for drawing
  const FACE_CONTOUR: number[][] = [
    [10, 338, 297, 332, 284, 251, 389, 356, 454, 323, 361, 288, 397, 365, 379, 378, 400, 377, 152, 148, 176, 149, 150, 136, 172, 58, 132, 93, 234, 127, 162, 21, 54, 103, 67, 109, 10],
    [46, 53, 52, 65, 55, 70, 63, 105, 66, 107],
    [276, 283, 282, 295, 285, 300, 293, 334, 296, 336],
  ];

  onMount(async () => {
    try {
      await initMediaPipe();
      await initCamera();
      status = "Looking for faces...";
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
      numFaces: 1,
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
    if (!canvas) return;
    canvas.width = video.videoWidth || 640;
    canvas.height = video.videoHeight || 480;
  }

  // ── Gaze computation ──

  function computeGaze(lm: any[], w: number, h: number) {
    const nose = lm[NOSE];
    const noseBridge = lm[NOSE_BRIDGE];
    const leInner = lm[LE_INNER], leOuter = lm[LE_OUTER];
    const reInner = lm[RE_INNER], reOuter = lm[RE_OUTER];
    const lIris = lm[L_IRIS], rIris = lm[R_IRIS];
    const lEar = lm[L_EAR], rEar = lm[R_EAR];

    if (!nose || !lIris || !rIris || !lEar || !rEar) return;

    // Face width in normalized coords
    const faceW = Math.abs(lEar.x - rEar.x);
    if (faceW < 0.01) return;

    // ── Head direction (yaw) ──
    // Nose deviation from face center
    const faceCenterX = (lEar.x + rEar.x) / 2;
    const rawYaw = (nose.x - faceCenterX) / (faceW / 2);
    // In mirrored coords (w - p.x*w): positive = looking right
    headYaw = Math.max(-1, Math.min(1, rawYaw));

    // ── Eye offset (horizontal) ──
    // Left eye: iris relative to eye center
    const lEyeCX = (leInner.x + leOuter.x) / 2;
    const lEyeW = Math.abs(leInner.x - leOuter.x);
    const lOffset = lEyeW > 0.005 ? (lIris.x - lEyeCX) / (lEyeW / 2) : 0;

    // Right eye
    const rEyeCX = (reInner.x + reOuter.x) / 2;
    const rEyeW = Math.abs(reInner.x - reOuter.x);
    const rOffset = rEyeW > 0.005 ? (rIris.x - rEyeCX) / (rEyeW / 2) : 0;

    // Combined eye offset (average)
    const rawEyeX = (lOffset + rOffset) / 2;
    eyeOffsetX = Math.max(-1, Math.min(1, rawEyeX));

    // ── Vertical gaze ──
    // Head pitch: nose relative to face vertical center
    const faceH = Math.abs(lEar.y - noseBridge.y) * 2;
    const headPitch = faceH > 0.01
      ? (nose.y - (lEar.y + noseBridge.y) / 2) / (faceH / 2)
      : 0;

    // Eye vertical offset
    const lEyeCY = (leInner.y + leOuter.y) / 2;
    const lEyeH = Math.abs(leInner.y - leOuter.y);
    const lOffsetY = lEyeH > 0.003 ? (lIris.y - lEyeCY) / (lEyeH / 2) : 0;
    const rEyeCY = (reInner.y + reOuter.y) / 2;
    const rEyeH = Math.abs(reInner.y - reOuter.y);
    const rOffsetY = rEyeH > 0.003 ? (rIris.y - rEyeCY) / (rEyeH / 2) : 0;
    const eyeOffsetY = (lOffsetY + rOffsetY) / 2;

    // ── Combined gaze ──
    // Weight: head 60%, eye 40%
    gazeX = Math.max(-1, Math.min(1, -(headYaw * 0.6 + eyeOffsetX * 0.4)));
    gazeY = Math.max(-1, Math.min(1, headPitch * 0.5 + eyeOffsetY * 0.5));

    // Gaze zone label — map to 8-panel grid
    const col = Math.min(GRID_COLS - 1, Math.max(0, Math.floor((gazeX + 1) / 2 * GRID_COLS)));
    const row = Math.min(GRID_ROWS - 1, Math.max(0, Math.floor((gazeY + 1) / 2 * GRID_ROWS)));
    // Reset this frame's gaze flags
    const newGazeNow = [false, false, false, false, false, false, false, false];
    const now = performance.now();

    activePanel = { row, col };
    const key = `${row}_${col}`;
    const pi = row * GRID_COLS + col;
    newGazeNow[pi] = true;
    if (panelKey !== key) {
      panelKey = key;
    }

    // Update per-panel gaze flags and last-gaze timestamps
    for (let i = 0; i < 8; i++) {
      const wasGazing = panelGazeNow[i];
      const isGazing = newGazeNow[i];
      panelGazeNow[i] = isGazing;
      if (isGazing && !wasGazing) {
        // Gaze just entered this panel
        panelGazeEnter[i] = now;
      }
      if (!isGazing && wasGazing) {
        // Gaze just left this panel
        panelLastGaze[i] = now;
      }
    }

    // ── Stable gaze: update every 1s ──
    if (now - lastGazeUpdate > 1000) {
      stableGazeX = gazeX;
      stableGazeY = gazeY;
      stableGazeZone = PANEL_NAMES[row * GRID_COLS + col];
      lastGazeUpdate = now;
    }

    faceDetected = true;
  }

  function startDetectionLoop() {
    function detect() {
      if (!running || !video) return;
      if (video.readyState >= 2) {
        const now = performance.now();
        const result = faceLandmarkerInstance
          ? faceLandmarkerInstance.detectForVideo(video, now)
          : null;

        const raw = result?.faceLandmarks?.[0] ?? null;

        // Smooth
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
        } else {
          smoothedFace = null;
          faceDetected = false;
          activePanel = null;
          panelKey = null;
          stableGazeZone = "—";
          const now2 = performance.now();
          for (let i = 0; i < 8; i++) {
            if (panelGazeNow[i]) {
              panelGazeNow[i] = false;
              panelLastGaze[i] = now2;
            }
          }
        }

        if (smoothedFace) computeGaze(smoothedFace, canvas.width, canvas.height);

        // ── Per-panel alpha transitions ──
        const dt = prevFrameTime > 0 ? Math.min((now - prevFrameTime) / 1000, 0.1) : 0.016;
        prevFrameTime = now;
        const newAlpha = [...panelAlpha];
        for (let i = 0; i < 8; i++) {
          const gazeOnPanel = panelGazeNow[i];
          const hoverDuration = gazeOnPanel ? (now - panelGazeEnter[i]) / 1000 : 0;
          const hovering = gazeOnPanel && hoverDuration >= 1;

          if (hovering) {
            // Gaze has been on this panel for 1s+: rise to 0.8 over ~1s
            const target = 0.8;
            if (panelAlpha[i] < target) {
              newAlpha[i] += (target - newAlpha[i]) * Math.min(1, dt);
            } else if (panelAlpha[i] > target) {
              newAlpha[i] -= (newAlpha[i] - target) * Math.min(1, dt);
            }
          } else {
            const gazeLeftAgo = (now - panelLastGaze[i]) / 1000;
            if (gazeLeftAgo > 3) {
              // Gaze left more than 3s ago: dim to 0 over ~5s
              if (panelAlpha[i] > 0.01) {
                newAlpha[i] -= newAlpha[i] * Math.min(1, dt / 5);
              } else {
                newAlpha[i] = 0;
              }
            }
            // else: within 3s of gaze leaving, hold current alpha
          }
        }
        panelAlpha = newAlpha;

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

  // ── Drawing ──

  function drawFrame() {
    if (!video) return;
    const ctx = canvas.getContext("2d")!;
    const w = canvas.width, h = canvas.height;

    // Mirrored webcam
    ctx.save();
    ctx.scale(-1, 1);
    ctx.drawImage(video, -w, 0, w, h);
    ctx.restore();

    // 8-panel grid overlay
    drawGrid(ctx, w, h);

    if (smoothedFace) {
      drawFaceMesh(ctx, w, h);
      drawEyes(ctx, w, h);
      drawGazeDot(ctx, w, h);
    }

    drawHUD(ctx, w, h);
  }

  function drawGrid(ctx: CanvasRenderingContext2D, w: number, h: number) {
    const cellW = w / GRID_COLS;
    const cellH = h / GRID_ROWS;

    for (let r = 0; r < GRID_ROWS; r++) {
      for (let c = 0; c < GRID_COLS; c++) {
        const i = r * GRID_COLS + c;
        const alpha = panelAlpha[i];
        if (alpha < 0.01) continue;

        const x = c * cellW, y = r * cellH;
        const fillA = Math.min(0.8, alpha);
        const fillHex = Math.round(fillA * 255).toString(16).padStart(2, "0");
        ctx.fillStyle = `#ffffff${fillHex}`;
        ctx.fillRect(x, y, cellW, cellH);

        const borderA = Math.min(0.5, alpha * 0.65);
        const borderHex = Math.round(borderA * 255).toString(16).padStart(2, "0");
        ctx.strokeStyle = `#ffffff${borderHex}`;
        ctx.lineWidth = 2;
        ctx.strokeRect(x, y, cellW, cellH);

        // Countdown arc for hold state (gaze left, within 3s dimming delay)
        if (!panelGazeNow[i] && panelLastGaze[i] > 0) {
          const gazeLeftMs = performance.now() - panelLastGaze[i];
          const holdMs = 3000;
          if (gazeLeftMs < holdMs) {
            const progress = gazeLeftMs / holdMs; // 0 → 1 during hold
            const cx = x + cellW / 2;
            const cy = y + cellH / 2;
            const radius = Math.min(cellW, cellH) * 0.35;
            // Arc depletes: full at start, empty at 3s
            ctx.beginPath();
            ctx.arc(cx, cy, radius, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * (1 - progress));
            ctx.strokeStyle = "rgba(255, 255, 255, 0.4)";
            ctx.lineWidth = 3;
            ctx.lineCap = "round";
            ctx.stroke();
          }
        }
      }
    }

    // Grid lines (subtle)
    ctx.strokeStyle = "rgba(255, 255, 255, 0.04)";
    ctx.lineWidth = 1;
    for (let i = 1; i < GRID_COLS; i++) {
      const x = i * cellW;
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, h);
      ctx.stroke();
    }
    for (let i = 1; i < GRID_ROWS; i++) {
      const y = i * cellH;
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(w, y);
      ctx.stroke();
    }
  }

  function drawFaceMesh(ctx: CanvasRenderingContext2D, w: number, h: number) {
    const lm = smoothedFace!;
    ctx.save();
    ctx.globalAlpha = 0.2;
    ctx.strokeStyle = "#a78bfa";
    ctx.lineWidth = 1;
    for (const contour of FACE_CONTOUR) {
      ctx.beginPath();
      for (let i = 0; i < contour.length; i++) {
        const p = lm[contour[i]];
        if (!p) continue;
        const x = w - p.x * w, y = p.y * h;
        if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      }
      ctx.stroke();
    }
    ctx.restore();
  }

  function drawEyes(ctx: CanvasRenderingContext2D, w: number, h: number) {
    const lm = smoothedFace!;
    const eyes = [
      { inner: lm[LE_INNER], outer: lm[LE_OUTER], iris: lm[L_IRIS] },
      { inner: lm[RE_INNER], outer: lm[RE_OUTER], iris: lm[R_IRIS] },
    ];

    for (const eye of eyes) {
      if (!eye.inner || !eye.outer || !eye.iris) continue;

      // Eye socket (subtle)
      const ex = w - eye.inner.x * w, ey = eye.inner.y * h;
      const eix = w - eye.outer.x * w, eiy = eye.outer.y * h;
      ctx.save();
      ctx.strokeStyle = "rgba(167, 139, 250, 0.3)";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.ellipse((ex + eix) / 2, (ey + eiy) / 2,
        Math.abs(ex - eix) / 2, Math.abs(ey - eiy) / 2, 0, 0, Math.PI * 2);
      ctx.stroke();

      // Iris dot
      const ix = w - eye.iris.x * w, iy = eye.iris.y * h;
      ctx.shadowColor = "rgba(167, 139, 250, 0.4)";
      ctx.shadowBlur = 12;
      ctx.fillStyle = "#a78bfa";
      ctx.beginPath();
      ctx.arc(ix, iy, 4, 0, Math.PI * 2);
      ctx.fill();

      // Pupil (inner dot)
      ctx.shadowBlur = 0;
      ctx.fillStyle = "#ffffff";
      ctx.beginPath();
      ctx.arc(ix, iy, 1.5, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }
  }

  function drawGazeDot(ctx: CanvasRenderingContext2D, w: number, h: number) {
    if (!faceDetected) return;

    // Map gaze (-1..1) to canvas position (with margin)
    const margin = 40;
    const gx = margin + (stableGazeX + 1) / 2 * (w - margin * 2);
    const gy = margin + (stableGazeY + 1) / 2 * (h - margin * 2);

    // Outer glow
    ctx.save();
    const glowR = 40 + 15 * Math.sin(performance.now() / 500);
    const grad = ctx.createRadialGradient(gx, gy, 0, gx, gy, glowR);
    grad.addColorStop(0, "rgba(167, 139, 250, 0.25)");
    grad.addColorStop(1, "rgba(167, 139, 250, 0)");
    ctx.beginPath();
    ctx.arc(gx, gy, glowR, 0, Math.PI * 2);
    ctx.fillStyle = grad;
    ctx.fill();

    // Crosshair
    ctx.strokeStyle = "rgba(167, 139, 250, 0.5)";
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(gx, gy, 12, 0, Math.PI * 2);
    ctx.stroke();

    ctx.beginPath();
    ctx.moveTo(gx - 6, gy);
    ctx.lineTo(gx + 6, gy);
    ctx.moveTo(gx, gy - 6);
    ctx.lineTo(gx, gy + 6);
    ctx.stroke();

    // Center dot
    ctx.fillStyle = "#a78bfa";
    ctx.beginPath();
    ctx.arc(gx, gy, 3, 0, Math.PI * 2);
    ctx.fill();
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

    // Gaze indicator card (top-right)
    const cardX = w - 180, cardY = 12, cardW = 164, cardH = 80;
    ctx.save();
    ctx.shadowColor = "rgba(0,0,0,0.5)";
    ctx.shadowBlur = 16;
    ctx.fillStyle = "rgba(0, 0, 0, 0.6)";
    ctx.beginPath();
    ctx.roundRect(cardX, cardY, cardW, cardH, 10);
    ctx.fill();
    ctx.shadowBlur = 0;

    // Zone label
    ctx.fillStyle = faceDetected ? "#a78bfa" : "rgba(255,255,255,0.15)";
    ctx.font = "bold 18px system-ui, sans-serif";
    ctx.textAlign = "left";
    ctx.textBaseline = "top";
    ctx.fillText(stableGazeZone, cardX + 12, cardY + 8);

    // Raw values
    ctx.fillStyle = "rgba(255,255,255,0.2)";
    ctx.font = "9px monospace";
    ctx.fillText(`head ${headYaw.toFixed(2)}`, cardX + 12, cardY + 34);
    ctx.fillText(`eye  ${eyeOffsetX.toFixed(2)}`, cardX + 12, cardY + 48);
    ctx.fillText(`gaze ${stableGazeX.toFixed(2)}, ${stableGazeY.toFixed(2)}`, cardX + 12, cardY + 62);
    ctx.restore();

    // Direction bars at bottom
    const barY = h - 42;
    const barH_s = 8;
    const barW_s = Math.min(w * 0.5, 300);
    const bx = (w - barW_s) / 2;

    ctx.save();
    ctx.fillStyle = "rgba(0, 0, 0, 0.4)";
    ctx.beginPath();
    ctx.roundRect(bx - 4, barY - 4, barW_s + 8, barH_s + 8, 6);
    ctx.fill();

    // Background track
    ctx.fillStyle = "rgba(255,255,255,0.04)";
    ctx.beginPath();
    ctx.roundRect(bx, barY, barW_s, barH_s, 4);
    ctx.fill();

    // Gaze indicator
    if (faceDetected) {
      const fillX = bx + (stableGazeX + 1) / 2 * barW_s;
      const fillW = Math.max(4, Math.min(barW_s, 4 + Math.abs(stableGazeX) * 20));
      ctx.fillStyle = "#a78bfa";
      ctx.beginPath();
      ctx.roundRect(fillX - fillW / 2, barY, fillW, barH_s, 4);
      ctx.fill();

      // Center mark
      ctx.strokeStyle = "rgba(255,255,255,0.08)";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(bx + barW_s / 2, barY);
      ctx.lineTo(bx + barW_s / 2, barY + barH_s);
      ctx.stroke();

      // Labels
      ctx.fillStyle = "rgba(255,255,255,0.1)";
      ctx.font = "8px monospace";
      ctx.textBaseline = "top";
      ctx.textAlign = "left";
      ctx.fillText("L", bx, barY + barH_s + 4);
      ctx.textAlign = "center";
      ctx.fillText("head + eye gaze", bx + barW_s / 2, barY + barH_s + 4);
      ctx.textAlign = "right";
      ctx.fillText("R", bx + barW_s, barY + barH_s + 4);
    }
    ctx.restore();

    // Status bar
    const barY2 = h - 68;
    const statusText = faceDetected ? "●  gaze tracking" : "○  no face";
    ctx.font = "12px monospace";
    const sw = ctx.measureText(statusText).width;
    const sbw = sw + 24;
    const sbx = (w - sbw) / 2;

    ctx.save();
    ctx.shadowColor = "rgba(0,0,0,0.5)";
    ctx.shadowBlur = 12;
    ctx.fillStyle = faceDetected ? "rgba(0, 20, 40, 0.7)" : "rgba(0, 0, 0, 0.5)";
    ctx.beginPath();
    ctx.roundRect(sbx, barY2, sbw, 22, 11);
    ctx.fill();
    ctx.shadowBlur = 0;
    ctx.fillStyle = faceDetected ? "#a78bfa" : "#555";
    ctx.textBaseline = "middle";
    ctx.textAlign = "center";
    ctx.fillText(statusText, sbx + sbw / 2, barY2 + 11);
    ctx.restore();
  }
</script>

<div class="gaze-detect-page">
  <div class="gaze-detect-container">
    <canvas bind:this={canvas} class="gaze-detect-canvas"></canvas>
    {#if error}
      <div class="overlay error">
        <div class="overlay-icon">⚠️</div>
        <div class="overlay-text">{error}</div>
      </div>
    {/if}
  </div>
  <div class="gaze-detect-footer">
    <span class="footer-label">Gaze Detect — head direction + iris offset gaze tracking</span>
  </div>
</div>

<style>
  .gaze-detect-page {
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

  .gaze-detect-container {
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

  .gaze-detect-canvas {
    display: block;
    max-width: 100%;
    max-height: calc(100vh - 100px);
    object-fit: contain;
    border-radius: 16px;
  }

  .gaze-detect-footer {
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
