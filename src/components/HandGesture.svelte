<script lang="ts">
  import { onMount, onDestroy } from "svelte";

  let canvas: HTMLCanvasElement;
  let status = $state("Initializing...");
  let handCount = $state(0);
  let handedness = $state<string[]>([]);
  let gestures = $state<string[]>([]);
  let fps = $state(0);
  let error = $state<string | null>(null);

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
      status = "Ready — show your hand";
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

    // 2. Hand skeleton (mirrored coords to match)
    if (result.landmarks) {
      const CONNECTIONS = [
        [0, 1],[1, 2],[2, 3],[3, 4],
        [0, 5],[5, 6],[6, 7],[7, 8],
        [0, 9],[9,10],[10,11],[11,12],
        [0,13],[13,14],[14,15],[15,16],
        [0,17],[17,18],[18,19],[19,20],
        [5, 9],[9,13],[13,17],
      ];

      for (const landmarks of result.landmarks) {
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
    ctx.fillText("v0.2.0", 12 + 28, 12 + 12);
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

<div class="gesture-container">
  <!-- Only the canvas renders — video lives in JS memory, never in the DOM -->
  <canvas bind:this={canvas} class="gesture-canvas"></canvas>

  {#if error}
    <div class="overlay error">
      <div class="overlay-icon">⚠️</div>
      <div class="overlay-text">{error}</div>
    </div>
  {/if}
</div>

<style>
  .gesture-container {
    position: fixed;
    inset: 0;
    background: #000;
    overflow: hidden;
  }

  .gesture-canvas {
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
