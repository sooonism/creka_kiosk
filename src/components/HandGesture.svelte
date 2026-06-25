<script lang="ts">
  import { onMount, onDestroy } from "svelte";

  let video: HTMLVideoElement;
  let canvas: HTMLCanvasElement;
  let status = $state("Initializing...");
  let handCount = $state(0);
  let handedness = $state<string[]>([]);
  let gestures = $state<string[]>([]);
  let fps = $state(0);
  let error = $state<string | null>(null);
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
    if (handLandmarkerInstance) handLandmarkerInstance.close();
  });

  async function initMediaPipe() {
    const { FilesetResolver, HandLandmarker } = await import("@mediapipe/tasks-vision");

    status = "Loading hand model...";
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
      video: { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: "user" },
      audio: false,
    });
    video.srcObject = stream;
    await video.play();
  }

  function startDetectionLoop() {
    function detect() {
      if (!running) return;

      if (handLandmarkerInstance && video.readyState >= 2) {
        const now = performance.now();
        const result = handLandmarkerInstance.detectForVideo(video, now);

        handCount = result.landmarks?.length ?? 0;
        handedness = (result.handedness ?? []).map((h: any) => h[0]?.categoryName ?? "?");
        gestures = classifyGestures(result.landmarks);

        drawResults(result);

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

      // Finger states: 0 = curled, 1 = extended
      const fingerExtended = (tip: number, pip: number, mcp: number): number => {
        // For thumb we compare tip to IP joint differently
        return lm(tip).y < lm(pip).y ? 1 : 0;
      };

      // Thumb: compare tip (4) to IP (3) — uses x for cross-hand comparison
      const thumbExtended = lm(4).x < lm(3).x ? 1 : 0;

      // Other fingers: tip.y < pip.y means extended (when hand is upright)
      const indexExt  = fingerExtended(8, 6, 5);
      const middleExt = fingerExtended(12, 10, 9);
      const ringExt   = fingerExtended(16, 14, 13);
      const pinkyExt  = fingerExtended(20, 18, 17);

      const fingers = [thumbExtended, indexExt, middleExt, ringExt, pinkyExt];
      const extCount = fingers.reduce((a, b) => a + b, 0);

      // ✊ Fist
      if (extCount === 0) return "✊ Fist";

      // 🖐️ Open palm
      if (extCount === 5) return "🖐️ Palm";

      // ✌️ Peace / Victory
      if (indexExt && middleExt && !ringExt && !pinkyExt) return "✌️ Peace";

      // 👍 Thumbs up
      if (thumbExtended && !indexExt && !middleExt && !ringExt && !pinkyExt) return "👍 Thumbs up";

      // 👎 Thumbs down (thumb extended but y > IP)
      if (lm(4).y > lm(3).y && !indexExt && !middleExt && !ringExt && !pinkyExt) return "👎 Thumbs down";

      // 🤙 Call me (pinky + thumb)
      if (thumbExtended && !indexExt && !middleExt && !ringExt && pinkyExt) return "🤙 Call me";

      // 🤘 Rock (index + pinky)
      if (indexExt && !middleExt && !ringExt && pinkyExt) return "🤘 Rock";

      // ☝️ Point up
      if (indexExt && !middleExt && !ringExt && !pinkyExt) return "☝️ Point";

      // 🤏 Pinch (thumb tip close to index tip)
      const thumbIndexDist = Math.hypot(lm(4).x - lm(8).x, lm(4).y - lm(8).y, lm(4).z - lm(8).z);
      if (thumbIndexDist < 0.06 && extCount <= 2) return "🤏 Pinch";

      return `${extCount} up`;
    });
  }

  function drawResults(result: any) {
    const ctx = canvas.getContext("2d")!;
    const w = canvas.width;
    const h = canvas.height;
    ctx.clearRect(0, 0, w, h);

    if (!result.landmarks) return;

    const CONNECTIONS = [
      [0, 1], [1, 2], [2, 3], [3, 4],           // thumb
      [0, 5], [5, 6], [6, 7], [7, 8],           // index
      [0, 9], [9, 10], [10, 11], [11, 12],      // middle
      [0, 13], [13, 14], [14, 15], [15, 16],    // ring
      [0, 17], [17, 18], [18, 19], [19, 20],    // pinky
      [5, 9], [9, 13], [13, 17],                // palm connections
    ];

    for (const landmarks of result.landmarks) {
      // Draw connections
      ctx.strokeStyle = "rgba(0, 200, 255, 0.6)";
      ctx.lineWidth = 2;
      for (const [a, b] of CONNECTIONS) {
        ctx.beginPath();
        ctx.moveTo(landmarks[a].x * w, landmarks[a].y * h);
        ctx.lineTo(landmarks[b].x * w, landmarks[b].y * h);
        ctx.stroke();
      }

      // Draw joint dots
      for (const lm of landmarks) {
        ctx.beginPath();
        ctx.arc(lm.x * w, lm.y * h, 3, 0, Math.PI * 2);
        ctx.fillStyle = "#00ccff";
        ctx.fill();
      }
    }
  }

  function handleVideoResize() {
    if (!video || !canvas) return;
    canvas.width = video.videoWidth || 640;
    canvas.height = video.videoHeight || 480;
  }
</script>

<div class="gesture-container">
  <video
    bind:this={video}
    class="gesture-video"
    autoplay
    playsinline
    onloadedmetadata={handleVideoResize}
    onresize={handleVideoResize}
  ></video>

  <canvas bind:this={canvas} class="gesture-canvas"></canvas>

  {#if error}
    <div class="overlay error">
      <div class="overlay-icon">⚠️</div>
      <div class="overlay-text">{error}</div>
    </div>
  {:else}
    <!-- Gesture indicator badges -->
    <div class="gesture-indicators">
      {#if handCount === 0}
        <div class="indicator idle">
          <span class="icon">🖐️</span>
          <span>Show your hand</span>
        </div>
      {:else}
        {#each Array(handCount) as _, i}
          <div class="indicator active">
            <span class="hand-icon">{handedness[i] === "Right" ? "👉" : "👈"}</span>
            <span class="hand-label">{handedness[i] ?? "?"} hand</span>
            <span class="gesture-badge">{gestures[i] ?? "..."}</span>
          </div>
        {/each}
      {/if}
    </div>

    <div class="status-bar">
      <span class="status-dot" class:active={handCount > 0}></span>
      <span>{status}</span>
      <span class="fps">{fps} fps</span>
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

  .gesture-video {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    object-fit: cover;
    transform: scaleX(-1);
  }

  .gesture-canvas {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    object-fit: cover;
    transform: scaleX(-1);
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

  .gesture-indicators {
    position: absolute;
    top: 1.5rem;
    right: 1.5rem;
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }

  .indicator {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.5rem 1rem;
    border-radius: 12px;
    background: rgba(0, 0, 0, 0.6);
    backdrop-filter: blur(8px);
    font-size: 0.9rem;
    transition: all 0.2s;
  }
  .indicator.idle {
    color: #888;
  }
  .indicator.active {
    color: #e1e4ea;
    border: 1px solid rgba(0, 200, 255, 0.3);
  }
  .hand-icon {
    font-size: 1.2rem;
  }
  .hand-label {
    color: #8b8fa3;
    font-size: 0.8rem;
  }
  .gesture-badge {
    background: rgba(0, 200, 255, 0.15);
    color: #00ccff;
    padding: 0.15rem 0.5rem;
    border-radius: 6px;
    font-weight: 600;
    font-size: 0.8rem;
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
    background: #00ccff;
    box-shadow: 0 0 8px #00ccff;
  }
  .fps {
    color: #888;
  }
</style>
