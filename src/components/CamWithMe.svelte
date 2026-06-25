<script lang="ts">
  import { onMount, onDestroy } from "svelte";

  let video: HTMLVideoElement;
  let canvas: HTMLCanvasElement;
  let status = $state("Initializing camera...");
  let faceCount = $state(0);
  let landmarksCount = $state(0);
  let fps = $state(0);
  let error = $state<string | null>(null);
  let stream: MediaStream | null = null;

  // Detection state
  let detectionInterval: ReturnType<typeof setInterval> | null = null;
  let frameCount = 0;
  let lastFpsUpdate = 0;

  // MediaPipe types
  let FaceLandmarkerClass: any;
  let faceLandmarkerInstance: any;
  let running = true;

  // Model CDN path
  const MODEL_URL =
    "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/latest/face_landmarker.task";
  const WASM_CDN = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@latest/wasm";

  onMount(async () => {
    try {
      await initMediaPipe();
      await initCamera();
      status = "Ready — looking for faces";
      startDetectionLoop();
    } catch (e) {
      error = e instanceof Error ? e.message : "Unknown error";
      status = "Failed to start";
    }
  });

  onDestroy(() => {
    running = false;
    if (detectionInterval) clearInterval(detectionInterval);
    if (stream) {
      stream.getTracks().forEach((t) => t.stop());
    }
    if (faceLandmarkerInstance) faceLandmarkerInstance.close();
  });

  async function initMediaPipe() {
    const { FilesetResolver, FaceLandmarker } = await import(
      "@mediapipe/tasks-vision"
    );
    FaceLandmarkerClass = FaceLandmarker;

    status = "Loading face model...";
    const vision = await FilesetResolver.forVisionTasks(WASM_CDN);

    faceLandmarkerInstance = await FaceLandmarker.createFromOptions(vision, {
      baseOptions: {
        modelAssetPath: MODEL_URL,
        delegate: "GPU",
      },
      runningMode: "VIDEO",
      numFaces: 4,
      outputFaceBlendshapes: false,
      outputFacialTransformationMatrixes: false,
      resultCallback: null, // we pull results synchronously
    });

    landmarksCount =
      faceLandmarkerInstance.faceLandmarksCount ?? 468;
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
    video.srcObject = stream;
    await video.play();
  }

  function startDetectionLoop() {
    let animId: number;

    function detect() {
      if (!running) return;

      if (faceLandmarkerInstance && video.readyState >= 2) {
        const now = performance.now();
        const result = faceLandmarkerInstance.detectForVideo(video, now);

        faceCount = result.faceLandmarks?.length ?? 0;

        // Draw on canvas
        drawResults(result);

        // FPS counter
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

  function drawResults(result: any) {
    const ctx = canvas.getContext("2d")!;
    const w = canvas.width;
    const h = canvas.height;
    ctx.clearRect(0, 0, w, h);

    // --- draw mirrored face mesh ---
    if (result.faceLandmarks) {
      for (const landmarks of result.faceLandmarks) {
        drawFaceMesh(ctx, landmarks, w, h, true);
        for (const lm of landmarks) {
          const x = w - lm.x * w;  // mirrored x
          const y = lm.y * h;
          ctx.beginPath();
          ctx.arc(x, y, 1.5, 0, Math.PI * 2);
          ctx.fillStyle = "#00ff88";
          ctx.fill();
        }
      }
    }

    // --- overlay draws (not mirrored) ---
    drawVersionBadge(ctx, w, h);
    drawFaceIndicator(ctx, w, h, result.faceLandmarks?.length ?? 0);
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
    ctx.fillText("v0.1.0", 12 + 28, 12 + 12);
    ctx.restore();
  }

  function drawFaceIndicator(ctx: CanvasRenderingContext2D, w: number, h: number, count: number) {
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
      ctx.fillText("😶  No face detected", x + 12, y + cardH / 2);
    } else {
      ctx.fillStyle = "#8b8fa3";
      ctx.font = "14px system-ui, -apple-system, sans-serif";
      ctx.textBaseline = "middle";
      ctx.fillText(`😀  ${count} face${count > 1 ? "s" : ""}`, x + 12, y + cardH / 2);
      // green dot
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
    const dotText = faceCount > 0 ? "●" : "○";
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
    ctx.fillStyle = faceCount > 0 ? "#00ff88" : "#555";
    ctx.textBaseline = "middle";
    ctx.fillText(dotText, bx + pad, by + barH / 2);
    ctx.fillStyle = "#ccc";
    ctx.fillText(status, bx + pad + 16, by + barH / 2);
    ctx.fillStyle = "#666";
    ctx.fillText(fpsText, bx + barW - pad - fpsW, by + barH / 2);
    ctx.restore();
  }

  function drawFaceMesh(
    ctx: CanvasRenderingContext2D,
    landmarks: any[],
    w: number,
    h: number,
    mirrored: boolean = false
  ) {
    // MediaPipe Face Landmarker connections (indices)
    // Face oval
    const faceOval = [
      10, 338, 297, 332, 284, 251, 389, 356, 454, 323, 361, 288, 397, 365, 379,
      378, 400, 377, 152, 148, 176, 149, 150, 136, 172, 58, 132, 93, 234, 127,
      162, 21, 54, 103, 67, 109, 10,
    ];
    // Left eye
    const leftEye = [33, 7, 163, 144, 145, 153, 154, 155, 133, 173, 157, 158, 159, 160, 161, 246, 33];
    // Right eye
    const rightEye = [362, 382, 381, 380, 374, 373, 390, 249, 263, 466, 388, 387, 386, 385, 384, 398, 362];
    // Lips
    const lips = [61, 146, 91, 181, 84, 17, 314, 405, 321, 375, 291, 409, 270, 269, 267, 0, 37, 39, 40, 185, 61];
    // Left eyebrow
    const leftEyebrow = [46, 53, 52, 65, 55, 70, 63, 105, 66, 107];
    // Right eyebrow
    const rightEyebrow = [276, 283, 282, 295, 285, 300, 293, 334, 296, 336];
    // Nose bridge
    const noseBridge = [168, 6, 197, 195, 5, 4, 1, 19, 94, 2];
    // Nose bottom
    const noseBottom = [141, 135, 169, 175, 217, 219, 197, 2, 97, 98, 99, 100, 101, 115, 141];
    // Irises
    const leftIris = [468, 469, 470, 471];
    const rightIris = [472, 473, 474, 475];

    const connections = [
      ...faceOval, ...leftEye, ...rightEye, ...lips,
      ...leftEyebrow, ...rightEyebrow, ...noseBridge, ...noseBottom,
      ...leftIris, ...rightIris,
    ];

    ctx.strokeStyle = "rgba(0, 255, 136, 0.5)";
    ctx.lineWidth = 1;

    for (let i = 0; i < connections.length - 1; i++) {
      const a = landmarks[connections[i]];
      const b = landmarks[connections[i + 1]];
      if (!a || !b) continue;
      ctx.beginPath();
      const ax = mirrored ? w - a.x * w : a.x * w;
      const bx2 = mirrored ? w - b.x * w : b.x * w;
      ctx.moveTo(ax, a.y * h);
      ctx.lineTo(bx2, b.y * h);
      ctx.stroke();
    }
  }

  function handleVideoResize() {
    if (!video || !canvas) return;
    canvas.width = video.videoWidth || 640;
    canvas.height = video.videoHeight || 480;
  }
</script>

<div class="cam-container">
  <!-- Hidden video captures camera feed -->
  <video
    bind:this={video}
    class="cam-video"
    autoplay
    playsinline
    on:loadedmetadata={handleVideoResize}
    on:resize={handleVideoResize}
  ></video>

  <!-- Overlay canvas for face mesh -->
  <canvas bind:this={canvas} class="cam-canvas"></canvas>

  <!-- Status overlay -->
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

  .cam-video {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    object-fit: cover;
    transform: scaleX(-1); /* mirror for selfie feel */
  }

  .cam-canvas {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    object-fit: cover;
    pointer-events: none;
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
