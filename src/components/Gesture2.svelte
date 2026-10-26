<script lang="ts">
  import { onMount, onDestroy } from "svelte";

  let canvas: HTMLCanvasElement;
  let canvasWrapper: HTMLDivElement;
  let status = $state("Initializing...");
  let handCount = $state(0);
  let faceCount = $state(0);
  let handedness = $state<string[]>([]);
  let gestures = $state<string[]>([]);
  let fps = $state(0);
  let error = $state<string | null>(null);
  let canvasWidth = $state(0);
  let canvasHeight = $state(0);

  let video: HTMLVideoElement | null = null;
  let stream: MediaStream | null = null;

  let handLandmarkerInstance: any;
  let faceLandmarkerInstance: any;
  let running = true;
  let frameCount = 0;
  let lastFpsUpdate = 0;

  let smoothedHands: any[] | null = null;
  let smoothedFace: any[] | null = null;
  let faceRect: { x: number; y: number; w: number; h: number } | null = null;
  let faceAngle = 0; // roll in radians
  let faceHatX = 0; // hat anchor x (eye midpoint)
  let faceHatY = 0; // hat anchor y (above eye midpoint)
  let hatYOffset = $state(0); // slider: fine-tune hat height
  let hatScalePct = $state(100); // slider: hat size multiplier %
  let showOverlays = $state(false); // toggle face/hand/skeleton overlays
  const SMOOTH_ALPHA = 0.35;

  // ── Images ──
  let imgNkob: HTMLImageElement | null = null;
  let imgGoose: HTMLImageElement | null = null;
  let imgFox: HTMLImageElement | null = null;
  let imagesLoaded = false;

  // ── Knobs ──
  const KNOB_SIZE = 70;
  const KNOB_MARGIN_X = 75;
  const KNOB_TOP = 20;
  const KNOB_GAP = 80;
  const DWELL_FRAMES = 60;

  interface Knob {
    id: string;
    x: number;
    y: number;
    img: HTMLImageElement | null;
    dwellCounter: number;
    active: boolean;
    attachedHand: number | null; // hand index the image follows
    attachedFinger: number | null; // fingertip landmark index (4,8,12,16,20)
  }

  let knobs: Knob[] = [];
  let followerTrails: { key: string; trail: { x: number; y: number; life: number }[] }[] = [];
  let perchedId: string | null = null; // permanently perched on forehead, detached from finger

  // Config
  const HAND_MODEL = "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/latest/hand_landmarker.task";
  const FACE_MODEL = "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/latest/face_landmarker.task";
  const WASM_CDN = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@latest/wasm";

  const FACE_CONTOURS: number[][] = [
    [10, 338, 297, 332, 284, 251, 389, 356, 454, 323, 361, 288, 397, 365, 379, 378, 400, 377, 152, 148, 176, 149, 150, 136, 172, 58, 132, 93, 234, 127, 162, 21, 54, 103, 67, 109, 10],
    [33, 7, 163, 144, 145, 153, 154, 155, 133, 173, 157, 158, 159, 160, 161, 246, 33],
    [362, 382, 381, 380, 374, 373, 390, 249, 263, 466, 388, 387, 386, 385, 384, 398, 362],
    [46, 53, 52, 65, 55, 70, 63, 105, 66, 107],
    [276, 283, 282, 295, 285, 300, 293, 334, 296, 336],
    [61, 146, 91, 181, 84, 17, 314, 405, 321, 375, 291, 409, 270, 269, 267, 0, 37, 39, 40, 185, 61],
    [78, 191, 80, 81, 82, 13, 312, 311, 310, 415, 308, 324, 318, 402, 317, 14, 87, 178, 88, 95, 78],
    [168, 6, 197, 195, 5],
    [195, 244, 245, 44, 51, 134, 131, 49, 48, 220, 279, 278, 282, 295, 331, 415, 416, 433, 430, 4, 458, 439, 440, 275, 274, 48],
  ];

  const HAND_CONNECTIONS: [number, number][] = [
    [0, 1],[1, 2],[2, 3],[3, 4],
    [0, 5],[5, 6],[6, 7],[7, 8],
    [0, 9],[9,10],[10,11],[11,12],
    [0,13],[13,14],[14,15],[15,16],
    [0,17],[17,18],[18,19],[19,20],
    [5, 9],[9,13],[13,17],
  ];

  const WRIST = 0;
  const INDEX_TIP = 8;
  const FINGER_TIPS = [4, 8, 12, 16, 20];
  const INDEX_MCP = 5, INDEX_PIP = 6;
  const MIDDLE_MCP = 9, MIDDLE_PIP = 10;
  const RING_MCP = 13;
  const PINKY_MCP = 17, PINKY_TIP = 20;

  onMount(async () => {
    try {
      await loadImages();
      await initMediaPipe();
      await initCamera();
      status = "Ready — hover a knob for 1s to attach";
      startDetectionLoop();
    } catch (e) {
      error = e instanceof Error ? e.message : "Unknown error";
      status = "Failed to start";
    }
  });

  onDestroy(() => {
    running = false;
    if (stream) stream.getTracks().forEach((t) => t.stop());
    if (video) { video.pause(); video.srcObject = null; }
    if (handLandmarkerInstance) handLandmarkerInstance.close();
    if (faceLandmarkerInstance) faceLandmarkerInstance.close();
  });

  function loadImages(): Promise<void> {
    return new Promise((resolve) => {
      let loaded = 0;
      const onload = () => { loaded++; if (loaded === 3) { imagesLoaded = true; resolve(); } };
      imgNkob = new Image(); imgNkob.onload = onload; imgNkob.src = "/img/nkob.png";
      imgGoose = new Image(); imgGoose.onload = onload; imgGoose.src = "/img/goose.png";
      imgFox = new Image(); imgFox.onload = onload; imgFox.src = "/img/fox.png";
    });
  }

  function dist(a: { x?: number; y?: number } | undefined, b: { x?: number; y?: number } | undefined) {
    if (!a || !b) return Infinity;
    return Math.hypot((a.x ?? 0) - (b.x ?? 0), (a.y ?? 0) - (b.y ?? 0));
  }

  async function initMediaPipe() {
    const { FilesetResolver, HandLandmarker, FaceLandmarker } = await import("@mediapipe/tasks-vision");
    const vision = await FilesetResolver.forVisionTasks(WASM_CDN);
    status = "Loading hand model...";
    handLandmarkerInstance = await HandLandmarker.createFromOptions(vision, {
      baseOptions: { modelAssetPath: HAND_MODEL, delegate: "GPU" },
      runningMode: "VIDEO", numHands: 2,
    });
    status = "Loading face model...";
    faceLandmarkerInstance = await FaceLandmarker.createFromOptions(vision, {
      baseOptions: { modelAssetPath: FACE_MODEL, delegate: "GPU" },
      runningMode: "VIDEO", outputFaceBlendshapes: false, outputFacialTransformationMatrixes: false, numFaces: 1,
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
    video.playsInline = true; video.muted = true; video.autoplay = true;
    await video.play();
    setCanvasSize();
  }

  function setCanvasSize() {
    if (!video || !canvas) return;
    const vw = video.videoWidth || 640;
    const vh = video.videoHeight || 480;
    canvas.width = vw; canvas.height = vh;
    canvasWidth = vw; canvasHeight = vh;

    // 4 knobs side by side at top-right
    const totalKnobW = KNOB_SIZE * 4 + KNOB_GAP * 3;
    const startX = vw - KNOB_MARGIN_X - totalKnobW;
    knobs = [
      { id: "nkob", x: startX, y: KNOB_TOP, img: imgNkob, dwellCounter: 0, active: false, attachedHand: null, attachedFinger: null },
      { id: "goose", x: startX + KNOB_SIZE + KNOB_GAP, y: KNOB_TOP, img: imgGoose, dwellCounter: 0, active: false, attachedHand: null, attachedFinger: null },
      { id: "fox", x: startX + (KNOB_SIZE + KNOB_GAP) * 2, y: KNOB_TOP, img: imgFox, dwellCounter: 0, active: false, attachedHand: null, attachedFinger: null },
      { id: "clear", x: startX + (KNOB_SIZE + KNOB_GAP) * 3, y: KNOB_TOP, img: null, dwellCounter: 0, active: false, attachedHand: null, attachedFinger: null },
    ];
  }

  // ── Knob interaction ──

  function updateKnobs(handLandmarks: any[] | null) {
    // Track which fingers are near which knobs
    for (const knob of knobs) {
      let bestHand: number | null = null;
      let bestDist = Infinity;

      if (handLandmarks) {
        for (let h = 0; h < handLandmarks.length; h++) {
          const lm = handLandmarks[h];
          if (!lm || !lm[INDEX_TIP]) continue;
          const tipX = canvas.width - lm[INDEX_TIP].x * canvas.width;
          const tipY = lm[INDEX_TIP].y * canvas.height;
          const d = dist({ x: tipX, y: tipY }, { x: knob.x, y: knob.y });
          if (d < KNOB_SIZE && d < bestDist) {
            bestDist = d;
            bestHand = h;
          }
        }
      }

      if (bestHand !== null) {
        // Finger is near this knob
        knob.dwellCounter++;
        if (knob.dwellCounter >= DWELL_FRAMES && !knob.active) {
          // Activate: attach this image to this hand
          knob.active = true;
          knob.attachedHand = bestHand;
          knob.dwellCounter = DWELL_FRAMES;
          // Initialize trail for this hand if needed
          if (!followerTrails.find(ft => ft.hand === bestHand)) {
            followerTrails.push({ hand: bestHand, trail: [] });
          }
        }
      } else {
        // No finger near this knob
        if (knob.active) {
          // Once active, stays active — re-hover over it to deactivate
          // But if the attached hand leaves frame, keep active anyway
        }
        knob.dwellCounter = Math.max(0, knob.dwellCounter - 4);
      }
    }

    // Check for deactivation: if a finger hovers over an already-active knob
    for (const knob of knobs) {
      if (!knob.active) continue;
      // If the knob's dwell is at max AND a finger is near (bestHand !== null case above caught it)
      // Actually, we handle re-activation in the finger-near logic above.
      // For deactivation: if a finger (any finger) hovers over an active knob and dwell already maxed,
      // we need to toggle. Let me handle this differently.
    }

    // Update trails for active knobs
    if (handLandmarks) {
      for (const knob of knobs) {
        if (!knob.active || knob.attachedHand === null) continue;
        const lm = handLandmarks[knob.attachedHand];
        if (!lm || !lm[INDEX_TIP]) continue;
        const tipX = canvas.width - lm[INDEX_TIP].x * canvas.width;
        const tipY = lm[INDEX_TIP].y * canvas.height;
        let ft = followerTrails.find(t => t.hand === knob.attachedHand);
        if (!ft) {
          ft = { hand: knob.attachedHand, trail: [] };
          followerTrails.push(ft);
        }
        ft.trail.push({ x: tipX, y: tipY, life: 1 });
        if (ft.trail.length > 25) ft.trail.shift();
        for (const t of ft.trail) t.life = Math.max(0, t.life - 0.04);
      }
    }
  }

  function updateKnobsToggle(handLandmarks: any[] | null) {
    for (const knob of knobs) {
      let bestKey: string | null = null; // "hand_finger"
      let bestDist = Infinity;

      if (handLandmarks) {
        for (let h = 0; h < handLandmarks.length; h++) {
          const lm = handLandmarks[h];
          if (!lm) continue;
          for (const f of FINGER_TIPS) {
            if (!lm[f]) continue;
            const tipX = canvas.width - lm[f].x * canvas.width;
            const tipY = lm[f].y * canvas.height;
            const d = dist({ x: tipX, y: tipY }, { x: knob.x, y: knob.y });
            if (d < KNOB_SIZE && d < bestDist) {
              bestDist = d;
              bestKey = `${h}_${f}`;
            }
          }
        }
      }

      if (bestKey !== null) {
        const [bh, bf] = bestKey.split("_").map(Number);

        // ── Special knob: clear hat ──
        if (knob.id === "clear") {
          knob.dwellCounter++;
          if (knob.dwellCounter >= DWELL_FRAMES) {
            perchedId = null;
            knob.dwellCounter = 0;
          }
          continue;
        }

        if (!knob.active) {
          knob.dwellCounter++;
          if (knob.dwellCounter >= DWELL_FRAMES) {
            // Clear any other image on this exact finger first
            for (const other of knobs) {
              if (other !== knob && other.active && other.attachedHand === bh && other.attachedFinger === bf) {
                other.active = false;
                other.attachedHand = null;
                other.attachedFinger = null;
                other.dwellCounter = 0;
              }
            }
            knob.active = true;
            knob.attachedHand = bh;
            knob.attachedFinger = bf;
            knob.dwellCounter = 0;
            const key = `${bh}_${bf}`;
            if (!followerTrails.find(ft => ft.key === key)) {
              followerTrails.push({ key, trail: [] });
            }
          }
        } else if (knob.attachedHand === bh && knob.attachedFinger === bf) {
          // Same finger hovering active knob → deactivate
          knob.dwellCounter++;
          if (knob.dwellCounter >= DWELL_FRAMES) {
            knob.active = false;
            knob.attachedHand = null;
            knob.attachedFinger = null;
            knob.dwellCounter = 0;
          }
        } else {
          // Different finger → clear old attachment first, then charge new
          knob.active = false;
          knob.attachedHand = null;
          knob.attachedFinger = null;
          knob.dwellCounter = 0;
          knob.dwellCounter++;
        }
      } else {
        knob.dwellCounter = Math.max(0, knob.dwellCounter - 4);
      }
    }

    // Update trails for active knobs
    if (handLandmarks) {
      for (const knob of knobs) {
        if (!knob.active || knob.attachedHand === null || knob.attachedFinger === null) continue;
        const lm = handLandmarks[knob.attachedHand];
        if (!lm || !lm[knob.attachedFinger]) continue;
        const tipX = canvas.width - lm[knob.attachedFinger].x * canvas.width;
        const tipY = lm[knob.attachedFinger].y * canvas.height;
        const key = `${knob.attachedHand}_${knob.attachedFinger}`;
        let ft = followerTrails.find(t => t.key === key);
        if (!ft) {
          ft = { key, trail: [] };
          followerTrails.push(ft);
        }
        ft.trail.push({ x: tipX, y: tipY, life: 1 });
        if (ft.trail.length > 25) ft.trail.shift();
        for (const t of ft.trail) t.life = Math.max(0, t.life - 0.04);
      }
    }
  }

  function startDetectionLoop() {
    function detect() {
      if (!running || !video) return;
      if (video.readyState >= 2) {
        const now = performance.now();
        const handResult = handLandmarkerInstance ? handLandmarkerInstance.detectForVideo(video, now) : null;
        handCount = handResult?.landmarks?.length ?? 0;
        handedness = (handResult?.handedness ?? []).map((h: any) => h[0]?.categoryName ?? "?");
        gestures = classifyGestures(handResult?.landmarks);
        const faceResult = faceLandmarkerInstance ? faceLandmarkerInstance.detectForVideo(video, now) : null;
        faceCount = faceResult?.faceLandmarks?.length ?? 0;

        // EMA smoothing
        if (handResult?.landmarks) {
          const raw = handResult.landmarks;
          if (!smoothedHands || raw.length !== smoothedHands.length) {
            smoothedHands = raw.map((hand: any[]) => hand.map((lm: any) => ({ x: lm.x, y: lm.y, z: lm.z })));
          } else {
            for (let h = 0; h < raw.length; h++)
              for (let i = 0; i < raw[h].length; i++) {
                const s = smoothedHands[h][i], r = raw[h][i];
                s.x += (r.x - s.x) * SMOOTH_ALPHA; s.y += (r.y - s.y) * SMOOTH_ALPHA; s.z += (r.z - s.z) * SMOOTH_ALPHA;
              }
          }
        } else { smoothedHands = null; }

        if (faceResult?.faceLandmarks?.[0]) {
          const raw = faceResult.faceLandmarks[0];
          if (!smoothedFace || smoothedFace.length !== raw.length) {
            smoothedFace = raw.map((lm: any) => ({ x: lm.x, y: lm.y, z: lm.z }));
          } else {
            for (let i = 0; i < raw.length; i++) {
              const s = smoothedFace[i], r = raw[i];
              s.x += (r.x - s.x) * SMOOTH_ALPHA; s.y += (r.y - s.y) * SMOOTH_ALPHA; s.z += (r.z - s.z) * SMOOTH_ALPHA;
            }
          }
        } else { smoothedFace = null; faceRect = null; }

        // Calculate face bounding box
        if (smoothedFace && smoothedFace.length > 0) {
          let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
          for (const p of smoothedFace) {
            if (!p) continue;
            const mx = canvas.width - p.x * canvas.width;
            const my = p.y * canvas.height;
            if (mx < minX) minX = mx;
            if (mx > maxX) maxX = mx;
            if (my < minY) minY = my;
            if (my > maxY) maxY = my;
          }
          faceRect = { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
          // Eyes as reference for hat position and rotation
          const le = smoothedFace[33], re = smoothedFace[263];
          if (le && re) {
            const lx = canvas.width - le.x * canvas.width;
            const ly = le.y * canvas.height;
            const rx = canvas.width - re.x * canvas.width;
            const ry = re.y * canvas.height;
            // Roll angle from eye line
            faceAngle = Math.atan2(ly - ry, lx - rx);
            // Hat pin: top-center of the forehead rectangle
            const eyeMidX = (lx + rx) / 2;
            const eyeMidY = (ly + ry) / 2;
            const zoneH = faceRect.h * 0.55;
            const edx = rx - lx, edy = ry - ly;
            const eLen = Math.hypot(edx, edy) || 1;
            // Upward vector perpendicular to eye line
            const ux = -edy / eLen * zoneH;
            const uy = edx / eLen * zoneH;
            faceHatX = eyeMidX + ux;
            faceHatY = eyeMidY + uy + hatYOffset;
          } else {
            faceAngle = 0;
            faceHatX = faceRect.x + faceRect.w / 2;
            faceHatY = faceRect.y - 50;
          }
        } else {
          faceRect = null;
          faceAngle = 0;
        }

        updateKnobsToggle(handResult?.landmarks ?? null);
        drawFrame();
        frameCount++;
        if (now - lastFpsUpdate > 1000) {
          fps = Math.round((frameCount * 1000) / (now - lastFpsUpdate));
          frameCount = 0; lastFpsUpdate = now;
        }
      }
      requestAnimationFrame(detect);
    }
    requestAnimationFrame(detect);
  }

  // ── Gesture classification ──

  function isFingerExtended(lm: any[], tip: number, pip: number, mcp: number): boolean {
    const w = lm[WRIST], m = lm[mcp], p = lm[pip], t = lm[tip];
    if (!w || !m || !p || !t) return false;
    const handSize = dist(w, m);
    if (handSize < 0.01) return false;
    const tipDist = dist(w, t), pipDist = dist(w, p);
    const dot = (p.x - m.x) * (t.x - p.x) + (p.y - m.y) * (t.y - p.y);
    return tipDist > pipDist + handSize * 0.15 && dot > 0;
  }

  function isThumbExtended(lm: any[]): boolean {
    const w = lm[WRIST], m = lm[2], ip = lm[3], tip = lm[4], im = lm[INDEX_MCP];
    if (!w || !m || !ip || !tip || !im) return false;
    const handSize = dist(w, m);
    if (handSize < 0.01) return false;
    const tipDist = dist(w, tip), ipDist = dist(w, ip);
    const thumbOut = dist(tip, im) > dist(ip, im) + handSize * 0.1;
    return tipDist > ipDist + handSize * 0.1 && thumbOut;
  }

  function classifyGestures(hands: any[] | undefined): string[] {
    if (!hands) return [];
    return hands.map((lm) => {
      if (lm.length < 21) return "unknown";
      const thumbExt = isThumbExtended(lm);
      const indexExt = isFingerExtended(lm, INDEX_TIP, INDEX_PIP, INDEX_MCP);
      const middleExt = isFingerExtended(lm, 12, MIDDLE_PIP, MIDDLE_MCP);
      const ringExt = isFingerExtended(lm, 16, 14, RING_MCP);
      const pinkyExt = isFingerExtended(lm, PINKY_TIP, 18, PINKY_MCP);
      const extCount = [thumbExt, indexExt, middleExt, ringExt, pinkyExt].filter(Boolean).length;
      if (extCount === 0) return "✊  Fist";
      if (indexExt && !middleExt && !ringExt && !pinkyExt && thumbExt) {
        const gap = dist(lm[4], lm[8]), sz = dist(lm[0], lm[5]);
        if (gap < sz * 0.25) return "🤏  Pinch"; return "👍  Thumbs up";
      }
      if (extCount === 5) return dist(lm[4], lm[20]) > dist(lm[5], lm[17]) * 0.7 ? "🖐️  Palm" : "✋  Flat";
      if (indexExt && middleExt && !ringExt && !pinkyExt) return "✌️  Peace";
      if (indexExt && !middleExt && !ringExt && pinkyExt) return "🤘  Rock";
      if (thumbExt && pinkyExt && !indexExt && !middleExt && !ringExt) return "🤙  Call me";
      if (indexExt && !middleExt && !ringExt && !pinkyExt) return "☝️  Point";
      if (indexExt && middleExt && ringExt && !pinkyExt) {
        const gap = dist(lm[4], lm[8]), sz = dist(lm[0], lm[5]);
        if (gap < sz * 0.25) return "👌  OK"; return "3 up";
      }
      if (thumbExt && indexExt) {
        const gap = dist(lm[4], lm[8]), sz = dist(lm[0], lm[5]);
        if (gap < sz * 0.22) return "🤏  Pinch";
      }
      if (!thumbExt && indexExt && middleExt && !ringExt && !pinkyExt) return "🦀  Claw";
      return `${extCount} up`;
    });
  }

  // ── Drawing ──

  function drawFrame() {
    if (!video) return;
    const ctx = canvas.getContext("2d")!;
    const w = canvas.width, h = canvas.height;
    ctx.save();
    ctx.scale(-1, 1);
    ctx.drawImage(video, -w, 0, w, h);
    ctx.restore();
    if (showOverlays) {
      drawFaceMesh(ctx, w, h);
      drawHandMesh(ctx, w, h);
    }
    drawFollowers(ctx, w, h);
    drawKnobs(ctx, w, h);
    drawHUD(ctx, w, h);
  }

  // ── Knobs ──

  function drawKnobs(ctx: CanvasRenderingContext2D, w: number, h: number) {
    for (const knob of knobs) {
      const { x, y } = knob;
      const s = KNOB_SIZE;
      const isActive = knob.active;

      // Background glow
      const glowR = isActive ? 55 : 40;
      const glow = ctx.createRadialGradient(x, y, 0, x, y, glowR);
      const isClear = knob.id === "clear";
      if (isActive) {
        glow.addColorStop(0, "rgba(0, 220, 255, 0.3)");
        glow.addColorStop(1, "rgba(0, 220, 255, 0)");
      } else if (knob.dwellCounter > 0 && isClear && perchedId !== null) {
        glow.addColorStop(0, "rgba(255, 80, 80, 0.2)");
        glow.addColorStop(1, "rgba(255, 80, 80, 0)");
      } else if (knob.dwellCounter > 0) {
        glow.addColorStop(0, "rgba(255, 200, 50, 0.18)");
        glow.addColorStop(1, "rgba(255, 200, 50, 0)");
      } else {
        glow.addColorStop(0, "rgba(255, 255, 255, 0.04)");
        glow.addColorStop(1, "rgba(255, 255, 255, 0)");
      }
      ctx.beginPath();
      ctx.arc(x, y, glowR, 0, Math.PI * 2);
      ctx.fillStyle = glow;
      ctx.fill();

      // Charge arc
      if (knob.dwellCounter > 0 && !isActive) {
        const pct = Math.min(knob.dwellCounter / DWELL_FRAMES, 1);
        ctx.beginPath();
        ctx.arc(x, y, s / 2 + 4, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * pct);
        ctx.strokeStyle = isClear && perchedId !== null ? "#ff5050" : "#ffc832";
        ctx.lineWidth = 3;
        ctx.lineCap = "round";
        ctx.stroke();
      }

      // Deactivation charge arc (purple when active, re-hovering to deactivate)
      if (isActive && knob.dwellCounter > 0) {
        const pct = Math.min(knob.dwellCounter / DWELL_FRAMES, 1);
        ctx.beginPath();
        ctx.arc(x, y, s / 2 + 4, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * pct);
        ctx.strokeStyle = "#ff6b6b";
        ctx.lineWidth = 3;
        ctx.lineCap = "round";
        ctx.stroke();
      }

      // Knob image
      if (knob.img && imagesLoaded) {
        ctx.save();
        const scale = isActive ? 1.08 : knob.dwellCounter > 0 ? 1 + 0.02 * Math.sin(performance.now() / 150) : 1;
        ctx.translate(x, y);
        ctx.scale(scale, scale);
        ctx.drawImage(knob.img, -s / 2, -s / 2, s, s);
        ctx.restore();
      } else if (knob.id === "clear") {
        // Clear knob — draw an X icon
        const cx = x, cy = y;
        // Outer ring
        ctx.beginPath();
        ctx.arc(cx, cy, 18, 0, Math.PI * 2);
        ctx.strokeStyle = perchedId !== null ? "rgba(255, 100, 100, 0.5)" : "rgba(255,255,255,0.15)";
        ctx.lineWidth = 2;
        ctx.stroke();
        // X mark
        const off = 8;
        ctx.strokeStyle = perchedId !== null ? "#ff6464" : "rgba(255,255,255,0.3)";
        ctx.lineWidth = 2.5;
        ctx.lineCap = "round";
        ctx.beginPath();
        ctx.moveTo(cx - off, cy - off);
        ctx.lineTo(cx + off, cy + off);
        ctx.moveTo(cx + off, cy - off);
        ctx.lineTo(cx - off, cy + off);
        ctx.stroke();
        // Label
        ctx.fillStyle = perchedId !== null ? "rgba(255, 100, 100, 0.4)" : "rgba(255,255,255,0.15)";
        ctx.font = "8px system-ui, sans-serif";
        ctx.textAlign = "center";
        ctx.textBaseline = "top";
        ctx.fillText("clear", cx, cy + 22);
      } else {
        ctx.beginPath();
        ctx.arc(x, y, 12, 0, Math.PI * 2);
        ctx.fillStyle = "rgba(255,255,255,0.25)";
        ctx.fill();
      }

      // Active pulsing ring
      if (isActive) {
        const pulse = 0.5 + 0.5 * Math.sin(performance.now() / 300);
        ctx.beginPath();
        ctx.arc(x, y, s / 2 + 6 + pulse * 8, 0, Math.PI * 2);
        ctx.strokeStyle = `rgba(0, 220, 255, ${0.2 * (1 - pulse)})`;
        ctx.lineWidth = 2;
        ctx.stroke();
      }
    }
  }

  // ── Followers ──

  function drawFollowers(ctx: CanvasRenderingContext2D, w: number, h: number) {
    if (!handLandmarkerInstance) return;

    // ── Face collision: if an active image touches the face, it becomes a permanent hat ──
    if (faceRect) {
      const margin = 10, half = 40;
      for (const knob of knobs) {
        if (!knob.active || knob.attachedHand === null || knob.attachedFinger === null) continue;
        const key = `${knob.attachedHand}_${knob.attachedFinger}`;
        const ft = followerTrails.find(t => t.key === key);
        if (!ft || ft.trail.length === 0) continue;
        const last = ft.trail[ft.trail.length - 1];
        const overlap = last.x - half - margin < faceRect.x + faceRect.w &&
                        last.x + half + margin > faceRect.x &&
                        last.y - half - margin < faceRect.y + faceRect.h &&
                        last.y + half + margin > faceRect.y;
        if (overlap) {
          // This image lands on the forehead permanently
          // If another was already perched, that one stays gone
          // Deactivate this knob — it no longer follows the finger
          perchedId = knob.id;
          knob.active = false;
          knob.attachedHand = null;
          knob.attachedFinger = null;
          knob.dwellCounter = 0;
          break; // only one per frame
        }
      }
    }

    // ── Draw permanently perched hat (detached from finger, sits on forehead) ──
    if (perchedId !== null && faceRect) {
      const knob = knobs.find(k => k.id === perchedId);
      if (knob && knob.img && imagesLoaded) {
        const faceW = faceRect.w;
        const s = Math.max(20, faceW * 0.8 * (hatScalePct / 100));
        const half = s / 2;
        const dx = faceHatX;
        const dy = faceHatY;

        // Glow (unrotated)
        const glowR = s;
        const g = ctx.createRadialGradient(dx, dy, 0, dx, dy, glowR);
        g.addColorStop(0, "rgba(0, 220, 255, 0.08)");
        g.addColorStop(1, "rgba(0, 220, 255, 0)");
        ctx.beginPath();
        ctx.arc(dx, dy, glowR, 0, Math.PI * 2);
        ctx.fillStyle = g;
        ctx.fill();

        // Bob offset (applied before rotation)
        const bob = Math.sin(performance.now() / 600) * Math.min(3, half * 0.05);

        // Perch shadow and hat image — rotate with face
        ctx.save();
        ctx.translate(dx, dy + bob);
        ctx.rotate(faceAngle);

        // Shadow/perch line (rotated with hat)
        ctx.beginPath();
        ctx.ellipse(0, half + 4, half * 0.6, 3, 0, 0, Math.PI * 2);
        ctx.fillStyle = "rgba(0, 0, 0, 0.15)";
        ctx.fill();

        // Image
        ctx.drawImage(knob.img, -s / 2, -s / 2, s, s);
        ctx.restore();

        // Sparkle (unrotated, stays above hat)
        const sparkle = 0.3 + 0.35 * (1 + Math.sin(performance.now() / 500));
        ctx.beginPath();
        ctx.arc(dx - half * 0.3, dy - half * 0.3, 3 * sparkle, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(255, 255, 255, ${0.4 * sparkle})`;
        ctx.fill();

        // Label (unrotated, stays readable)
        const fontSize = Math.max(8, Math.min(14, faceW * 0.04));
        ctx.fillStyle = "rgba(255,255,255,0.2)";
        ctx.font = `${fontSize}px system-ui, sans-serif`;
        ctx.textAlign = "center";
        ctx.textBaseline = "top";
        ctx.fillText("perched ✦", dx, dy + half + 8);
      }
    }

    // ── Draw finger-following images ──
    for (const knob of knobs) {
      if (!knob.active || knob.attachedHand === null || knob.attachedFinger === null) continue;

      const key = `${knob.attachedHand}_${knob.attachedFinger}`;
      const ft = followerTrails.find(t => t.key === key);
      if (!ft || ft.trail.length === 0) continue;

      const last = ft.trail[ft.trail.length - 1];
      const fx = last.x, fy = last.y;
      const s = 80;
      const half = s / 2;

      // Trail dots
      for (let i = 0; i < ft.trail.length; i++) {
        const t = ft.trail[i];
        if (t.life <= 0) continue;
        ctx.beginPath();
        ctx.arc(t.x, t.y, 2 + t.life * 2, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(0, 220, 255, ${t.life * 0.25})`;
        ctx.fill();
      }

      // Glow
      const g = ctx.createRadialGradient(fx, fy, 0, fx, fy, s);
      g.addColorStop(0, "rgba(0, 220, 255, 0.1)");
      g.addColorStop(1, "rgba(0, 220, 255, 0)");
      ctx.beginPath();
      ctx.arc(fx, fy, s, 0, Math.PI * 2);
      ctx.fillStyle = g;
      ctx.fill();

      // Image
      if (knob.img && imagesLoaded) {
        ctx.save();
        const bob = Math.sin(performance.now() / 400 + (knob.attachedHand * 2 + knob.attachedFinger)) * 3;
        ctx.translate(fx, fy + bob);
        ctx.drawImage(knob.img, -s / 2, -s / 2, s, s);
        ctx.restore();
      }
    }
  }

  function drawFaceMesh(ctx: CanvasRenderingContext2D, w: number, h: number) {
    if (!smoothedFace) return;
    const lm = smoothedFace;
    const grad = ctx.createLinearGradient(0, 0, 0, h);
    grad.addColorStop(0, "rgba(255, 180, 100, 0.4)");
    grad.addColorStop(0.5, "rgba(255, 140, 60, 0.35)");
    grad.addColorStop(1, "rgba(255, 180, 100, 0.4)");
    ctx.strokeStyle = grad; ctx.lineWidth = 1.2;
    for (const contour of FACE_CONTOURS) {
      ctx.beginPath();
      for (let i = 0; i < contour.length; i++) {
        const p = lm[contour[i]];
        if (!p) continue;
        const x = w - p.x * w, y = p.y * h;
        if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      }
      ctx.stroke();
    }
    for (const eyeIdx of [468, 473]) {
      const p = lm[eyeIdx]; if (!p) continue;
      ctx.beginPath(); ctx.arc(w - p.x * w, p.y * h, 3, 0, Math.PI * 2);
      ctx.fillStyle = "#ffd93d"; ctx.fill();
    }
    const nose = lm[1]; if (nose) {
      ctx.beginPath(); ctx.arc(w - nose.x * w, nose.y * h, 4, 0, Math.PI * 2);
      ctx.fillStyle = "#f97316"; ctx.fill();
    }

    // Forehead zone: eye line to forehead top (rotated rectangle)
    const le2 = lm[33], re2 = lm[263];
    if (le2 && re2 && faceRect) {
      const lx = w - le2.x * w, ly = le2.y * h;
      const rx = w - re2.x * w, ry = re2.y * h;
      const mx = (lx + rx) / 2, my = (ly + ry) / 2;
      // Rectangle height = ~40% of face height (from eye line up to forehead)
      const zoneH = faceRect.h * 0.55;
      // Compute upward direction perpendicular to the eye line
      const edx = rx - lx, edy = ry - ly;
      const eLen = Math.hypot(edx, edy) || 1;
      // Upward vector (perpendicular to eye line)
      const ux = -edy / eLen * zoneH;
      const uy = edx / eLen * zoneH;

      ctx.save();
      ctx.strokeStyle = "rgba(0, 220, 255, 0.35)";
      ctx.lineWidth = 1.5;
      ctx.setLineDash([4, 5]);

      // Bottom edge (eye line)
      ctx.beginPath(); ctx.moveTo(lx, ly); ctx.lineTo(rx, ry); ctx.stroke();
      // Top edge (shifted up)
      ctx.beginPath(); ctx.moveTo(lx + ux, ly + uy); ctx.lineTo(rx + ux, ry + uy); ctx.stroke();
      // Left edge
      ctx.beginPath(); ctx.moveTo(lx, ly); ctx.lineTo(lx + ux, ly + uy); ctx.stroke();
      // Right edge
      ctx.beginPath(); ctx.moveTo(rx, ry); ctx.lineTo(rx + ux, ry + uy); ctx.stroke();

      ctx.setLineDash([]);
      ctx.restore();

      // Corner dots
      const corners = [[lx, ly], [rx, ry], [lx + ux, ly + uy], [rx + ux, ry + uy]];
      for (const [cx, cy] of corners) {
        ctx.beginPath();
        ctx.arc(cx, cy, 2.5, 0, Math.PI * 2);
        ctx.fillStyle = "rgba(0, 220, 255, 0.5)";
        ctx.fill();
      }

      // Midpoint dot (hat anchor)
      ctx.beginPath();
      ctx.arc(mx + ux / 2, my + uy / 2, 3, 0, Math.PI * 2);
      ctx.fillStyle = "rgba(255, 255, 100, 0.5)";
      ctx.fill();
    }
  }

  function drawHandMesh(ctx: CanvasRenderingContext2D, w: number, h: number) {
    if (!smoothedHands) return;
    for (let hi = 0; hi < smoothedHands.length; hi++) {
      const lm = smoothedHands[hi];
      const color = hi === 0 ? "0, 200, 255" : "255, 180, 100";
      ctx.strokeStyle = `rgba(${color}, 0.6)`; ctx.lineWidth = 2;
      for (const [a, b] of HAND_CONNECTIONS) {
        const pa = lm[a], pb = lm[b];
        if (!pa || !pb) continue;
        ctx.beginPath(); ctx.moveTo(w - pa.x * w, pa.y * h); ctx.lineTo(w - pb.x * w, pb.y * h); ctx.stroke();
      }
      for (const tipIdx of [4, 8, 12, 16, 20]) {
        const p = lm[tipIdx]; if (!p) continue;
        const tx = w - p.x * w, ty = p.y * h;
        const grad = ctx.createRadialGradient(tx, ty, 0, tx, ty, 20);
        grad.addColorStop(0, `rgba(${color}, 0.25)`); grad.addColorStop(1, `rgba(${color}, 0)`);
        ctx.beginPath(); ctx.arc(tx, ty, 20, 0, Math.PI * 2); ctx.fillStyle = grad; ctx.fill();
      }
      for (const pt of lm) {
        if (!pt) continue;
        ctx.beginPath(); ctx.arc(w - pt.x * w, pt.y * h, 2.5, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(${color}, 0.9)`; ctx.fill();
      }
      const wrist = lm[WRIST]; if (wrist) {
        const wx = w - wrist.x * w, wy = wrist.y * h;
        const grad = ctx.createRadialGradient(wx, wy, 0, wx, wy, 50);
        grad.addColorStop(0, `rgba(${color}, 0.15)`); grad.addColorStop(1, `rgba(${color}, 0)`);
        ctx.beginPath(); ctx.arc(wx, wy, 50, 0, Math.PI * 2); ctx.fillStyle = grad; ctx.fill();
      }
    }
  }

  // ── HUD (top-left) ──

  function drawHUD(ctx: CanvasRenderingContext2D, w: number, h: number) {
    const pad = 12;
    const gap = 4;
    const cardW = 170, cardH = 22;
    let y = pad;

    drawCard(ctx, pad, y, cardW, cardH, `v2.1.0`, "#666"); y += cardH + gap;
    drawCard(ctx, pad, y, cardW, cardH, `${fps} fps`, "#888"); y += cardH + gap;

    const activeCount = knobs.filter(k => k.active).length;
    const knobStatus = activeCount > 0 ? `${activeCount} active` : "knobs idle";
    drawCard(ctx, pad, y, cardW, cardH, knobStatus, activeCount > 0 ? "#00dcff" : "#555"); y += cardH + gap;

    // Hat status
    const hatIcon = perchedId !== null ? "🎩" : "○";
    const hatLabel = perchedId !== null ? `${perchedId} perched` : "no hat";
    drawCard(ctx, pad, y, cardW, cardH, `${hatIcon}  ${hatLabel}`, perchedId !== null ? "#a78bfa" : "#555");
    y += cardH + gap;

    // Knob quick status per knob
    for (const knob of knobs) {
      let icon = "⚪";
      let color = "#555";
      if (knob.id === "clear") {
        if (knob.dwellCounter > 0 && perchedId !== null) { icon = "🔴"; color = "#ff5050"; }
        else if (perchedId !== null) { icon = "❌"; color = "#ff6464"; }
        else { icon = "✖️"; color = "#444"; }
      } else if (knob.active) { icon = "🔵"; color = "#00dcff"; }
      else if (knob.dwellCounter > 0) { const pct = Math.round(Math.min(knob.dwellCounter / DWELL_FRAMES, 1) * 100); icon = "🟡"; color = "#ffc832"; }
      drawCard(ctx, pad, y, cardW, cardH, `${icon}  ${knob.id}`, color);
      y += cardH + gap;
    }

    // Face + hands
    const dotFace = faceCount > 0 ? "🟡" : "⚫";
    drawCard(ctx, pad, y, cardW, cardH, `${dotFace} face:${faceCount}`, faceCount > 0 ? "#fbbf24" : "#555"); y += cardH + gap;
    if (handCount > 0) {
      for (let i = 0; i < handCount; i++) {
        const icon = handedness[i] === "Right" ? "👉" : "👈";
        drawCard(ctx, pad, y, cardW, cardH, `${icon} ${handedness[i] ?? "?"}`, "#8b8fa3");
        y += cardH + gap;
      }
    } else {
      drawCard(ctx, pad, y, cardW, cardH, "⚫ no hands", "#555"); y += cardH + gap;
    }

    // Status bar at bottom center
    const barH = 28;
    const fpsText = `${fps} fps`;
    const statusText = activeCount > 0 ? "●  following" : "●  hover knob 1s to attach";
    ctx.font = "12px monospace";
    const sw = ctx.measureText(statusText).width;
    const barW = sw + pad * 4;
    const bx = (w - barW) / 2, by = h - 44;
    ctx.save();
    ctx.shadowColor = "rgba(0,0,0,0.5)"; ctx.shadowBlur = 12;
    ctx.fillStyle = activeCount > 0 ? "rgba(0, 20, 40, 0.75)" : "rgba(0, 0, 0, 0.55)";
    ctx.beginPath(); ctx.roundRect(bx, by, barW, barH, 14); ctx.fill();
    ctx.shadowBlur = 0;
    ctx.fillStyle = activeCount > 0 ? "#00dcff" : "#888";
    ctx.textBaseline = "middle"; ctx.textAlign = "left";
    ctx.fillText(statusText, bx + pad, by + barH / 2);
    ctx.restore();
  }

  function drawCard(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, text: string, color: string) {
    ctx.save();
    ctx.shadowColor = "rgba(0,0,0,0.4)"; ctx.shadowBlur = 10;
    ctx.fillStyle = "rgba(0, 0, 0, 0.5)";
    ctx.beginPath(); ctx.roundRect(x, y, w, h, 8); ctx.fill();
    ctx.shadowBlur = 0;
    ctx.fillStyle = color;
    ctx.font = "12px system-ui, -apple-system, sans-serif";
    ctx.textBaseline = "middle"; ctx.textAlign = "left";
    ctx.fillText(text, x + 8, y + h / 2);
    ctx.restore();
  }
</script>

<div class="gesture2-page">
  <div class="gesture2-container" bind:this={canvasWrapper}>
    <canvas
      bind:this={canvas}
      class="gesture2-canvas"
      style="width: {canvasWidth}px; height: {canvasHeight}px;"
    ></canvas>
    {#if error}
      <div class="overlay error">
        <div class="overlay-icon">⚠️</div>
        <div class="overlay-text">{error}</div>
      </div>
    {/if}
  </div>
  <div class="gesture2-controls">
    <label class="slider-label">
      <span>Hat Y</span>
      <input type="range" bind:value={hatYOffset} min="-100" max="100" class="slider" />
      <span class="slider-val">{hatYOffset}px</span>
    </label>
    <label class="slider-label">
      <span>Scale</span>
      <input type="range" bind:value={hatScalePct} min="30" max="200" class="slider" />
      <span class="slider-val">{hatScalePct}%</span>
    </label>
    <button class="toggle-btn" class:active={showOverlays} onclick={() => showOverlays = !showOverlays}>
      {showOverlays ? "Hide" : "Show"} overlays
    </button>
  </div>
  <div class="gesture2-footer">
    <span class="footer-label">Gesture 2 — Face + Hand Detection</span>
  </div>
</div>

<style>
  .gesture2-page {
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
  .gesture2-container {
    position: relative;
    background: #000;
    border-radius: 16px;
    overflow: hidden;
    box-shadow: 0 0 60px rgba(0,0,0,0.8), 0 0 120px rgba(100,100,200,0.06);
    flex-shrink: 0;
    max-width: 100%;
    max-height: calc(100vh - 100px);
    display: flex;
    align-items: center;
    justify-content: center;
  }
  .gesture2-canvas {
    display: block;
    max-width: 100%;
    max-height: calc(100vh - 100px);
    object-fit: contain;
    border-radius: 16px;
  }
  .gesture2-controls {
    display: flex;
    gap: 24px;
    align-items: center;
  }
  .slider-label {
    display: flex;
    align-items: center;
    gap: 8px;
    color: #888;
    font-size: 0.75rem;
    font-family: monospace;
  }
  .slider {
    width: 120px;
    height: 4px;
    -webkit-appearance: none;
    appearance: none;
    background: #2a2d37;
    border-radius: 2px;
    outline: none;
    cursor: pointer;
  }
  .slider::-webkit-slider-thumb {
    -webkit-appearance: none;
    appearance: none;
    width: 14px;
    height: 14px;
    border-radius: 50%;
    background: #00dcff;
    cursor: pointer;
    border: none;
  }
  .slider-val {
    color: #00dcff;
    min-width: 40px;
    text-align: right;
  }
  .toggle-btn {
    background: #1a1d27;
    border: 1px solid #2a2d37;
    color: #8b8fa3;
    font-family: monospace;
    font-size: 0.7rem;
    padding: 6px 14px;
    border-radius: 8px;
    cursor: pointer;
    transition: background 0.15s, color 0.15s, border-color 0.15s;
  }
  .toggle-btn:hover {
    background: #2a2d37;
    color: #e1e4ea;
  }
  .toggle-btn.active {
    background: rgba(0, 220, 255, 0.1);
    border-color: #00dcff;
    color: #00dcff;
  }
  .gesture2-footer {
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
    background: rgba(0,0,0,0.85);
    border-radius: 16px;
  }
  .overlay.error .overlay-icon { font-size: 3rem; margin-bottom: 1rem; }
  .overlay-text { color: #f87171; font-size: 1.2rem; }
</style>
