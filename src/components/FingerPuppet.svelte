<script lang="ts">
  import { onMount, onDestroy } from "svelte";

  let canvas: HTMLCanvasElement;
  let status = $state("Initializing...");
  let handCount = $state(0);
  let handedness = $state<string[]>([]);
  let gestures = $state<string[]>([]);
  let fps = $state(0);
  let error = $state<string | null>(null);

  // Smoothed hand landmarks (EMA filter)
  let smoothedLandmarks: any[] | null = null;
  const SMOOTH_ALPHA = 0.35;

  // Hidden video element — created in JS, never appended to DOM
  let video: HTMLVideoElement | null = null;
  let stream: MediaStream | null = null;

  let handLandmarkerInstance: any;
  let running = true;
  let frameCount = 0;
  let lastFpsUpdate = 0;

  const MODEL_URL =
    "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/latest/hand_landmarker.task";
  const WASM_CDN = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@latest/wasm";

  onMount(async () => {
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

  onDestroy(() => {
    running = false;
    if (stream) stream.getTracks().forEach((t) => t.stop());
    if (video) {
      video.pause();
      video.srcObject = null;
    }
    if (handLandmarkerInstance) handLandmarkerInstance.close();
  });

  async function initMediaPipe() {
    const { FilesetResolver, HandLandmarker } = await import("@mediapipe/tasks-vision");
    status = "Loading hand model...";
    const vision = await FilesetResolver.forVisionTasks(WASM_CDN);
    handLandmarkerInstance = await HandLandmarker.createFromOptions(vision, {
      baseOptions: { modelAssetPath: MODEL_URL, delegate: "GPU" },
      runningMode: "VIDEO",
      numHands: 2,
    });
  }

  async function initCamera() {
    status = "Opening camera...";
    stream = await navigator.mediaDevices.getUserMedia({
      video: { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: "user" },
      audio: false,
    });

    // Hidden video — never appended to DOM
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
  }

  function startDetectionLoop() {
    function detect() {
      if (!running || !video) return;
      if (handLandmarkerInstance && video.readyState >= 2) {
        const now = performance.now();
        const result = handLandmarkerInstance.detectForVideo(video, now);
        handCount = result.landmarks?.length ?? 0;
        handedness = (result.handedness ?? []).map((h: any) => h[0]?.categoryName ?? "?");
        gestures = classifyGestures(result.landmarks);
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
    return hands.map((landmarks) => {
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

  function drawSmileyFace(ctx: CanvasRenderingContext2D, w: number, h: number, tip: any, base: any) {
    const bx = w - tip.x * w;
    const by = tip.y * h;
    const dx = bx - (w - base.x * w);
    const dy = by - base.y * h;
    const angle = Math.atan2(dy, dx);
    // Zoom: z < 0 = closer (MediaPipe z is negative towards viewer), z > 0 = farther
    const scale = Math.min(2, Math.max(0.2, 1 - (tip.z ?? 0) * 3));
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

    // 1. Mirrored camera feed
    ctx.save();
    ctx.scale(-1, 1);
    ctx.drawImage(video, -w, 0, w, h);
    ctx.restore();

    // 2. Apply EMA smoothing to raw landmarks
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

      // Finger puppet faces on extended fingertips (properly scoped — one pass over all hands)
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
          drawSmileyFace(ctx, w, h, tip, base);
        }
      }
    }

    // 3. HUD overlays
    drawVersionBadge(ctx, w, h);
    drawIndicators(ctx, w, h);
    drawStatusBar(ctx, w, h);
  }

  function drawIndicators(ctx: CanvasRenderingContext2D, w: number, h: number) {
    const padding = 16;
    const cardW = 180;
    const cardH = 44;
    const gap = 8;
    const x = w - padding - cardW;
    let y = padding;

    if (handCount === 0) {
      drawCard(ctx, x, y, cardW, cardH, "🖐️  Show your hand", "#555");
    } else {
      for (let i = 0; i < handCount; i++) {
        const icon = handedness[i] === "Right" ? "👉" : "👈";
        const label = `${handedness[i] ?? "?"} hand`;
        const gesture = gestures[i] ?? "...";
        drawCard(ctx, x, y, cardW, cardH, `${icon}  ${label}`, "#8b8fa3");
        drawGestureBadge(ctx, x + cardW + 6, y, cardH, gesture);
        y += cardH + gap;
      }
    }
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
    ctx.fillText("v0.1.0", 12 + 28, 12 + 12);
    ctx.restore();
  }

  function drawCard(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, text: string, color: string) {
    ctx.save();
    ctx.shadowColor = "rgba(0,0,0,0.4)";
    ctx.shadowBlur = 12;
    ctx.fillStyle = "rgba(0, 0, 0, 0.55)";
    ctx.beginPath();
    ctx.roundRect(x, y, w, h, 10);
    ctx.fill();
    ctx.shadowBlur = 0;
    ctx.fillStyle = color;
    ctx.font = "14px system-ui, -apple-system, sans-serif";
    ctx.textBaseline = "middle";
    ctx.fillText(text, x + 12, y + h / 2);
    ctx.restore();
  }

  function drawGestureBadge(ctx: CanvasRenderingContext2D, x: number, y: number, h: number, gesture: string) {
    ctx.save();
    ctx.shadowColor = "rgba(0,0,0,0.4)";
    ctx.shadowBlur = 12;
    ctx.fillStyle = "rgba(0, 200, 255, 0.15)";
    ctx.beginPath();
    ctx.roundRect(x, y, 120, h, 10);
    ctx.fill();
    ctx.shadowBlur = 0;
    ctx.fillStyle = "#00ccff";
    ctx.font = "bold 14px system-ui, -apple-system, sans-serif";
    ctx.textBaseline = "middle";
    ctx.fillText(gesture, x + 12, y + h / 2);
    ctx.restore();
  }

  function drawStatusBar(ctx: CanvasRenderingContext2D, w: number, h: number) {
    const barH = 32;
    const pad = 12;
    const fpsText = `${fps} fps`;
    const dotText = handCount > 0 ? "●" : "○";
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

    ctx.fillStyle = handCount > 0 ? "#00ccff" : "#555";
    ctx.textBaseline = "middle";
    ctx.fillText(dotText, bx + pad, by + barH / 2);

    ctx.fillStyle = "#ccc";
    ctx.fillText(status, bx + pad + 16, by + barH / 2);

    ctx.fillStyle = "#666";
    ctx.fillText(fpsText, bx + barW - pad - fpsW, by + barH / 2);
    ctx.restore();
  }
</script>

<div class="finger-puppet-container">
  <canvas bind:this={canvas} class="finger-puppet-canvas"></canvas>

  {#if error}
    <div class="overlay error">
      <div class="overlay-icon">⚠️</div>
      <div class="overlay-text">{error}</div>
    </div>
  {/if}
</div>

<style>
  .finger-puppet-container {
    position: fixed;
    inset: 0;
    background: #000;
    overflow: hidden;
  }

  .finger-puppet-canvas {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    object-fit: cover;
  }

  .overlay {
    position: absolute;
    inset: 0;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    background: rgba(0, 0, 0, 0.8);
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
