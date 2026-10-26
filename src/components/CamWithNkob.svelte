<script lang="ts">
  import { onMount, onDestroy } from "svelte";
  import QRCode from "qrcode";
  import CamWithMe from "./CamWithMe.svelte";

  let { src }: { src: string } = $props();
  let faceDetected = $state(false);
  let faceOnRight = $state(false);
  // livecam nkob cycles to the next image each time he switches sides; add more here
  const NKOB_POSES = ["/img/demo/camwithnkob/pose1.png", "/img/demo/camwithnkob/pose2.png"];
  let poseIdx = $state(0);
  const COVER_IMG = {
    idle: "/img/demo/camwithnkob/sleep1.png",
    waking: "/img/demo/camwithnkob/wakeup.png",
    greet: "/img/demo/camwithnkob/greet.png",
  };
  let camCanvas: HTMLCanvasElement | null = null;
  let nkobEl: HTMLImageElement;
  let previewCanvas: HTMLCanvasElement;

  // nkob slides in from the side opposite the face once the cam is revealed, and back out the same way
  let nkobIn = $derived(
    (stage === "reveal" || stage === "countdown" || stage === "snapped") && (faceDetected || mode === "debug")
  );
  // pose is for the face-on-left case (nkob on the right); mirrored when the face is on the right
  type Pose = { x: number; y: number; r: number; s: number };
  let pose = $state<Pose>({ x: 100, y: 40, r: -15, s: 4 });
  let savedPoses = $state<Pose[]>([]);
  const rand = (min: number, max: number) => Math.round(min + Math.random() * (max - min));
  let faceW = $state(0.3); // latest face box width as a fraction of the frame
  let distance = $derived(faceW >= 0.3 ? "near" : faceW < 0.25 ? "far" : "mid");
  const SCALE_RANGE = { far: [1.5, 2.5], mid: [2.5, 3.5], near: [3.5, 4.5] };
  const rerollPose = () => {
    // pick a scale range by how close the user is (face box width / frame width)
    const [lo, hi] = SCALE_RANGE[distance];
    pose.s = rand(lo * 10, hi * 10) / 10;
    pose.r = -rand(15, 45); // negative keeps the original tilt direction
    pose.y = 40;
  };
  const nextPose = () => {
    poseIdx = (poseIdx + 1) % NKOB_POSES.length;
    rerollPose();
  };
  let lastZoneChange = 0;
  function onFaceSize(w: number) {
    const before = distance;
    faceW = w;
    // near/mid/far change = new pose + scale; cooldown stops jitter at a cutoff from spamming it
    if (distance !== before && performance.now() - lastZoneChange > 1000) {
      lastZoneChange = performance.now();
      nextPose();
    }
  }
  let side = $derived(faceOnRight ? -1 : 1);
  let translateX = $derived(side * (nkobIn ? pose.x : 500));
  let rotate = $derived(side * pose.r);

  let flashOpacity = $state(0);
  let flashTransitioning = $state(false);
  let capturedSrc = $state<string | null>(null);
  let capturedPhase = $state<"hidden" | "shown" | "exiting">("hidden");
  let capturedInstant = $state(false);
  let capturedExitTimer: any = null;
  let savedPhotoId = $state<string | null>(null);
  let qrSrc = $state<string | null>(null);

  $effect(() => {
    if (!savedPhotoId) return;
    QRCode.toDataURL(`${location.origin}/photo?id=${savedPhotoId}`, { margin: 1, width: 400 }).then(
      (url) => (qrSrc = url)
    );
  });


  // Kiosk flow: idle -> waking -> greet -> reveal -> countdown -> snapped -> waking (idle if the face left)
  const STAGES = ["idle", "waking", "greet", "reveal", "countdown", "snapped"] as const;
  type Stage = (typeof STAGES)[number];
  let stage = $state<Stage>("idle");
  let mode = $state<"actual" | "debug">("debug");
  let count = $state(5);
  let sidebarOpen = $state(true);
  let isFullscreen = $state(false);
  let mouseIdle = $state(false);
  let uiHidden = $derived(mouseIdle && isFullscreen); // auto-hide only while fullscreen
  let mouseTimer: any;
  $effect(() => {
    document.documentElement.style.cursor = uiHidden ? "none" : "";
    return () => (document.documentElement.style.cursor = "");
  });
  function onMouseMove() {
    mouseIdle = false;
    clearTimeout(mouseTimer);
    mouseTimer = setTimeout(() => (mouseIdle = true), 2000);
  }
  let countdownY = $state(15); // vh from the top
  onMount(() => {
    onMouseMove(); // start the 2s hide timer even if the mouse never moves
    countdownY = Number(localStorage.getItem("nkob-countdown-y") ?? countdownY);
    savedPoses = JSON.parse(localStorage.getItem("nkob-poses") ?? "[]");
  });
  $effect(() => {
    localStorage.setItem("nkob-poses", JSON.stringify(savedPoses));
  });
  $effect(() => {
    localStorage.setItem("nkob-countdown-y", String(countdownY));
  });
  let stageTimer: any = null;
  let countTimer: any = null;

  function setStage(next: Stage) {
    clearTimeout(stageTimer);
    clearInterval(countTimer);
    if (next !== "snapped") {
      fadeFlash();
      if (capturedPhase === "shown") capturedPhase = "exiting"; // lets the polaroid leave when you jump away in debug
    }
    stage = next;
    if (next === "snapped") triggerFlash();
    if (next === "reveal") rerollPose();
    if (mode === "debug") return; // debug: stages only change by clicking
    if (next === "waking") {
      stageTimer = setTimeout(() => setStage("greet"), 2000);
    } else if (next === "greet") {
      stageTimer = setTimeout(() => setStage("reveal"), 2000);
    } else if (next === "reveal") {
      stageTimer = setTimeout(() => setStage("countdown"), 3000); // 1s overlay slide + 2s pause
    } else if (next === "countdown") {
      count = 5;
      countTimer = setInterval(() => {
        if (--count <= 0) setStage("snapped");
      }, 1000);
    } else if (next === "snapped") {
      stageTimer = setTimeout(() => setStage("waking"), 14000); // 11s hold + 3s slide-out, then fade into waking
    }
  }

  function setMode(m: typeof mode) {
    mode = m; // set before setStage below so its timers see the new mode
    if (m === "debug") {
      clearTimeout(stageTimer);
      clearInterval(countTimer);
      clearTimeout(capturedExitTimer);
    } else {
      setStage("idle"); // debug leaves no timers running; restart the flow cleanly (clears flash/polaroid too)
    }
  }

  // face lost while waking -> back to idle (debug mode lets you sit on the stage)
  $effect(() => {
    if (mode !== "debug" && (stage === "waking" || stage === "greet") && !faceDetected) setStage("idle");
  });

  // face held in frame for 1s while idle -> wake up
  $effect(() => {
    if (mode === "debug" || stage !== "idle" || !faceDetected) return;
    const t = setTimeout(() => setStage("waking"), 1000);
    return () => clearTimeout(t);
  });

  onDestroy(() => {
    if (capturedExitTimer) clearTimeout(capturedExitTimer);
    clearTimeout(stageTimer);
    clearInterval(countTimer);
    clearTimeout(mouseTimer);
  });

  // Canvas #2: composite (cam feed + nkob) drawn once per snap. Not per frame:
  // measuring nkob below forces layout and resets its CSS transition.
  function drawPreview() {
    if (!camCanvas || !previewCanvas || !nkobEl) return;
    const ctx = previewCanvas.getContext("2d");
    if (!ctx) return;

    if (previewCanvas.width !== camCanvas.width || previewCanvas.height !== camCanvas.height) {
      previewCanvas.width = camCanvas.width;
      previewCanvas.height = camCanvas.height;
    }

    ctx.drawImage(camCanvas, 0, 0);

    const camRect = camCanvas.getBoundingClientRect();
    if (!camRect.width || !camRect.height) return;
    // camCanvas renders with object-fit:cover, so its on-screen box and its
    // internal buffer can have different aspect ratios — map between them with
    // a single uniform "cover" scale, not independent X/Y factors (that stretched nkob)
    const coverScale = Math.max(
      previewCanvas.width / camRect.width,
      previewCanvas.height / camRect.height
    );
    const offsetX = (previewCanvas.width - camRect.width * coverScale) / 2;
    const offsetY = (previewCanvas.height - camRect.height * coverScale) / 2;

    // measure nkob's unrotated box this frame by zeroing rotation for one synchronous read
    const prevTransition = nkobEl.style.transition;
    const liveTransform = nkobEl.style.transform;
    nkobEl.style.transition = "none";
    nkobEl.style.transform = liveTransform.replace(/rotate\([^)]*\)/, "rotate(0deg)");
    const rect = nkobEl.getBoundingClientRect();
    nkobEl.style.transform = liveTransform;
    void nkobEl.offsetWidth; // force reflow before restoring the transition
    nkobEl.style.transition = prevTransition;

    const cx = (rect.left + rect.width / 2 - camRect.left) * coverScale + offsetX;
    const cy = (rect.top + rect.height / 2 - camRect.top) * coverScale + offsetY;
    const dw = rect.width * coverScale;
    const dh = rect.height * coverScale;

    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate((rotate * Math.PI) / 180);
    ctx.drawImage(nkobEl, -dw / 2, -dh / 2, dw, dh);
    ctx.restore();
  }

  // flash stays white as the backdrop for the polaroid; fadeFlash() clears it when the stage moves on
  function triggerFlash() {
    captureNow();
    flashTransitioning = false;
    flashOpacity = 1;
  }

  function fadeFlash() {
    flashTransitioning = true;
    flashOpacity = 0;
  }

  function captureNow() {
    if (!previewCanvas) return;
    drawPreview();
    capturedSrc = buildFramedCapture();

    if (capturedExitTimer) clearTimeout(capturedExitTimer);
    // snap instantly back to the above-top-right origin (no transition) in case
    // it's mid-exit from a previous capture, then let the next frame animate in
    capturedInstant = true;
    capturedPhase = "hidden";
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        capturedInstant = false;
        capturedPhase = "shown";
        // 3s slide-in + 8s hold, then slide out
        if (mode !== "debug") capturedExitTimer = setTimeout(() => {
          capturedPhase = "exiting";
        }, 11000);
      });
    });

    qrSrc = null;
    saveCapture(capturedSrc);
  }

  // Bakes the white polaroid border + "Hello World" caption into a fixed
  // 1080x1080 PNG; the feed is cover-cropped into the photo window.
  function buildFramedCapture(): string {
    const w = 1080;
    const h = 1080;
    const border = 40;
    const bottom = 160;
    const pw = w - border * 2;
    const ph = h - border - bottom;

    const out = document.createElement("canvas");
    out.width = w;
    out.height = h;
    const ctx = out.getContext("2d")!;
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, w, h);

    const s = Math.max(pw / previewCanvas.width, ph / previewCanvas.height);
    const sw = pw / s;
    const sh = ph / s;
    ctx.drawImage(
      previewCanvas,
      (previewCanvas.width - sw) / 2, (previewCanvas.height - sh) / 2, sw, sh,
      border, border, pw, ph
    );

    ctx.fillStyle = "#333";
    ctx.font = "600 56px system-ui, -apple-system, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText("Hello World", w / 2, h - bottom / 2);

    return out.toDataURL("image/png");
  }

  async function saveCapture(image: string) {
    savedPhotoId = null;
    const res = await fetch("/api/save-capture", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ image }),
    });
    if (!res.ok) return;
    const { id } = await res.json();
    savedPhotoId = id;
  }
</script>

<div class="bg"></div>
<div class="livecam">
  <CamWithMe
    debug={false}
    aspect={1}
    onFaceCount={(count) => (faceDetected = count > 0)}
    onFacePosition={(x) => (faceOnRight = x > 0.5)}
    {onFaceSize}
    onReady={(canvas) => (camCanvas = canvas)}
  />
  <div class="slot">
    <img
      bind:this={nkobEl}
      src={NKOB_POSES[poseIdx]}
      alt="Nkob"
      style="transform: translateX({translateX}%) translateY({pose.y}%) rotate({rotate}deg) scale({pose.s});"
    />
  </div>
</div>

<div class="cover" class:out={stage !== "idle" && stage !== "waking" && stage !== "greet"}>
  <img
    class="cover-nkob"
    src={COVER_IMG[stage as "idle" | "waking" | "greet"] ?? COVER_IMG.idle}
    alt="Nkob"
  />
  <div class="cover-text">{stage === "greet" ? "hello!" : stage === "waking" ? "waking up..." : "idling..."}</div>
</div>

{#if stage === "countdown"}
  {#key count}
    <div class="countdown" style:top="{countdownY}vh">{count}</div>
  {/key}
{/if}

<svelte:window onmousemove={onMouseMove} />
<svelte:document onfullscreenchange={() => (isFullscreen = !!document.fullscreenElement)} />

<button class="sidebar-toggle" class:hidden={uiHidden} style:left={sidebarOpen ? "188px" : "8px"} onclick={() => (sidebarOpen = !sidebarOpen)}>
  {sidebarOpen ? "◀" : "▶"}
</button>

<aside class="debug" class:hidden={!sidebarOpen || uiHidden}>
  <h4>Debug</h4>
  <div class="row">
    {#each ["actual", "debug"] as m}
      <button class:active={mode === m} onclick={() => setMode(m as typeof mode)}>{m}</button>
    {/each}
  </div>
  <small>{mode === "actual" ? "5s countdown, then snap" : "all timers stopped, click stages manually"}</small>
  <h4>Nkob pose</h4>
  {#each [["x", -300, 300, 1], ["y", -300, 300, 1], ["r", -180, 180, 1], ["s", 0.5, 10, 0.1]] as [k, min, max, step]}
    <label class="slider">
      <span>{k} {pose[k as keyof Pose]}</span>
      <input type="range" {min} {max} {step} bind:value={pose[k as keyof Pose]} />
    </label>
  {/each}
  <button onclick={() => (savedPoses = [...savedPoses, { ...pose }])}>Save pose</button>
  {#each savedPoses as p, i}
    <div class="row">
      <button onclick={() => (pose = { ...pose, ...p })}>{p.x}, {p.y}, {p.r}°, ×{p.s ?? 4}</button>
      <button class="x" onclick={() => (savedPoses = savedPoses.filter((_, j) => j !== i))}>×</button>
    </div>
  {/each}
  <h4>Face</h4>
  <small>{faceDetected ? `${faceW.toFixed(2)} · ${distance}` : "no face"}</small>
  <h4>Countdown</h4>
  <label class="slider">
    <span>y {countdownY}vh</span>
    <input type="range" min="0" max="90" step="1" bind:value={countdownY} />
  </label>
  <h4>Stage</h4>
  {#each STAGES as s}
    <button class:active={stage === s} onclick={() => setStage(s)}>{s}</button>
  {/each}
  <button onclick={() => (document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen())}>⛶ Fullscreen</button>
  <button class="snap" onclick={() => setStage("snapped")}>📷 Snap + preview</button>
  {#if savedPhotoId}
    <a href={`/photo?id=${savedPhotoId}`} target="_blank">View saved photo</a>
  {/if}
</aside>

<div class="preview-frame">
  <canvas bind:this={previewCanvas} class="preview"></canvas>
  <div class="preview-caption">Hello World</div>
</div>

{#if capturedSrc}
  <div
    class="captured"
    class:show={capturedPhase === "shown"}
    class:exiting={capturedPhase === "exiting"}
    class:instant={capturedInstant}
  >
    <img src={capturedSrc} alt="Captured" />
  </div>
{/if}

{#if qrSrc}
  <div class="qr" class:show={capturedPhase === "shown"} class:exiting={capturedPhase === "exiting"}>
    <img src={qrSrc} alt="Scan to get your photo" />
    <div>Scan to get your photo</div>
  </div>
{/if}

<div
  class="flash"
  style="opacity: {flashOpacity}; transition: {flashTransitioning ? 'opacity 2s ease' : 'none'};"
></div>

<div class="bg bg-snap" class:show={stage === "snapped"}></div>

<div class="frame"></div>

<style>
  /* z-index layers: 10 bg, 20 livecam, 30 cover (idle/waking), 40 countdown, 50 flash, 55 bg (after snap), 60 captured+qr, 70 frame, 101 debug, 110 sidebar toggle */
  .bg,
  .frame {
    position: fixed;
    inset: 0;
    background: center / cover no-repeat;
    pointer-events: none;
  }
  .bg {
    z-index: 10;
    background-image: url("/img/demo/camwithnkob/bg.png");
  }
  .bg-snap {
    z-index: 55; /* fades in over the white flash after a snap */
    opacity: 0;
    transition: opacity 2s ease; /* out: matches the flash fade */
  }
  .bg-snap.show {
    opacity: 1;
    transition-duration: 1s;
  }
  .frame {
    z-index: 70;
    background-position: top; /* always align top; cover crops the bottom */
    background-image: url("/img/demo/camwithnkob/frame.png");
  }
  .livecam {
    position: fixed;
    inset: 0;
    z-index: 20;
    transform: scale(0.8); /* cam + nkob slot shrink together */
  }
  .livecam :global(.cam-container) {
    background: transparent; /* let bg show around the cam square */
  }
  .slot {
    position: fixed;
    top: 50%;
    left: 50%;
    width: min(calc(100vw - 40px), calc(100vh - 40px)); /* matches the cam's 20px padding */
    aspect-ratio: 1;
    transform: translate(-50%, -50%);
    z-index: 21; /* nkob mascot rides on the livecam layer */
    display: flex;
    align-items: center;
    justify-content: center;
    pointer-events: none;
    overflow: hidden;
  }
  img {
    max-width: 50%;
    max-height: 50%;
    transition: transform 500ms ease-in-out;
  }
  .cover {
    position: fixed;
    inset: 0;
    z-index: 30;
    background: #000 url("/img/demo/camwithnkob/bg.png") center / cover no-repeat;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 24px;
    transition: opacity 1s ease; /* coming back: fade in */
  }
  .cover.out {
    transform: translateY(-100%);
    opacity: 0; /* only after the slide-out finishes */
    transition: transform 1s ease, opacity 0s 1s;
  }
  .cover-nkob {
    max-width: 40%;
    max-height: 40%;
    transition: none;
  }
  .cover-text {
    font: 600 28px system-ui, -apple-system, sans-serif;
    color: #aaa;
  }
  .countdown {
    position: fixed;
    top: 4vh;
    left: 50%;
    transform: translateX(-50%);
    z-index: 40;
    width: 16vmin;
    aspect-ratio: 1;
    border-radius: 50%;
    background: #dd257e;
    display: flex;
    align-items: center;
    justify-content: center;
    font: 700 9vmin system-ui, -apple-system, sans-serif;
    color: #fff;
    pointer-events: none;
    animation: tick 600ms linear forwards; /* 100 fade in, 200 hold, 300 fade out + slide up */
  }
  @keyframes tick {
    0% { opacity: 0; transform: translateX(-50%) translateY(0); }
    16.7%, 50% { opacity: 1; transform: translateX(-50%) translateY(0); }
    100% { opacity: 0; transform: translateX(-50%) translateY(-5vh); }
  }
  .debug {
    position: fixed;
    top: 0;
    left: 0;
    bottom: 0;
    width: 180px;
    z-index: 101;
    padding: 12px;
    display: flex;
    flex-direction: column;
    gap: 6px;
    background: rgba(15, 17, 23, 0.85);
    color: #e1e4ea;
    font: 13px system-ui, -apple-system, sans-serif;
    overflow-y: auto;
  }
  .debug.hidden {
    display: none;
  }
  .sidebar-toggle.hidden {
    display: none;
  }
  .sidebar-toggle {
    position: fixed;
    top: 8px;
    z-index: 110;
    width: 32px;
    height: 32px;
    border: 1px solid #333;
    border-radius: 6px;
    background: rgba(15, 17, 23, 0.85);
    color: #e1e4ea;
    cursor: pointer;
  }
  .debug h4 {
    margin: 10px 0 2px;
    font-size: 11px;
    text-transform: uppercase;
    color: #8b8fa3;
  }
  .debug .row {
    display: flex;
    gap: 6px;
  }
  .debug .row button {
    flex: 1;
  }
  .debug .row button.x {
    flex: 0 0 34px;
  }
  .debug .slider {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .debug button {
    font: 600 13px system-ui, -apple-system, sans-serif;
    padding: 8px 10px;
    border-radius: 6px;
    border: 1px solid #333;
    background: #1c1f2a;
    color: #e1e4ea;
    cursor: pointer;
  }
  .debug button.snap {
    margin-top: 10px;
    background: #e1306c;
    border-color: #e1306c;
    color: #fff;
  }
  .debug button.active {
    background: #a78bfa;
    color: #0f1117;
    border-color: #a78bfa;
  }
  .debug a {
    color: #a78bfa;
  }
  .preview-frame {
    display: none;
  }
  .preview {
    display: block;
    width: 100%;
    height: auto;
  }
  .preview-caption {
    position: absolute;
    bottom: 0;
    left: 0;
    right: 0;
    height: 128px;
    display: flex;
    align-items: center;
    justify-content: center;
    font: 600 16px system-ui, -apple-system, sans-serif;
    color: #333;
  }
  .flash {
    position: fixed;
    inset: 0;
    z-index: 50;
    background: #fff;
    pointer-events: none;
  }
  .captured {
    position: fixed;
    top: 50%;
    left: 50%;
    z-index: 60;
    width: 35vw;
    border-radius: 6px;
    overflow: hidden;
    box-shadow: 0 10px 30px rgba(0, 0, 0, 0.4);
    transform: translate(-50%, -150vh);
    transition: transform 3s ease;
    pointer-events: none;
  }
  .captured.show {
    transform: translate(-50%, -50%);
  }
  .captured.exiting {
    transform: translate(calc(-50% + 160vw), -50%);
  }
  .captured.instant {
    transition: none;
  }
  .qr {
    position: fixed;
    bottom: 4vh;
    left: 50%;
    z-index: 60;
    padding: 16px;
    border-radius: 12px;
    background: #fff;
    box-shadow: 0 10px 30px rgba(0, 0, 0, 0.3);
    text-align: center;
    font: 600 16px system-ui, -apple-system, sans-serif;
    color: #333;
    transform: translate(calc(-50% + 100vw), 0);
    transition: transform 1s ease;
    pointer-events: none;
  }
  .qr img {
    display: block;
    width: 10vw;
    min-width: 80px;
    max-width: none;
    max-height: none;
    transition: none;
  }
  .qr.show {
    transform: translate(-50%, 0);
    transition-delay: 3s; /* wait for the polaroid to land */
  }
  .qr.exiting {
    transform: translate(calc(-50% + 100vw), 0);
    transition-delay: 0s;
  }
  .captured img {
    display: block;
    width: 100%;
    height: auto;
    max-width: none;
    max-height: none;
  }
</style>
