<script lang="ts">
  import { onMount, onDestroy } from "svelte";

  let canvas: HTMLCanvasElement;
  let status = $state("Initializing...");
  let fps = $state(0);
  let error = $state<string | null>(null);
  let handsDetected = $state(0);

  let video: HTMLVideoElement | null = null;
  let stream: MediaStream | null = null;
  let handLandmarkerInstance: any;
  let running = true;
  let frameCount = 0;
  let lastFpsUpdate = 0;

  // ── State ──
  let smoothedLm: { x: number; y: number }[] | null = null;
  let capturedPixels: { dx: number; dy: number; r: number; g: number; b: number }[] = [];
  let origAngle = $state(0);
  let origLength = $state(1);
  let hasCapture = $state(false);
  let countdownActive = $state(false);
  let countdownProgress = $state(0);
  let handCX = 0, handCY = 0;
  let lastHandCX = 0, lastHandCY = 0;
  let stillTimer = 0;
  let lastPaintX = 0, lastPaintY = 0;
  let painting = $state(false);

  const STILL_THRESHOLD = 15;
  const COUNTDOWN_MS = 3000;
  const SMOOTH_ALPHA = 0.25;
  const SAMPLE_STEP = 5;
  let paintedPixels: { x: number; y: number; r: number; g: number; b: number }[] = [];

  const HAND_CONNECTIONS: [number, number][] = [
    [0,1],[1,2],[2,3],[3,4],
    [0,5],[5,6],[6,7],[7,8],
    [0,9],[9,10],[10,11],[11,12],
    [0,13],[13,14],[14,15],[15,16],
    [0,17],[17,18],[18,19],[19,20],
    [5,9],[9,13],[13,17],
  ];

  const MODEL =
    "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/latest/hand_landmarker.task";
  const WASM_CDN = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@latest/wasm";

  const WRIST = 0;
  const MIDDLE_TIP = 12;

  function palmCenter(lm: { x: number; y: number }[], w: number, h: number): { x: number; y: number } {
    return { x: w - ((lm[0].x + lm[9].x) / 2) * w, y: ((lm[0].y + lm[9].y) / 2) * h };
  }

  onMount(async () => {
    try {
      await initMediaPipe();
      await initCamera();
      status = "Hold hand still to capture";
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
    if (handLandmarkerInstance) handLandmarkerInstance.close();
  });

  async function initMediaPipe() {
    const { FilesetResolver, HandLandmarker } = await import("@mediapipe/tasks-vision");
    const vision = await FilesetResolver.forVisionTasks(WASM_CDN);
    status = "Loading hand model...";
    handLandmarkerInstance = await HandLandmarker.createFromOptions(vision, {
      baseOptions: { modelAssetPath: MODEL, delegate: "GPU" },
      runningMode: "VIDEO",
      numHands: 1,
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
        const result = handLandmarkerInstance
          ? handLandmarkerInstance.detectForVideo(video, now)
          : null;
        handsDetected = result?.landmarks?.length ?? 0;
        drawFrame(result, now);
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

  function drawFrame(result: any, now: number) {
    if (!video) return;
    const ctx = canvas.getContext("2d")!;
    const w = canvas.width, h = canvas.height;

    const offscreen = new OffscreenCanvas(w, h);
    const offCtx = offscreen.getContext("2d")!;
    offCtx.save(); offCtx.scale(-1, 1); offCtx.drawImage(video, -w, 0, w, h); offCtx.restore();
    const pixels = offCtx.getImageData(0, 0, w, h);

    ctx.save(); ctx.scale(-1, 1); ctx.drawImage(video, -w, 0, w, h); ctx.restore();

    for (const p of paintedPixels) {
      ctx.fillStyle = `rgb(${p.r},${p.g},${p.b})`;
      ctx.fillRect(p.x - 2, p.y - 2, 4, 4);
    }

    const handPresent = result?.landmarks?.[0] != null;

    if (handPresent) {
      const rawLm = result.landmarks[0];
      if (!smoothedLm || smoothedLm.length !== rawLm.length) {
        smoothedLm = rawLm.map((p: any) => ({ x: p.x, y: p.y }));
      } else {
        for (let i = 0; i < rawLm.length; i++) {
          smoothedLm[i].x += (rawLm[i].x - smoothedLm[i].x) * SMOOTH_ALPHA;
          smoothedLm[i].y += (rawLm[i].y - smoothedLm[i].y) * SMOOTH_ALPHA;
        }
      }
      const lm = smoothedLm;
      const pc = palmCenter(lm, w, h);
      handCX = pc.x; handCY = pc.y;

      if (hasCapture) {
        painting = true;
        const steps = Math.max(1, Math.round(Math.hypot(handCX - lastPaintX, handCY - lastPaintY) / 3));
        for (let s = 0; s <= steps; s++) {
          const t = steps > 0 ? s / steps : 1;
          paintCaptured(lastPaintX + (handCX - lastPaintX) * t, lastPaintY + (handCY - lastPaintY) * t, lm, w, h);
        }
        lastPaintX = handCX; lastPaintY = handCY;
      } else {
        const moved = Math.hypot(handCX - lastHandCX, handCY - lastHandCY);
        if (moved < STILL_THRESHOLD) {
          if (stillTimer === 0) stillTimer = now;
          const elapsed = now - stillTimer;
          countdownActive = true;
          countdownProgress = Math.min(1, elapsed / COUNTDOWN_MS);
          if (elapsed >= COUNTDOWN_MS) {
            capturePixels(lm, pixels, w, h);
            countdownActive = false; countdownProgress = 0; stillTimer = 0;
            hasCapture = true;
            lastPaintX = handCX; lastPaintY = handCY;
          }
        } else {
          countdownActive = false; countdownProgress = 0; stillTimer = 0;
        }
        lastHandCX = handCX; lastHandCY = handCY;
      }

      // Draw thumb-index line
      const thumb = lm[4], index = lm[8];
      if (thumb && index) {
        const tx = w - thumb.x * w, ty = thumb.y * h;
        const ix = w - index.x * w, iy = index.y * h;
        ctx.save();
        ctx.shadowColor = "rgba(0, 220, 255, 0.4)"; ctx.shadowBlur = 20;
        ctx.strokeStyle = "#00dcff"; ctx.lineWidth = 4; ctx.lineCap = "round";
        ctx.beginPath(); ctx.moveTo(tx, ty); ctx.lineTo(ix, iy); ctx.stroke();
        ctx.shadowBlur = 8; ctx.strokeStyle = "#ffffff"; ctx.lineWidth = 1.5;
        ctx.beginPath(); ctx.moveTo(tx, ty); ctx.lineTo(ix, iy); ctx.stroke();
        ctx.restore();
        ctx.save();
        ctx.shadowColor = "rgba(0, 220, 255, 0.3)"; ctx.shadowBlur = 12;
        ctx.fillStyle = "#00dcff";
        ctx.beginPath(); ctx.arc(tx, ty, 5, 0, Math.PI * 2); ctx.fill();
        ctx.beginPath(); ctx.arc(ix, iy, 5, 0, Math.PI * 2); ctx.fill();
        ctx.shadowBlur = 0; ctx.fillStyle = "#ffffff";
        ctx.beginPath(); ctx.arc(tx, ty, 2, 0, Math.PI * 2); ctx.fill();
        ctx.beginPath(); ctx.arc(ix, iy, 2, 0, Math.PI * 2); ctx.fill();
        ctx.restore();

        const dist = Math.hypot(ix - tx, iy - ty);
        ctx.fillStyle = "rgba(0, 220, 255, 0.3)";
        ctx.font = "10px monospace"; ctx.textAlign = "center"; ctx.textBaseline = "bottom";
        ctx.fillText(`${Math.round(dist)}px`, (tx + ix) / 2, Math.min(ty, iy) - 8);
      }

      // Countdown arc at palm center
      if (countdownActive) {
        const cx = handCX, cy = handCY;
        ctx.save();
        ctx.strokeStyle = "rgba(255, 255, 255, 0.6)"; ctx.lineWidth = 3; ctx.lineCap = "round";
        ctx.shadowColor = "rgba(0, 220, 255, 0.3)"; ctx.shadowBlur = 10;
        ctx.beginPath();
        ctx.arc(cx, cy, 35, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * countdownProgress);
        ctx.stroke(); ctx.restore();
        ctx.fillStyle = "rgba(255,255,255,0.5)";
        ctx.font = "10px monospace"; ctx.textAlign = "center"; ctx.textBaseline = "middle";
        ctx.fillText("capturing", cx, cy);
      }
    } else {
      painting = false;
    }

    drawHUD(ctx, w, h);
  }

  function capturePixels(lm: { x: number; y: number }[], imageData: ImageData, w: number, h: number) {
    const data = imageData.data;
    capturedPixels = [];
    const thumb = lm[4], index = lm[8];
    if (thumb && index) {
      const ax = w - thumb.x * w, ay = thumb.y * h;
      const bx = w - index.x * w, by = index.y * h;
      const dx = bx - ax, dy = by - ay;
      const len = Math.hypot(dx, dy);
      const steps = Math.max(1, Math.floor(len / SAMPLE_STEP));
      for (let i = 0; i <= steps; i++) {
        const t = steps > 0 ? i / steps : 0.5;
        const sx = Math.round(ax + dx * t), sy = Math.round(ay + dy * t);
        if (sx < 0 || sx >= w || sy < 0 || sy >= h) continue;
        const pi = (sy * w + sx) * 4;
        capturedPixels.push({ dx: sx - handCX, dy: sy - handCY, r: data[pi], g: data[pi + 1], b: data[pi + 2] });
      }
    }

    const wrist = lm[WRIST], midTip = lm[MIDDLE_TIP];
    if (wrist && midTip) {
      const wx = w - wrist.x * w, wy = wrist.y * h;
      const mx = w - midTip.x * w, my = midTip.y * h;
      origAngle = Math.atan2(my - wy, mx - wx);
      origLength = Math.hypot(mx - wx, my - wy) || 1;
    }
    paintedPixels = [];
    paintCaptured(handCX, handCY, lm, w, h);
  }

  function paintCaptured(mx: number, my: number, lm: { x: number; y: number }[], w: number, h: number) {
    const wrist = lm[WRIST], midTip = lm[MIDDLE_TIP];
    if (!wrist || !midTip) {
      for (const p of capturedPixels) {
        paintedPixels.push({ x: Math.round(mx + p.dx), y: Math.round(my + p.dy), r: p.r, g: p.g, b: p.b });
      }
      return;
    }
    const wx = w - wrist.x * w, wy = wrist.y * h;
    const mxx = w - midTip.x * w, myy = midTip.y * h;
    const curAngle = Math.atan2(myy - wy, mxx - wx);
    const curLength = Math.hypot(mxx - wx, myy - wy) || 1;
    const angleDiff = curAngle - origAngle;
    const scale = curLength / origLength;
    const ca = Math.cos(angleDiff), sa = Math.sin(angleDiff);

    for (const p of capturedPixels) {
      const rx = (p.dx * ca - p.dy * sa) * scale;
      const ry = (p.dx * sa + p.dy * ca) * scale;
      paintedPixels.push({ x: Math.round(mx + rx), y: Math.round(my + ry), r: p.r, g: p.g, b: p.b });
    }
  }

  function resetAll() {
    capturedPixels = []; paintedPixels = [];
    hasCapture = false; painting = false;
    countdownActive = false; countdownProgress = 0; stillTimer = 0;
    origAngle = 0; origLength = 1;
  }

  function drawHUD(ctx: CanvasRenderingContext2D, w: number, h: number) {
    ctx.save();
    ctx.fillStyle = "rgba(0, 0, 0, 0.45)";
    ctx.beginPath(); ctx.roundRect(12, 12, 70, 22, 6); ctx.fill();
    ctx.fillStyle = "#00dcff"; ctx.font = "11px monospace"; ctx.textBaseline = "middle"; ctx.textAlign = "left";
    ctx.fillText(`${fps} fps`, 18, 23);
    if (hasCapture) {
      ctx.fillStyle = "rgba(0, 0, 0, 0.45)";
      ctx.beginPath(); ctx.roundRect(12, 40, 120, 22, 6); ctx.fill();
      ctx.fillStyle = "#34d399"; ctx.font = "10px monospace";
      ctx.fillText(`● ${capturedPixels.length}px captured`, 18, 51);
    }
    ctx.restore();
    const barH = 28;
    let statusText = "○  no hands";
    if (painting) statusText = "●  painting...";
    else if (countdownActive) statusText = "◉  hold still...";
    else if (handsDetected > 0 && !hasCapture) statusText = "●  hold whole hand still";
    else if (handsDetected > 0) statusText = `●  ${handsDetected} hand(s)`;
    ctx.font = "12px monospace";
    const sw = ctx.measureText(statusText).width;
    const barW = sw + 24;
    const bx = (w - barW) / 2, by = h - 44;
    ctx.save();
    ctx.shadowColor = "rgba(0,0,0,0.5)"; ctx.shadowBlur = 12;
    ctx.fillStyle = painting ? "rgba(0, 40, 20, 0.7)" : "rgba(0, 0, 0, 0.5)";
    ctx.beginPath(); ctx.roundRect(bx, by, barW, barH, 14); ctx.fill();
    ctx.shadowBlur = 0;
    ctx.fillStyle = painting ? "#34d399" : "#888";
    ctx.textBaseline = "middle"; ctx.textAlign = "center";
    ctx.fillText(statusText, bx + barW / 2, by + barH / 2);
    ctx.restore();
  }
</script>

<div class="dragpaint-page">
  <div class="dragpaint-container">
    <canvas bind:this={canvas} class="dragpaint-canvas"></canvas>
    {#if error}
      <div class="overlay error"><div class="overlay-icon">⚠️</div><div class="overlay-text">{error}</div></div>
    {/if}
  </div>
  <div class="dragpaint-footer">
    <span class="footer-label">Drag Paint — hold whole hand 3s to capture, move to paint</span>
    {#if hasCapture}
      <button class="reset-btn" onclick={resetAll}>Reset</button>
    {/if}
  </div>
</div>

<style>
  .dragpaint-page { position: fixed; inset: 0; background: #0a0a0f; display: flex; flex-direction: column; align-items: center; justify-content: center; padding: 32px; gap: 16px; }
  .dragpaint-container { position: relative; background: #000; border-radius: 16px; overflow: hidden; box-shadow: 0 0 60px rgba(0,0,0,0.8), 0 0 120px rgba(100,100,200,0.06); flex-shrink: 0; max-width: 100%; max-height: calc(100vh - 100px); display: flex; align-items: center; justify-content: center; }
  .dragpaint-canvas { display: block; max-width: 100%; max-height: calc(100vh - 100px); object-fit: contain; border-radius: 16px; }
  .dragpaint-footer { text-align: center; opacity: 0.4; display: flex; align-items: center; justify-content: center; gap: 12px; }
  .footer-label { color: #666; font-size: 0.75rem; font-family: monospace; letter-spacing: 0.05em; }
  .reset-btn { padding: 4px 14px; border-radius: 6px; border: 1px solid rgba(255,100,100,0.2); background: rgba(255,100,100,0.06); color: #ff6b6b; font-family: monospace; font-size: 0.65rem; cursor: pointer; transition: background 0.15s, color 0.15s; flex-shrink: 0; }
  .reset-btn:hover { background: rgba(255,100,100,0.12); color: #ff8a8a; }
  .overlay { position: absolute; inset: 0; display: flex; flex-direction: column; align-items: center; justify-content: center; background: rgba(0,0,0,0.85); border-radius: 16px; }
  .overlay.error .overlay-icon { font-size: 3rem; margin-bottom: 1rem; }
  .overlay-text { color: #f87171; font-size: 1.2rem; }
</style>
