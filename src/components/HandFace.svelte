<script lang="ts">
  import { onMount, onDestroy } from "svelte";

  let canvas: HTMLCanvasElement;
  let status = $state("Initializing...");
  let handCount = $state(0);
  let faceCount = $state(0);
  let fps = $state(0);
  let error = $state<string | null>(null);

  let video: HTMLVideoElement | null = null;
  let stream: MediaStream | null = null;

  let handLandmarkerInstance: any;
  let faceLandmarkerInstance: any;
  let running = true;
  let frameCount = 0;
  let lastFpsUpdate = 0;

  // Smoothed hand landmarks (EMA filter)
  let smoothedHands: any[] | null = null;
  let smoothedFace: any[] | null = null;
  const SMOOTH_ALPHA = 0.35;

  const HAND_MODEL =
    "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/latest/hand_landmarker.task";
  const FACE_MODEL =
    "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/latest/face_landmarker.task";
  const WASM_CDN = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@latest/wasm";

  // Face mesh contour connections (MediaPipe topology)
  const FACE_CONTOURS: number[][] = [
    // Face oval
    [10, 338, 297, 332, 284, 251, 389, 356, 454, 323, 361, 288, 397, 365, 379, 378, 400, 377, 152, 148, 176, 149, 150, 136, 172, 58, 132, 93, 234, 127, 162, 21, 54, 103, 67, 109, 10],
    // Left eye
    [33, 7, 163, 144, 145, 153, 154, 155, 133, 173, 157, 158, 159, 160, 161, 246, 33],
    // Right eye
    [362, 382, 381, 380, 374, 373, 390, 249, 263, 466, 388, 387, 386, 385, 384, 398, 362],
    // Left eyebrow
    [46, 53, 52, 65, 55, 70, 63, 105, 66, 107],
    // Right eyebrow
    [276, 283, 282, 295, 285, 300, 293, 334, 296, 336],
    // Lips outer
    [61, 146, 91, 181, 84, 17, 314, 405, 321, 375, 291, 409, 270, 269, 267, 0, 37, 39, 40, 185, 61],
    // Lips inner
    [78, 191, 80, 81, 82, 13, 312, 311, 310, 415, 308, 324, 318, 402, 317, 14, 87, 178, 88, 95, 78],
    // Nose bridge
    [168, 6, 197, 195, 5],
    // Nose bottom
    [195, 244, 245, 44, 51, 134, 131, 49, 48, 220, 279, 278, 282, 295, 331, 415, 416, 433, 430, 4, 458, 439, 440, 275, 274, 48],
  ];

  onMount(async () => {
    try {
      await initMediaPipe();
      await initCamera();
      status = "Ready — show your face and hands";
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
    if (faceLandmarkerInstance) faceLandmarkerInstance.close();
  });

  async function initMediaPipe() {
    const { FilesetResolver, HandLandmarker, FaceLandmarker } = await import("@mediapipe/tasks-vision");
    const vision = await FilesetResolver.forVisionTasks(WASM_CDN);

    status = "Loading hand model...";
    handLandmarkerInstance = await HandLandmarker.createFromOptions(vision, {
      baseOptions: { modelAssetPath: HAND_MODEL, delegate: "GPU" },
      runningMode: "VIDEO",
      numHands: 2,
    });

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

        const handResult = handLandmarkerInstance
          ? handLandmarkerInstance.detectForVideo(video, now)
          : null;
        const faceResult = faceLandmarkerInstance
          ? faceLandmarkerInstance.detectForVideo(video, now)
          : null;

        handCount = handResult?.landmarks?.length ?? 0;
        faceCount = faceResult?.faceLandmarks?.length ?? 0;

        // Apply EMA smoothing to hands
        if (handResult?.landmarks) {
          const raw = handResult.landmarks;
          if (!smoothedHands || raw.length !== smoothedHands.length) {
            smoothedHands = raw.map((hand: any[]) =>
              hand.map((lm: any) => ({ x: lm.x, y: lm.y, z: lm.z }))
            );
          } else {
            for (let h = 0; h < raw.length; h++) {
              for (let i = 0; i < raw[h].length; i++) {
                const s = smoothedHands[h][i];
                const r = raw[h][i];
                s.x += (r.x - s.x) * SMOOTH_ALPHA;
                s.y += (r.y - s.y) * SMOOTH_ALPHA;
                s.z += (r.z - s.z) * SMOOTH_ALPHA;
              }
            }
          }
        } else {
          smoothedHands = null;
        }

        // Apply EMA smoothing to face
        if (faceResult?.faceLandmarks?.[0]) {
          const raw = faceResult.faceLandmarks[0];
          if (!smoothedFace || smoothedFace.length !== raw.length) {
            smoothedFace = raw.map((lm: any) => ({ x: lm.x, y: lm.y, z: lm.z }));
          } else {
            for (let i = 0; i < raw.length; i++) {
              const s = smoothedFace[i];
              const r = raw[i];
              s.x += (r.x - s.x) * SMOOTH_ALPHA;
              s.y += (r.y - s.y) * SMOOTH_ALPHA;
              s.z += (r.z - s.z) * SMOOTH_ALPHA;
            }
          }
        } else {
          smoothedFace = null;
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

  function drawFaceMesh(ctx: CanvasRenderingContext2D, w: number, h: number) {
    if (!smoothedFace) return;
    const lm = smoothedFace;

    // Draw contour lines
    ctx.strokeStyle = "rgba(255, 180, 100, 0.5)";
    ctx.lineWidth = 1.5;
    for (const contour of FACE_CONTOURS) {
      ctx.beginPath();
      for (let i = 0; i < contour.length; i++) {
        const p = lm[contour[i]];
        if (!p) continue;
        const x = w - p.x * w;
        const y = p.y * h;
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.stroke();
    }

    // Eye pupils
    for (const eyeIdx of [468, 473]) {
      const p = lm[eyeIdx];
      if (!p) continue;
      const x = w - p.x * w;
      const y = p.y * h;
      ctx.beginPath();
      ctx.arc(x, y, 3, 0, Math.PI * 2);
      ctx.fillStyle = "#ffd93d";
      ctx.fill();
    }
  }

  function drawHandMesh(ctx: CanvasRenderingContext2D, w: number, h: number) {
    if (!smoothedHands) return;

    const CONNECTIONS = [
      [0, 1],[1, 2],[2, 3],[3, 4],
      [0, 5],[5, 6],[6, 7],[7, 8],
      [0, 9],[9,10],[10,11],[11,12],
      [0,13],[13,14],[14,15],[15,16],
      [0,17],[17,18],[18,19],[19,20],
      [5, 9],[9,13],[13,17],
    ];

    for (const landmarks of smoothedHands) {
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

  function drawFacesOnHands(ctx: CanvasRenderingContext2D, w: number, h: number) {
    if (!smoothedHands) return;

    const FINGERTIPS = [
      { tip: 8, pip: 6, base: 5 },
      { tip: 12, pip: 10, base: 9 },
      { tip: 16, pip: 14, base: 13 },
      { tip: 20, pip: 18, base: 17 },
    ];

    for (const lm of smoothedHands) {
      for (const f of FINGERTIPS) {
        const tip = lm[f.tip], pip = lm[f.pip], base = lm[f.base];
        if (!tip || !pip || !base) continue;
        if (tip.y >= pip.y) continue;
        drawSmileyFace(ctx, w, h, tip, base);
      }
    }
  }

  function drawSmileyFace(ctx: CanvasRenderingContext2D, w: number, h: number, tip: any, base: any) {
    const bx = w - tip.x * w;
    const by = tip.y * h;
    const dx = bx - (w - base.x * w);
    const dy = by - base.y * h;
    const angle = Math.atan2(dy, dx);
    const scale = Math.min(2, Math.max(0.2, 1 - (tip.z ?? 0) * 3));
    const faceR = 18 * scale;

    ctx.save();
    ctx.translate(bx, by);
    ctx.rotate(angle + Math.PI / 2);

    const grad = ctx.createRadialGradient(0, 0, 0, 0, 0, faceR * 2);
    grad.addColorStop(0, "rgba(255, 200, 60, 0.3)");
    grad.addColorStop(1, "rgba(255, 200, 60, 0)");
    ctx.beginPath();
    ctx.arc(0, 0, faceR * 2, 0, Math.PI * 2);
    ctx.fillStyle = grad;
    ctx.fill();

    ctx.beginPath();
    ctx.arc(0, 0, faceR, 0, Math.PI * 2);
    ctx.fillStyle = "#ffd93d";
    ctx.fill();
    ctx.strokeStyle = "rgba(0, 0, 0, 0.15)";
    ctx.lineWidth = 1.5 * scale;
    ctx.stroke();

    const eyeOff = faceR * 0.35;
    const eyeR = 3 * scale;
    for (const ex of [-eyeOff, eyeOff]) {
      ctx.beginPath();
      ctx.arc(ex, -faceR * 0.2, eyeR, 0, Math.PI * 2);
      ctx.fillStyle = "#222";
      ctx.fill();
    }

    ctx.beginPath();
    ctx.arc(0, faceR * 0.1, faceR * 0.45, 0.15 * Math.PI, 0.85 * Math.PI);
    ctx.strokeStyle = "#222";
    ctx.lineWidth = 2.5 * scale;
    ctx.lineCap = "round";
    ctx.stroke();

    ctx.beginPath();
    ctx.arc(-faceR * 0.25, -faceR * 0.35, faceR * 0.25, 0, Math.PI * 2);
    ctx.fillStyle = "rgba(255, 255, 255, 0.3)";
    ctx.fill();

    ctx.restore();
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

    // 2. Face mesh overlay
    drawFaceMesh(ctx, w, h);

    // 3. Hand skeleton
    drawHandMesh(ctx, w, h);

    // 4. Smiley faces on extended fingertips
    drawFacesOnHands(ctx, w, h);

    // 5. HUD
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
    const cardW = 200;
    const cardH = 28;
    let y = padding;

    const dotFace = faceCount > 0 ? "🟡" : "⚫";
    drawCard(ctx, w - padding - cardW, y, cardW, cardH, `${dotFace}  Face: ${faceCount}`, faceCount > 0 ? "#fbbf24" : "#555");
    y += cardH + 6;

    const dotHand = handCount > 0 ? "🔵" : "⚫";
    drawCard(ctx, w - padding - cardW, y, cardW, cardH, `${dotHand}  Hands: ${handCount}`, handCount > 0 ? "#00ccff" : "#555");
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
    const dotText = (faceCount + handCount) > 0 ? "●" : "○";
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

    ctx.fillStyle = (faceCount + handCount) > 0 ? "#ffd93d" : "#555";
    ctx.textBaseline = "middle";
    ctx.fillText(dotText, bx + pad, by + barH / 2);

    ctx.fillStyle = "#ccc";
    ctx.fillText(status, bx + pad + 16, by + barH / 2);

    ctx.fillStyle = "#666";
    ctx.fillText(fpsText, bx + barW - pad - fpsW, by + barH / 2);
    ctx.restore();
  }
</script>

<div class="hand-face-container">
  <canvas bind:this={canvas} class="hand-face-canvas"></canvas>

  {#if error}
    <div class="overlay error">
      <div class="overlay-icon">⚠️</div>
      <div class="overlay-text">{error}</div>
    </div>
  {/if}
</div>

<style>
  .hand-face-container {
    position: fixed;
    inset: 0;
    background: #000;
    overflow: hidden;
  }

  .hand-face-canvas {
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
