<script lang="ts">
  import { onMount, onDestroy } from "svelte";

  let {
    onPalmCount,
    onPalmPosition,
    onPalmBoxes,
    onReady,
  }: {
    onPalmCount?: (count: number) => void;
    onPalmPosition?: (normalizedX: number) => void;
    onPalmBoxes?: (
      boxes: Array<{ x: number; y: number; width: number; height: number; hand?: "Left" | "Right" }>
    ) => void;
    onReady?: (canvas: HTMLCanvasElement) => void;
  } = $props();

  let canvas: HTMLCanvasElement;
  let status = $state("Initializing camera...");
  let palmCount = $state(0);
  let fps = $state(0);
  let error = $state<string | null>(null);

  // Hidden video element — created in JS, never appended to DOM
  let video: HTMLVideoElement | null = null;
  let stream: MediaStream | null = null;

  // Detection state
  let frameCount = 0;
  let lastFpsUpdate = 0;

  // MediaPipe
  let handLandmarkerInstance: any;
  let running = true;

  // Only the palm base, not the fingers — wrist + the 5 MCP knuckles
  const PALM_LANDMARKS = [0, 1, 5, 9, 13, 17];

  const MODEL_URL =
    "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/latest/hand_landmarker.task";
  const WASM_CDN = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@latest/wasm";

  onMount(async () => {
    onReady?.(canvas);
    try {
      await initMediaPipe();
      await initCamera();
      status = "Ready — looking for palms";
      startDetectionLoop();
    } catch (e) {
      error = e instanceof Error ? e.message : "Unknown error";
      status = "Failed to start";
    }
  });

  onDestroy(() => {
    running = false;
    if (stream) {
      stream.getTracks().forEach((t) => t.stop());
    }
    if (video) {
      video.pause();
      video.srcObject = null;
    }
    if (handLandmarkerInstance) handLandmarkerInstance.close();
  });

  async function initMediaPipe() {
    const { FilesetResolver, HandLandmarker } = await import(
      "@mediapipe/tasks-vision"
    );
    status = "Loading palm model...";
    const vision = await FilesetResolver.forVisionTasks(WASM_CDN);

    handLandmarkerInstance = await HandLandmarker.createFromOptions(vision, {
      baseOptions: {
        modelAssetPath: MODEL_URL,
        delegate: "GPU",
      },
      runningMode: "VIDEO",
      numHands: 2,
    });
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

    // Create hidden video element in JS only — never added to DOM
    video = document.createElement("video");
    video.srcObject = stream;
    video.playsInline = true;
    video.muted = true;
    video.autoplay = true;
    await video.play();

    // Sync canvas dimensions
    setCanvasSize();
  }

  function setCanvasSize() {
    if (!video || !canvas) return;
    canvas.width = video.videoWidth || 640;
    canvas.height = video.videoHeight || 480;
  }

  function startDetectionLoop() {
    let animId: number;

    function detect() {
      if (!running || !video) return;

      if (handLandmarkerInstance && video.readyState >= 2) {
        const now = performance.now();
        const result = handLandmarkerInstance.detectForVideo(video, now);

        palmCount = result.landmarks?.length ?? 0;
        onPalmCount?.(palmCount);

        const hands = result.landmarks ?? [];
        const boxes = hands.map((palm: any[], i: number) => {
          const xs = PALM_LANDMARKS.map((idx) => palm[idx].x);
          const ys = PALM_LANDMARKS.map((idx) => palm[idx].y);
          const minX = Math.min(...xs);
          const maxX = Math.max(...xs);
          const minY = Math.min(...ys);
          const maxY = Math.max(...ys);
          // MediaPipe reports handedness for the unmirrored feed — flip it to
          // match what the user sees as their left/right hand on the mirrored canvas
          const raw = result.handedness?.[i]?.[0]?.categoryName;
          const hand = raw === "Left" ? "Right" : raw === "Right" ? "Left" : undefined;
          // mirrored on screen, so flip x before normalizing
          return { x: 1 - maxX, y: minY, width: maxX - minX, height: maxY - minY, hand };
        });
        onPalmBoxes?.(boxes);
        if (boxes[0]) {
          onPalmPosition?.(boxes[0].x + boxes[0].width / 2);
        }

        // Single canvas: mirrored video + palm box/keypoints + HUD
        drawFrame(result);

        frameCount++;
        if (now - lastFpsUpdate > 1000) {
          fps = Math.round((frameCount * 1000) / (now - lastFpsUpdate));
          frameCount = 0;
          lastFpsUpdate = now;
        }
      }

      animId = requestAnimationFrame(detect);
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
    ctx.drawImage(video, -w, 0, w, h);
    ctx.restore();

    // 2. Palm boxes + keypoints (mirrored coords to match)
    const allLandmarks = result.landmarks ?? [];
    for (let i = 0; i < allLandmarks.length; i++) {
      drawPalmBox(ctx, allLandmarks[i], result.handedness?.[i]?.[0]?.categoryName, w, h);
    }

    // 3. HUD overlays
    drawVersionBadge(ctx, w, h);
    drawPalmIndicator(ctx, w, h, result.landmarks?.length ?? 0);
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

  function drawPalmIndicator(ctx: CanvasRenderingContext2D, w: number, h: number, count: number) {
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
      ctx.fillText("🖐️  No palm detected", x + 12, y + cardH / 2);
    } else {
      ctx.fillStyle = "#8b8fa3";
      ctx.font = "14px system-ui, -apple-system, sans-serif";
      ctx.textBaseline = "middle";
      ctx.fillText(`🖐️  ${count} palm${count > 1 ? "s" : ""}`, x + 12, y + cardH / 2);
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
    const dotText = palmCount > 0 ? "●" : "○";
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
    ctx.fillStyle = palmCount > 0 ? "#00ff88" : "#555";
    ctx.textBaseline = "middle";
    ctx.fillText(dotText, bx + pad, by + barH / 2);
    ctx.fillStyle = "#ccc";
    ctx.fillText(status, bx + pad + 16, by + barH / 2);
    ctx.fillStyle = "#666";
    ctx.fillText(fpsText, bx + barW - pad - fpsW, by + barH / 2);
    ctx.restore();
  }

  function drawPalmBox(
    ctx: CanvasRenderingContext2D,
    landmarks: any[],
    handedness: string | undefined,
    w: number,
    h: number
  ) {
    const points = PALM_LANDMARKS.map((i) => landmarks[i]).filter(Boolean);
    if (!points.length) return;

    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const p of points) {
      const x = w - p.x * w; // mirror
      const y = p.y * h;
      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x);
      minY = Math.min(minY, y);
      maxY = Math.max(maxY, y);
    }

    ctx.strokeStyle = "#00ff88";
    ctx.lineWidth = 2;
    ctx.strokeRect(minX, minY, maxX - minX, maxY - minY);

    for (const p of points) {
      ctx.beginPath();
      ctx.arc(w - p.x * w, p.y * h, 3, 0, Math.PI * 2);
      ctx.fillStyle = "#00ff88";
      ctx.fill();
    }

    if (handedness) {
      // MediaPipe reports handedness for the unmirrored feed — flip it to
      // match what the user sees as their left/right hand on the mirrored canvas
      const label = handedness === "Left" ? "Right" : "Left";
      ctx.font = "600 13px system-ui, -apple-system, sans-serif";
      ctx.fillStyle = "#00ff88";
      ctx.textAlign = "center";
      ctx.textBaseline = "bottom";
      ctx.fillText(label, (minX + maxX) / 2, minY - 6);
    }
  }
</script>

<div class="cam-container">
  <!-- Only the canvas renders — video lives in JS memory, never in the DOM -->
  <canvas bind:this={canvas} class="cam-canvas"></canvas>

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
