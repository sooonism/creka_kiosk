<script lang="ts">
  import { onMount, onDestroy } from "svelte";

  let canvas: HTMLCanvasElement;
  let status = $state("Initializing...");
  let totalCrossings = $state(0);
  let leftToRight = $state(0);
  let rightToLeft = $state(0);
  let fps = $state(0);
  let error = $state<string | null>(null);
  let activePeople = $state(0);

  let video: HTMLVideoElement | null = null;
  let stream: MediaStream | null = null;
  let poseLandmarkerInstance: any;
  let running = true;
  let frameCount = 0;
  let lastFpsUpdate = 0;

  // ── Tracking state ──
  const ZONE_WIDTH = 300;
  let zoneLeft = 0;
  let zoneRight = 0;

  interface PersonTrack {
    id: number;
    x: number;
    y: number;
    lastNonInsideSide: "left" | "right" | null;
    hasCrossed: boolean; // prevent double-count in same crossing
    side: "left" | "inside" | "right";
    disappeared: boolean;
    landmarks: any[];
    colorIdx: number;
  }

  let nextId = 0;
  let tracks: PersonTrack[] = [];

  // EMA smoothing
  let smoothedPoses: any[][] | null = null;
  const SMOOTH_ALPHA = 0.35;

  const POSE_MODEL =
    "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task";
  const WASM_CDN = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@latest/wasm";

  const PERSON_COLORS = [
    "#00dcff", "#ff6b9d", "#a78bfa", "#fbbf24", "#34d399",
  ];

  const POSE_CONNECTIONS: [number, number][] = [
    [0, 1], [1, 2], [2, 3], [3, 7], [0, 4], [4, 5], [5, 6], [6, 8],
    [9, 10], [11, 12], [11, 23], [12, 24], [23, 24],
    [11, 13], [13, 15], [15, 17], [15, 19], [15, 21], [17, 19],
    [12, 14], [14, 16], [16, 18], [16, 20], [16, 22], [18, 20],
    [23, 25], [25, 27], [27, 29], [29, 31], [27, 31],
    [24, 26], [26, 28], [28, 30], [30, 32], [28, 32],
  ];

  onMount(async () => {
    try {
      await initMediaPipe();
      await initCamera();
      status = "Waiting for people to cross the zone...";
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
    if (poseLandmarkerInstance) poseLandmarkerInstance.close();
  });

  async function initMediaPipe() {
    const { FilesetResolver, PoseLandmarker } = await import("@mediapipe/tasks-vision");
    const vision = await FilesetResolver.forVisionTasks(WASM_CDN);
    status = "Loading pose model...";
    poseLandmarkerInstance = await PoseLandmarker.createFromOptions(vision, {
      baseOptions: { modelAssetPath: POSE_MODEL, delegate: "GPU" },
      runningMode: "VIDEO",
      numPoses: 5,
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
    zoneLeft = canvas.width / 2 - ZONE_WIDTH / 2;
    zoneRight = canvas.width / 2 + ZONE_WIDTH / 2;
  }

  // ── Tracking helpers ──

  function getSide(x: number): "left" | "inside" | "right" {
    if (x < zoneLeft) return "left";
    if (x > zoneRight) return "right";
    return "inside";
  }

  function personCenterX(lm: any[], w: number): number {
    // Use hip midpoint (23 + 24) for stable position tracking, fallback to nose
    const leftHip = lm[23], rightHip = lm[24];
    if (leftHip && rightHip) {
      return w - ((leftHip.x + rightHip.x) / 2) * w;
    }
    const nose = lm[0];
    return nose ? w - nose.x * w : 0;
  }

  function personCenterY(lm: any[], h: number): number {
    const leftHip = lm[23], rightHip = lm[24];
    if (leftHip && rightHip) {
      return ((leftHip.y + rightHip.y) / 2) * h;
    }
    const nose = lm[0];
    return nose ? nose.y * h : 0;
  }

  function matchAndTrack(rawPoses: any[][], w: number, h: number) {
    // Mark all existing tracks as disappeared (will be re-matched)
    for (const t of tracks) t.disappeared = true;

    const MATCH_DIST = 150; // max px distance for same-person matching

    for (const lm of rawPoses) {
      const cx = personCenterX(lm, w);
      const cy = personCenterY(lm, h);

      // Find closest active track
      let bestTrack: PersonTrack | null = null;
      let bestDist = MATCH_DIST;

      for (const t of tracks) {
        if (!t.disappeared) continue; // already matched this frame
        const d = Math.hypot(t.x - cx, t.y - cy);
        if (d < bestDist) {
          bestDist = d;
          bestTrack = t;
        }
      }

      const currentSide = getSide(cx);

      if (bestTrack) {
        // Match found — update
        bestTrack.disappeared = false;
        bestTrack.x = cx;
        bestTrack.y = cy;
        bestTrack.side = currentSide;
        bestTrack.landmarks = lm;

        // Crossing detection: track the last non-inside side
        if (currentSide !== "inside") {
          if (
            bestTrack.lastNonInsideSide !== null &&
            bestTrack.lastNonInsideSide !== currentSide &&
            !bestTrack.hasCrossed
          ) {
            // This is a crossing!
            if (bestTrack.lastNonInsideSide === "left" && currentSide === "right") {
              leftToRight++;
            } else if (bestTrack.lastNonInsideSide === "right" && currentSide === "left") {
              rightToLeft++;
            }
            totalCrossings++;
            bestTrack.hasCrossed = true;
            bestTrack.lastNonInsideSide = currentSide;
          } else {
            bestTrack.lastNonInsideSide = currentSide;
          }
        }
      } else {
        // New person — create track
        tracks.push({
          id: nextId++,
          x: cx,
          y: cy,
          lastNonInsideSide: currentSide !== "inside" ? currentSide : null,
          hasCrossed: false,
          side: currentSide,
          disappeared: false,
          landmarks: lm,
          colorIdx: nextId % PERSON_COLORS.length,
        });
      }
    }

    // Remove tracks that disappeared 20+ frames ago
    tracks = tracks.filter((t) => {
      if (t.disappeared) {
        // fade them out — give them a few frames to reappear
        // we track disappearance by checking if they were unmatched
        // simple approach: remove immediately if not detected
        return false;
      }
      return true;
    });

    // When a detected person leaves the zone, reset hasCrossed so next entry can be counted
    for (const t of tracks) {
      if (t.side === "inside") continue; // still inside
      // Reset crossing flag so next entry from the other side counts
      t.hasCrossed = false;
    }

    activePeople = tracks.length;
  }

  function startDetectionLoop() {
    function detect() {
      if (!running || !video) return;
      if (video.readyState >= 2) {
        const now = performance.now();
        const result = poseLandmarkerInstance
          ? poseLandmarkerInstance.detectForVideo(video, now)
          : null;

        const rawPoses: any[][] = result?.landmarks ?? [];

        // Apply EMA smoothing
        if (rawPoses.length > 0) {
          if (!smoothedPoses || smoothedPoses.length !== rawPoses.length) {
            smoothedPoses = rawPoses.map((pose: any[]) =>
              pose.map((lm: any) => ({ x: lm.x, y: lm.y, z: lm.z }))
            );
          } else {
            for (let p = 0; p < rawPoses.length; p++) {
              for (let i = 0; i < rawPoses[p].length; i++) {
                const s = smoothedPoses[p][i];
                const r = rawPoses[p][i];
                if (s && r) {
                  s.x += (r.x - s.x) * SMOOTH_ALPHA;
                  s.y += (r.y - s.y) * SMOOTH_ALPHA;
                  s.z += (r.z - s.z) * SMOOTH_ALPHA;
                }
              }
            }
          }
        } else {
          smoothedPoses = null;
        }

        const w = canvas.width;
        const h = canvas.height;

        // Match raw poses (not smoothed) for tracking responsiveness
        matchAndTrack(rawPoses, w, h);

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
    const w = canvas.width;
    const h = canvas.height;

    // Mirrored webcam
    ctx.save();
    ctx.scale(-1, 1);
    ctx.drawImage(video, -w, 0, w, h);
    ctx.restore();

    // Zone
    drawZone(ctx, w, h);

    // Skeltons for tracked people
    for (const t of tracks) {
      if (t.landmarks && t.landmarks.length > 0) {
        drawSkeleton(ctx, t.landmarks, w, h, PERSON_COLORS[t.colorIdx % PERSON_COLORS.length]);
      }
    }

    // Crossing flash
    drawCrossingIndicator(ctx, w, h);

    // HUD
    drawHUD(ctx, w, h);
    drawCounter(ctx, w, h);
  }

  function drawZone(ctx: CanvasRenderingContext2D, w: number, h: number) {
    // Zone background
    ctx.fillStyle = "rgba(0, 220, 255, 0.04)";
    ctx.fillRect(zoneLeft, 0, ZONE_WIDTH, h);

    // Zone borders
    ctx.strokeStyle = "rgba(0, 220, 255, 0.25)";
    ctx.lineWidth = 1.5;
    ctx.setLineDash([6, 6]);
    ctx.beginPath();
    ctx.moveTo(zoneLeft, 0);
    ctx.lineTo(zoneLeft, h);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(zoneRight, 0);
    ctx.lineTo(zoneRight, h);
    ctx.stroke();
    ctx.setLineDash([]);

    // Center line (faint)
    ctx.strokeStyle = "rgba(0, 220, 255, 0.06)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(w / 2, 0);
    ctx.lineTo(w / 2, h);
    ctx.stroke();

    // Labels
    ctx.fillStyle = "rgba(0, 220, 255, 0.15)";
    ctx.font = "10px monospace";
    ctx.textAlign = "left";
    ctx.textBaseline = "bottom";
    ctx.fillText("in", zoneLeft + 8, h - 8);
    ctx.textAlign = "right";
    ctx.fillText("out", zoneRight - 8, h - 8);

    // Direction arrows in zone
    ctx.fillStyle = "rgba(0, 220, 255, 0.06)";
    ctx.font = "20px system-ui";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    const arrowY = h * 0.15;
    ctx.fillText("→", zoneLeft + ZONE_WIDTH * 0.25, arrowY);
    ctx.fillText("←", zoneLeft + ZONE_WIDTH * 0.75, arrowY);
  }

  function drawSkeleton(
    ctx: CanvasRenderingContext2D,
    lm: any[],
    w: number,
    h: number,
    color: string
  ) {
    ctx.lineCap = "round";
    ctx.globalAlpha = 0.6;

    for (const [a, b] of POSE_CONNECTIONS) {
      const p1 = lm[a], p2 = lm[b];
      if (!p1 || !p2) continue;
      ctx.strokeStyle = color;
      ctx.lineWidth = 2.5;
      ctx.beginPath();
      ctx.moveTo(w - p1.x * w, p1.y * h);
      ctx.lineTo(w - p2.x * w, p2.y * h);
      ctx.stroke();
    }

    // Joint dots
    ctx.globalAlpha = 0.8;
    for (const pt of lm) {
      if (!pt) continue;
      ctx.beginPath();
      ctx.arc(w - pt.x * w, pt.y * h, 3, 0, Math.PI * 2);
      ctx.fillStyle = "#ffffff";
      ctx.fill();
    }

    ctx.globalAlpha = 1;
  }

  // ── Crossing flash ──
  let flashText = "";
  let flashAlpha = 0;

  // Track crossings for flash animation
  let prevTotal = 0;

  function drawCrossingIndicator(ctx: CanvasRenderingContext2D, w: number, h: number) {
    if (totalCrossings > prevTotal) {
      flashText = `+${totalCrossings - prevTotal}`;
      flashAlpha = 1;
      prevTotal = totalCrossings;
    }

    if (flashAlpha > 0) {
      ctx.save();
      ctx.globalAlpha = flashAlpha;
      const cx = w / 2;
      const cy = h * 0.35;
      ctx.fillStyle = "#00dcff";
      ctx.font = "bold 48px system-ui, sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.shadowColor = "rgba(0, 220, 255, 0.4)";
      ctx.shadowBlur = 30;
      ctx.fillText(flashText, cx, cy);
      ctx.restore();
      flashAlpha = Math.max(0, flashAlpha - 0.02);
    }
  }

  // ── HUD ──

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

    // Active people badge
    if (activePeople > 0) {
      ctx.save();
      ctx.fillStyle = "rgba(0, 0, 0, 0.45)";
      ctx.beginPath();
      ctx.roundRect(12, 40, 90, 22, 6);
      ctx.fill();
      ctx.fillStyle = "#a78bfa";
      ctx.font = "11px monospace";
      ctx.textBaseline = "middle";
      ctx.textAlign = "left";
      ctx.fillText(`● ${activePeople} tracked`, 18, 51);
      ctx.restore();
    }
  }

  function drawCounter(ctx: CanvasRenderingContext2D, w: number, h: number) {
    const pad = 16;
    const cardW = 200;
    const cardH = 70;
    const x = w - pad - cardW;
    const y = pad;

    // Card background
    ctx.save();
    ctx.shadowColor = "rgba(0, 0, 0, 0.5)";
    ctx.shadowBlur = 20;
    ctx.fillStyle = "rgba(0, 0, 0, 0.65)";
    ctx.beginPath();
    ctx.roundRect(x, y, cardW, cardH, 12);
    ctx.fill();
    ctx.shadowBlur = 0;

    // Total count
    ctx.fillStyle = "#ffffff";
    ctx.font = "bold 32px system-ui, sans-serif";
    ctx.textAlign = "right";
    ctx.textBaseline = "top";
    ctx.fillText(String(totalCrossings), x + cardW - 14, y + 8);

    // Label
    ctx.fillStyle = "rgba(255,255,255,0.3)";
    ctx.font = "10px system-ui, sans-serif";
    ctx.textAlign = "right";
    ctx.fillText("crossings", x + cardW - 14, y + 44);

    // L→R / R→L breakdown
    ctx.textAlign = "left";
    ctx.fillStyle = "#00dcff";
    ctx.font = "10px monospace";
    ctx.fillText(`→ ${leftToRight}`, x + 14, y + 16);
    ctx.fillStyle = "#ff6b9d";
    ctx.fillText(`← ${rightToLeft}`, x + 14, y + 36);
    ctx.restore();
  }
</script>

<div class="human-counter-page">
  <div class="human-counter-container">
    <canvas bind:this={canvas} class="human-counter-canvas"></canvas>
    {#if error}
      <div class="overlay error">
        <div class="overlay-icon">⚠️</div>
        <div class="overlay-text">{error}</div>
      </div>
    {/if}
  </div>
  <div class="human-counter-footer">
    <span class="footer-label">Zone Counter — count people crossing a 300px detection zone</span>
  </div>
</div>

<style>
  .human-counter-page {
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

  .human-counter-container {
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

  .human-counter-canvas {
    display: block;
    max-width: 100%;
    max-height: calc(100vh - 100px);
    object-fit: contain;
    border-radius: 16px;
  }

  .human-counter-footer {
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
