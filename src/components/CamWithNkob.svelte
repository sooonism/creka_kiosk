<script lang="ts">
  import { onMount, onDestroy } from "svelte";
  import QRCode from "qrcode";
  import CamWithMe from "./CamWithMe.svelte";
  import { openKioskLink, dayMYT, hourMYT } from "../lib/kioskLink";

  let { src }: { src: string } = $props();
  let faceDetected = $state(false);
  let faceOnRight = $state(false);
  // livecam nkob cycles to the next image each time he switches sides; add more here
  const NKOB_POSES = [1, 2, 3, 4, 5].map((n) => `/img/demo/camwithnkob/pose${n}.png`);
  let poseIdx = $state(0);
  const COVER_IMG = {
    idle: "/img/demo/camwithnkob/sleep_a.svg",
    waking: "/img/demo/camwithnkob/wakeup_a.svg",
    greet: "/img/demo/camwithnkob/greet.png",
  };
  let camVideo: HTMLVideoElement | null = null; // the live <video>; snaps are cut from it at full camera resolution
  let camStatus = { camera: false, model: false };
  let nkobEl: HTMLImageElement;
  let previewCanvas: HTMLCanvasElement;

  // nkob slides in from the side opposite the face once the cam is revealed, and back out the same way
  let nkobIn = $derived(
    (stage === "reveal" || stage === "countdown" || stage === "snapped") && (faceDetected || mode === "debug")
  );
  // pose is for the face-on-left case (nkob on the right); mirrored when the face is on the right
  type Pose = { x: number; y: number; r: number; s: number };
  let pose = $state<Pose>({ x: 100, y: 60, r: -15, s: 1.5 });
  let savedPoses = $state<Pose[]>([]);
  const rand = (min: number, max: number) => Math.round(min + Math.random() * (max - min));
  let faceW = $state(0.3); // latest face box width as a fraction of the frame
  const NKOB_SCALE = 1.5; // fixed size, no near/far zones
  const rerollPose = () => {
    pose.s = NKOB_SCALE;
    pose.r = -rand(15, 45); // negative keeps the original tilt direction
    pose.y = 60; // % of its own height, higher = lower on screen
  };
  const nextPose = () => {
    poseIdx = (poseIdx + rand(1, NKOB_POSES.length - 1)) % NKOB_POSES.length; // random, never the same pose twice in a row
    rerollPose();
  };
  const onFaceSize = (w: number) => (faceW = w);
  let side = $derived(faceOnRight ? -1 : 1);
  let translateX = $derived(side * (nkobIn ? pose.x : 500));
  let rotate = $derived(side * pose.r);

  let flashOpacity = $state(0);
  let flashTransitioning = $state(false);
  let capturedSrc = $state<string | null>(null);
  let recentShots = $state<{ src: string; qr: string | null }[]>([]); // latest 3, shown along the bottom on snapped
  let capturedPhase = $state<"hidden" | "shown" | "exiting">("hidden");
  let capturedInstant = $state(false);
  let capturedExitTimer: any = null;
  let savedPhotoId = $state<string | null>(null);
  let qrSrc = $state<string | null>(null);

  $effect(() => {
    if (!savedPhotoId) return;
    QRCode.toDataURL(`${location.origin}/photo?id=${savedPhotoId}${kioskQuery}&s=qr`, { margin: 1, width: 400 }).then(
      (url) => (qrSrc = url)
    );
  });


  // Kiosk flow: idle -> waking -> greet -> reveal -> countdown -> snapped -> waking (idle if the face left)
  const STAGES = ["idle", "waking", "greet", "reveal", "countdown", "snapped"] as const;
  type Stage = (typeof STAGES)[number];
  let stage = $state<Stage>("idle");
  // ?mode=actual starts the real kiosk flow; anything else (default) is debug
  let mode = $state<"actual" | "debug">(typeof location !== "undefined" && new URLSearchParams(location.search).get("mode") === "actual" ? "actual" : "debug");
  let count = $state(5);
  let sidebarOpen = $state(mode === "debug"); // no debug panel over a live kiosk
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
  // decode every image the flow shows up front, so the first reveal/greet doesn't hitch on a cold decode
  const warm: HTMLImageElement[] = [];
  onMount(() => {
    for (const src of [...NKOB_POSES, ...Object.values(COVER_IMG), "/img/demo/camwithnkob/bg.webp"]) {
      const img = new Image();
      img.src = src;
      img.decode().catch(() => {});
      warm.push(img); // keep a reference so the decoded bitmap isn't dropped
    }
  });
  onMount(() => {
    onMouseMove(); // start the 2s hide timer even if the mouse never moves
    countdownY = Number(localStorage.getItem("nkob-countdown-y") ?? countdownY);
    savedPoses = JSON.parse(localStorage.getItem("nkob-poses") ?? "[]");
  });
  // backend link (creka_backend `kiosk:<id>` channel): pushes UI state for the remote, applies its commands,
  // heartbeats after 30 idle minutes, reports errors and a daily wake-up check
  let pushState: ((st: object) => void) | null = null;
  onMount(() => {
    const apply = (c: any) => {
      if (c.type === "mode") setMode(c.value);
      else if (c.type === "sidebar") sidebarOpen = c.value;
      else if (c.type === "stage") setStage(c.value);
      else if (c.type === "snap") setStage("snapped");
      else if (c.type === "pose") pose[c.key as keyof Pose] = c.value;
      else if (c.type === "savePose") savedPoses = [...savedPoses, { ...pose }];
      else if (c.type === "applyPose" && savedPoses[c.i]) pose = { ...pose, ...savedPoses[c.i] };
      else if (c.type === "deletePose") savedPoses = savedPoses.filter((_, j) => j !== c.i);
      else if (c.type === "countdownY") countdownY = c.value;
    };

    let lastSent = Date.now();
    let lastWakeup: { at: number; camera: boolean; model: boolean } | null = null;
    const push = (event: string, payload: object) => {
      lastSent = Date.now();
      link.channel.push(event, payload);
    };
    const wakeupCheck = () => {
      lastWakeup = { at: Date.now(), ...camStatus };
      push("wakeup", lastWakeup);
    };

    const link = openKioskLink("kiosk", kiosk ?? "default", {
      // on every (re)join, e.g. after a backend restart, the backend gets today's wake-up report again
      onJoin: () => {
        if (lastWakeup) push("wakeup", lastWakeup);
        if (lastState) push("state", JSON.parse(lastState)); // so a remote that joins later sees the current UI
      },
    });
    pushState = (st) => push("state", st);
    link.channel.on("cmd", apply);

    const onError = (e: ErrorEvent | PromiseRejectionEvent) => {
      const err: any = "reason" in e ? e.reason : e.error;
      push("error", { message: err?.message ?? String(err ?? (e as ErrorEvent).message), detail: err?.stack ?? "", page: location.pathname });
    };
    window.addEventListener("error", onError);
    window.addEventListener("unhandledrejection", onError);

    const firstCheck = setTimeout(wakeupCheck, 20_000); // give the camera and model time to load
    const timer = setInterval(() => {
      if (Date.now() - lastSent >= 30 * 60_000) push("heartbeat", {});
      // left on overnight: run the morning check again once a new day starts (from 07:00)
      if (hourMYT() >= 7 && (!lastWakeup || dayMYT(lastWakeup.at) !== dayMYT())) wakeupCheck();
    }, 60_000);

    return () => {
      clearTimeout(firstCheck);
      clearInterval(timer);
      window.removeEventListener("error", onError);
      window.removeEventListener("unhandledrejection", onError);
      pushState = null;
      link.close();
    };
  });
  // push the UI state whenever it changes (JSON compare keeps the per-frame face size from flooding the socket)
  let lastState = "";
  $effect(() => {
    const snapshot = JSON.stringify({ mode, stage, sidebarOpen, pose, savedPoses, countdownY, faceDetected, faceW: Math.round(faceW * 100) / 100 });
    if (snapshot === lastState) return;
    lastState = snapshot;
    pushState?.(JSON.parse(snapshot));
  });
  $effect(() => {
    localStorage.setItem("nkob-poses", JSON.stringify(savedPoses));
  });
  $effect(() => {
    localStorage.setItem("nkob-countdown-y", String(countdownY));
  });
  // idle: fade past polaroids in and out, 3 random ones at the bottom and 3 more along the top, each tilted a bit
  // captures from before thumbnails existed only have the full png
  const fullSize = (e: Event) => {
    const img = e.currentTarget as HTMLImageElement;
    img.onerror = null;
    img.src = img.src.replace(".thumb.jpg", ".png");
  };
  let idleShots = $state<{ src: string; r: number }[]>([]);
  let idleShow = $state(false);
  $effect(() => {
    if (stage !== "idle") return;
    let alive = true;
    let t: any;
    const wait = (ms: number) => new Promise((r) => (t = setTimeout(r, ms)));
    (async () => {
      const ids: string[] = await fetch("/api/captures" + location.search).then((r) => r.json()).catch(() => []);
      while (alive && ids.length) {
        idleShots = [...ids]
          .sort(() => Math.random() - 0.5)
          .slice(0, 6)
          .map((id) => ({ src: `/captures/demo/camwithnkob/${kioskDir}${id}.thumb.jpg`, r: rand(-8, 8) }));
        await wait(100); // let the new images mount at opacity 0 so the fade-in runs
        idleShow = true;
        await wait(4000);
        idleShow = false;
        await wait(1500); // fade-out (1s) + a short gap
      }
    })();
    return () => {
      alive = false;
      clearTimeout(t);
      idleShow = false;
    };
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
    if (next === "reveal") nextPose();
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
      stageTimer = setTimeout(() => setStage("waking"), 23000); // 20s hold + 3s slide-out, then fade into waking
    }
  }

  // the × on the polaroid: slide it (and its QR) out now instead of waiting for the hold timer
  function dismissPolaroid() {
    clearTimeout(capturedExitTimer);
    capturedPhase = "exiting";
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

  // face seen while idle -> wake up at once; if it doesn't hold, the effect above sends it back to idle
  $effect(() => {
    if (mode !== "debug" && stage === "idle" && faceDetected) setStage("waking");
  });

  // LED strip (scripts/led-strip.py on the Pi, localhost): lit from the wake-up until the next idle.
  // Re-sent every 60s because the daemon switches itself off after 120s without an /on.
  const led = (on: boolean) => fetch(`http://127.0.0.1:8765/${on ? "on" : "off"}`, { mode: "no-cors" }).catch(() => {});
  $effect(() => {
    if (mode === "debug") return;
    const on = stage !== "idle";
    led(on);
    if (!on) return;
    const t = setInterval(() => led(true), 60_000);
    return () => clearInterval(t);
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
    if (!camVideo || !previewCanvas || !nkobEl) return;
    const ctx = previewCanvas.getContext("2d");
    if (!ctx) return;
    // centre square of the camera frame (what the live view shows), mirrored like the live view, at full resolution
    const { videoWidth: vw, videoHeight: vh } = camVideo;
    const side = Math.min(vw, vh);
    if (!side) return;
    if (previewCanvas.width !== side || previewCanvas.height !== side) {
      previewCanvas.width = side;
      previewCanvas.height = side;
    }
    ctx.save();
    ctx.scale(-1, 1);
    ctx.drawImage(camVideo, (vw - side) / 2, (vh - side) / 2, side, side, -side, 0, side, side);
    ctx.restore();

    const camRect = camVideo.getBoundingClientRect();
    if (!camRect.width || !camRect.height) return;
    // the cam box renders with object-fit:cover, so its on-screen box and the
    // frame buffer can have different aspect ratios — map between them with
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

  async function captureNow() {
    if (!previewCanvas) return;
    drawPreview(); // reads nkob's position, so it must run now, not after the encode
    const blob = await buildFramedCapture(); // PNG encode is async: the flash and countdown never stall on it
    if (!blob) return;
    capturedSrc = URL.createObjectURL(blob);
    caption = pickCaption(caption);
    const all = [...recentShots, { src: capturedSrc, qr: null }];
    all.slice(0, -3).forEach((s) => URL.revokeObjectURL(s.src));
    recentShots = all.slice(-3);

    if (capturedExitTimer) clearTimeout(capturedExitTimer);
    // snap instantly back to the above-top-right origin (no transition) in case
    // it's mid-exit from a previous capture, then let the next frame animate in
    capturedInstant = true;
    capturedPhase = "hidden";
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        capturedInstant = false;
        capturedPhase = "shown";
        // 20s on screen (3s slide-in included), then slide out
        if (mode !== "debug") capturedExitTimer = setTimeout(() => {
          capturedPhase = "exiting";
        }, 20000);
      });
    });

    qrSrc = null;
    saveCapture(blob, capturedSrc);
  }

  const CAPTIONS = [
    "Stay weird. Stay wonderful.",
    "Be yourself. That’s your superpower.",
    "Small moments, big smiles.",
    "Don’t forget to enjoy the little things.",
    "You are someone’s favourite human.",
    "Today? Just chill.",
    "Too cool to be serious.",
    "I’m here for the good vibes.",
    "Low battery, high happiness.",
    "Life is weird. Let’s enjoy it.",
  ];
  // the preview shows the caption the next photo will get; re-rolled after every shot
  const pickCaption = (prev = "") => CAPTIONS.filter((c) => c !== prev)[Math.floor(Math.random() * (CAPTIONS.length - 1))];
  let caption = $state(pickCaption());

  // Bakes the white polaroid border + caption into a fixed
  // 1080x1080 PNG; the feed is cover-cropped into the photo window.
  function buildFramedCapture(): Promise<Blob | null> {
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
    // shrink long captions to fit inside the border
    const size = Math.min(56, (56 * pw) / ctx.measureText(caption).width);
    ctx.font = `600 ${size}px system-ui, -apple-system, sans-serif`;
    ctx.fillText(caption, w / 2, h - bottom / 2);

    return new Promise((res) => out.toBlob(res, "image/png"));
  }

  // per-kiosk capture folder, set via /k/<id> → ?kiosk=<id>
  const kiosk = typeof location === "undefined" ? null : new URLSearchParams(location.search).get("kiosk");
  const kioskDir = kiosk ? `${kiosk}/` : "";
  const kioskQuery = kiosk ? `&kiosk=${kiosk}` : "";

  async function saveCapture(blob: Blob, image: string) {
    savedPhotoId = null;
    const dataUrl = await new Promise<string>((res) => {
      const r = new FileReader();
      r.onload = () => res(r.result as string);
      r.readAsDataURL(blob);
    });
    const res = await fetch("/api/save-capture" + location.search, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ image: dataUrl, meta: { pose: poseIdx } }),
    });
    if (!res.ok) return;
    const { id } = await res.json();
    savedPhotoId = id;
    const qr = await QRCode.toDataURL(`${location.origin}/photo?id=${id}${kioskQuery}&s=qr`, { margin: 1, width: 400 });
    const shot = recentShots.find((s) => s.src === image);
    if (shot) shot.qr = qr;
  }
</script>

<div class="bg"></div>
<div class="livecam">
  <CamWithMe
    debug={false}
    aspect={1}
    detectMs={stage === "idle" ? 250 : 500}
    lowPower={stage === "idle" && mode !== "debug"}
    paint={stage === "reveal" || stage === "countdown" || stage === "snapped" || mode === "debug"}
    onFaceCount={(count) => (faceDetected = count > 0)}
    onFacePosition={(x, both) => {
      if (!both) faceOnRight = x > 0.5; // people on both sides: stay on the current side
    }}
    {onFaceSize}
    live
    onVideo={(v) => (camVideo = v)}
    onStatus={(st) => (camStatus = st)}
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

<div class="idle-shots" class:show={idleShow}>
  {#each idleShots.slice(0, 3) as shot}
    <img src={shot.src} alt="Past shot" style:transform="rotate({shot.r}deg)" onerror={fullSize} />
  {/each}
</div>
<div class="idle-shots top" class:show={idleShow}>
  {#each idleShots.slice(3) as shot}
    <img src={shot.src} alt="Past shot" style:transform="rotate({shot.r}deg)" onerror={fullSize} />
  {/each}
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
  <small>{faceDetected ? `${faceW.toFixed(2)}` : "no face"}</small>
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
  <div class="preview-caption">{caption}</div>
</div>

{#if capturedSrc}
  <div
    class="captured"
    class:show={capturedPhase === "shown"}
    class:exiting={capturedPhase === "exiting"}
    class:instant={capturedInstant}
  >
    <img src={capturedSrc} alt="Captured" />
    <button class="close" aria-label="Close photo" onclick={dismissPolaroid}>×</button>
  </div>
{/if}

{#if recentShots.length}
  <div class="recent" class:show={capturedPhase === "shown"} class:exiting={capturedPhase === "exiting"}>
    {#each recentShots as shot}
      <div class="shot">
        <img src={shot.src} alt="Recent shot" />
        {#if shot.qr}<img class="shot-qr" src={shot.qr} alt="Scan to get this photo" />{/if}
      </div>
    {/each}
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

<style>
  /* z-index layers: 10 bg, 20 livecam, 30 cover (idle/waking), 40 countdown, 50 flash, 55 bg (after snap), 60 captured+qr, 101 debug, 110 sidebar toggle */
  .bg {
    position: fixed;
    inset: 0;
    background: center / cover no-repeat;
    pointer-events: none;
  }
  .bg {
    z-index: 10;
    background-image: url("/img/demo/camwithnkob/bg.webp");
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
    background: #000 url("/img/demo/camwithnkob/bg.webp") center / cover no-repeat;
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
    text-align: center;
    padding: 0 12px;
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
  .captured .close {
    position: absolute;
    top: 8px;
    right: 8px;
    width: 44px;
    height: 44px;
    border: 0;
    border-radius: 50%;
    background: rgba(0, 0, 0, 0.55);
    color: #fff;
    font: 600 28px/1 system-ui, sans-serif;
    cursor: pointer;
    pointer-events: auto; /* .captured itself ignores the pointer */
  }
  .captured.exiting {
    transform: translate(calc(-50% + 160vw), -50%);
  }
  .captured.instant {
    transition: none;
  }
  .qr {
    position: fixed;
    top: 50%;
    right: 3vw;
    z-index: 60;
    padding: 16px;
    border-radius: 12px;
    background: #fff;
    box-shadow: 0 10px 30px rgba(0, 0, 0, 0.3);
    text-align: center;
    font: 600 16px system-ui, -apple-system, sans-serif;
    color: #333;
    transform: translate(calc(100% + 10vw), -50%);
    transition: transform 1s ease;
    pointer-events: none;
  }
  .idle-shots {
    position: fixed;
    /* same row as .recent: its images sit above a QR (8.2vw + 1vh gap) */
    bottom: calc(8vh + 8.2vw);
    left: 50%;
    z-index: 35; /* above the idle cover (30), below the countdown (40) */
    display: flex;
    gap: 2vw;
    transform: translateX(-50%);
    opacity: 0;
    transition: opacity 1s ease;
    pointer-events: none;
  }
  .idle-shots.top {
    bottom: auto;
    /* keeps the layout from when a 2160x4200 frame (473px top border) was drawn cover + top-aligned: start below that, and at least one polaroid down */
    top: max(calc(6vh + 18vw), calc(473 * max(100vw / 2160, 100vh / 4200) + 1.5vh));
  }
  .idle-shots.show {
    opacity: 1;
  }
  .idle-shots img {
    width: 18vw;
    max-width: none;
    max-height: none;
    border-radius: 4px;
    transition: none;
  }
  .recent {
    position: fixed;
    bottom: 7vh;
    left: 50%;
    z-index: 60;
    display: flex;
    gap: 2vw;
    transform: translate(-50%, 200%);
    transition: transform 1s ease;
    pointer-events: none;
  }
  .recent img {
    width: 18vw;
    max-width: none;
    max-height: none;
    border-radius: 4px;
    box-shadow: 0 6px 16px rgba(0, 0, 0, 0.35);
    transition: none;
  }
  .shot {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 1vh;
  }
  .recent .shot-qr {
    width: 7vw;
    padding: 0.6vw;
    border-radius: 6px;
    background: #fff;
    box-shadow: none;
  }
  .recent.show {
    transform: translate(-50%, 0);
    transition-delay: 3s; /* wait for the polaroid to land */
  }
  .recent.exiting {
    transform: translate(-50%, 200%);
    transition-delay: 0s;
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
    transform: translate(0, -50%);
    transition-delay: 3s; /* wait for the polaroid to land */
  }
  .qr.exiting {
    transform: translate(calc(100% + 10vw), -50%);
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
