<script lang="ts">
  import { onMount, onDestroy } from "svelte";

  let canvas: HTMLCanvasElement;
  let status = $state("Initializing...");
  let poseCount = $state(0);
  let fps = $state(0);
  let error = $state<string | null>(null);

  let video: HTMLVideoElement | null = null;
  let stream: MediaStream | null = null;

  let poseLandmarkerInstance: any;
  let running = true;
  let frameCount = 0;
  let lastFpsUpdate = 0;

  // Smoothed pose landmarks (EMA filter)
  let smoothedPose: any[] | null = null;
  const SMOOTH_ALPHA = 0.35;

  const POSE_MODEL =
    "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task";
  const WASM_CDN = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@latest/wasm";

  // Pose skeleton connections: pairs of landmark indices
  const POSE_CONNECTIONS: [number, number][] = [
    // Face
    [0, 1], [1, 2], [2, 3], [3, 7],
    [0, 4], [4, 5], [5, 6], [6, 8],
    [9, 10],
    // Torso
    [11, 12],
    [11, 23], [12, 24],
    [23, 24],
    // Left arm
    [11, 13], [13, 15],
    [15, 17], [15, 19], [15, 21],
    [17, 19],
    // Right arm
    [12, 14], [14, 16],
    [16, 18], [16, 20], [16, 22],
    [18, 20],
    // Left leg
    [23, 25], [25, 27],
    [27, 29], [29, 31], [27, 31],
    // Right leg
    [24, 26], [26, 28],
    [28, 30], [30, 32], [28, 32],
  ];

  // Segment colors for visual clarity
  function segmentColor(a: number, b: number): string {
    const face = [0,1,2,3,4,5,6,7,8,9,10];
    const torso = [11,12,23,24];
    if (face.includes(a) && face.includes(b)) return "rgba(255, 200, 100, 0.6)";
    if (torso.includes(a) && torso.includes(b)) return "rgba(150, 200, 255, 0.5)";
    if ( (a >= 11 && a <= 22) || (b >= 11 && b <= 22) ) return "rgba(100, 255, 180, 0.6)";
    return "rgba(255, 150, 255, 0.6)";
  }

  onMount(async () => {
    try {
      await initMediaPipe();
      await initCamera();
      status = "Ready — stand in frame";
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
    if (poseLandmarkerInstance) poseLandmarkerInstance.close();
  });

  async function initMediaPipe() {
    const { FilesetResolver, PoseLandmarker } = await import("@mediapipe/tasks-vision");
    const vision = await FilesetResolver.forVisionTasks(WASM_CDN);

    status = "Loading pose model...";
    poseLandmarkerInstance = await PoseLandmarker.createFromOptions(vision, {
      baseOptions: { modelAssetPath: POSE_MODEL, delegate: "GPU" },
      runningMode: "VIDEO",
      numPoses: 1,
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
  }

  function startDetectionLoop() {
    function detect() {
      if (!running || !video) return;
      if (video.readyState >= 2) {
        const now = performance.now();

        const result = poseLandmarkerInstance
          ? poseLandmarkerInstance.detectForVideo(video, now)
          : null;

        poseCount = result?.landmarks?.length ?? 0;

        // Apply EMA smoothing
        if (result?.landmarks?.[0]) {
          const raw = result.landmarks[0];
          if (!smoothedPose || smoothedPose.length !== raw.length) {
            smoothedPose = raw.map((lm: any) => ({ x: lm.x, y: lm.y, z: lm.z }));
          } else {
            for (let i = 0; i < raw.length; i++) {
              const s = smoothedPose[i];
              const r = raw[i];
              s.x += (r.x - s.x) * SMOOTH_ALPHA;
              s.y += (r.y - s.y) * SMOOTH_ALPHA;
              s.z += (r.z - s.z) * SMOOTH_ALPHA;
            }
          }
        } else {
          smoothedPose = null;
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

    // 1. Mirrored camera feed
    ctx.save();
    ctx.scale(-1, 1);
    ctx.drawImage(video, -w, 0, w, h);
    ctx.restore();

    // 2. Pose skeleton
    if (smoothedPose) {
      const lm = smoothedPose;

      // Lines
      ctx.lineCap = "round";
      for (const [a, b] of POSE_CONNECTIONS) {
        const p1 = lm[a], p2 = lm[b];
        if (!p1 || !p2) continue;
        ctx.strokeStyle = segmentColor(a, b);
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.moveTo(w - p1.x * w, p1.y * h);
        ctx.lineTo(w - p2.x * w, p2.y * h);
        ctx.stroke();
      }

      // Joint dots
      for (const p of lm) {
        if (!p) continue;
        ctx.beginPath();
        ctx.arc(w - p.x * w, p.y * h, 4, 0, Math.PI * 2);
        ctx.fillStyle = "#ffffff";
        ctx.fill();
        ctx.strokeStyle = "rgba(0, 0, 0, 0.3)";
        ctx.lineWidth = 1;
        ctx.stroke();
      }
    }

    // 3. HUD
    drawVersionBadge(ctx, w, h);
    drawIndicators(ctx, w, h);
    drawStatusBar(ctx, w, h);
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

  function drawIndicators(ctx: CanvasRenderingContext2D, w: number, h: number) {
    const padding = 16;
    const cardW = 180;
    const cardH = 28;
    const dot = poseCount > 0 ? "🟢" : "⚫";
    drawCard(ctx, w - padding - cardW, padding, cardW, cardH, `${dot}  Body: ${poseCount}`, poseCount > 0 ? "#66ff99" : "#555");
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

  function drawStatusBar(ctx: CanvasRenderingContext2D, w: number, h: number) {
    const barH = 32;
    const pad = 12;
    const fpsText = `${fps} fps`;
    const dotText = poseCount > 0 ? "●" : "○";
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

    ctx.fillStyle = poseCount > 0 ? "#66ff99" : "#555";
    ctx.textBaseline = "middle";
    ctx.fillText(dotText, bx + pad, by + barH / 2);

    ctx.fillStyle = "#ccc";
    ctx.fillText(status, bx + pad + 16, by + barH / 2);

    ctx.fillStyle = "#666";
    ctx.fillText(fpsText, bx + barW - pad - fpsW, by + barH / 2);
    ctx.restore();
  }
</script>

<div class="pose-container">
  <canvas bind:this={canvas} class="pose-canvas"></canvas>

  {#if error}
    <div class="overlay error">
      <div class="overlay-icon">⚠️</div>
      <div class="overlay-text">{error}</div>
    </div>
  {/if}
</div>

<style>
  .pose-container {
    position: fixed;
    inset: 0;
    background: #000;
    overflow: hidden;
  }

  .pose-canvas {
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
