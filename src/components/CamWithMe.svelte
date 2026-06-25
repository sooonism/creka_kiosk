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

    if (!result.faceLandmarks) return;

    for (const landmarks of result.faceLandmarks) {
      // Draw connections (face mesh)
      drawFaceMesh(ctx, landmarks, w, h);

      // Draw landmark dots
      for (const lm of landmarks) {
        const x = lm.x * w;
        const y = lm.y * h;
        ctx.beginPath();
        ctx.arc(x, y, 1.5, 0, Math.PI * 2);
        ctx.fillStyle = "#00ff88";
        ctx.fill();
      }
    }
  }

  function drawFaceMesh(
    ctx: CanvasRenderingContext2D,
    landmarks: any[],
    w: number,
    h: number
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
      ctx.moveTo(a.x * w, a.y * h);
      ctx.lineTo(b.x * w, b.y * h);
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
  {:else}
    <div class="status-bar">
      <span class="status-dot" class:active={faceCount > 0}></span>
      <span>{status}</span>
      <span class="fps">{fps} fps</span>
      {#if faceCount > 0}
        <span class="face-count">{faceCount} face{faceCount > 1 ? "s" : ""}</span>
      {/if}
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
    transform: scaleX(-1); /* mirror to match video */
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

  .status-bar {
    position: absolute;
    bottom: 2rem;
    left: 50%;
    transform: translateX(-50%);
    display: flex;
    align-items: center;
    gap: 0.75rem;
    padding: 0.5rem 1rem;
    background: rgba(0, 0, 0, 0.6);
    backdrop-filter: blur(8px);
    border-radius: 999px;
    color: #ccc;
    font-size: 0.8rem;
    font-family: monospace;
  }

  .status-dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: #555;
    transition: background 0.2s;
  }
  .status-dot.active {
    background: #00ff88;
    box-shadow: 0 0 8px #00ff88;
  }

  .fps {
    color: #888;
  }
  .face-count {
    color: #00ff88;
    font-weight: 600;
  }
</style>
