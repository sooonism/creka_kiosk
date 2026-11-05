<script lang="ts">
  import { onMount } from "svelte";
  import { openKioskLink } from "../lib/kioskLink";

  const STAGES = ["idle", "waking", "greet", "reveal", "countdown", "snapped"];
  const params = new URLSearchParams(location.search);
  const key = params.get("key") ?? "";
  const kioskId = params.get("kiosk") ?? "default";

  let s = $state<any>(null);
  let linked = $state(false);
  let refused = $state(false);
  let touchedAt = 0; // while a slider is being dragged, don't let incoming state fight it
  let link: ReturnType<typeof openKioskLink>;

  const send = (cmd: Record<string, unknown>) => link.channel.push("cmd", cmd);

  function slide(k: string, v: number) {
    touchedAt = Date.now();
    s.pose[k] = v;
    send({ type: "pose", key: k, value: v });
  }

  onMount(() => {
    link = openKioskLink("remote", kioskId, {
      key,
      onRefused: () => (refused = true),
      onJoin: (r) => {
        linked = true;
        if (r.state) s = r.state;
      },
    });
    link.channel.on("state", (st) => {
      if (Date.now() - touchedAt > 1000) s = st;
    });
    link.channel.onError(() => (linked = false));
    link.channel.onClose(() => (linked = false));
    return () => link.close();
  });
</script>

<main>
  <h1>Nkob remote <small class:on={linked}>{refused ? "wrong key" : linked ? "linked" : "connecting…"}</small></h1>

  {#if s}
    <h2>Mode</h2>
    <div class="row">
      {#each ["actual", "debug"] as m}
        <button class:active={s.mode === m} onclick={() => send({ type: "mode", value: m })}>{m}</button>
      {/each}
    </div>

    <h2>Sidebar</h2>
    <div class="row">
      <button class:active={s.sidebarOpen} onclick={() => send({ type: "sidebar", value: true })}>show</button>
      <button class:active={!s.sidebarOpen} onclick={() => send({ type: "sidebar", value: false })}>hide</button>
    </div>

    <h2>Stage</h2>
    <div class="grid">
      {#each STAGES as st}
        <button class:active={s.stage === st} onclick={() => send({ type: "stage", value: st })}>{st}</button>
      {/each}
    </div>
    <button class="snap" onclick={() => send({ type: "snap" })}>📷 Snap + preview</button>

    <h2>Nkob pose</h2>
    {#each [["x", -300, 300, 1], ["y", -300, 300, 1], ["r", -180, 180, 1], ["s", 0.5, 10, 0.1]] as [k, min, max, step]}
      <label>
        <span>{k} {s.pose[k as string]}</span>
        <input type="range" {min} {max} {step} value={s.pose[k as string]} oninput={(e) => slide(k as string, +e.currentTarget.value)} />
      </label>
    {/each}
    <button onclick={() => send({ type: "savePose" })}>Save pose</button>
    {#each s.savedPoses as p, i}
      <div class="row">
        <button onclick={() => send({ type: "applyPose", i })}>{p.x}, {p.y}, {p.r}°, ×{p.s ?? 4}</button>
        <button class="x" onclick={() => send({ type: "deletePose", i })}>×</button>
      </div>
    {/each}

    <h2>Face</h2>
    <small>{s.faceDetected ? `${s.faceW.toFixed(2)} · ${s.distance}` : "no face"}</small>

    <h2>Countdown</h2>
    <label>
      <span>y {s.countdownY}vh</span>
      <input
        type="range" min="0" max="90" step="1" value={s.countdownY}
        oninput={(e) => { touchedAt = Date.now(); send({ type: "countdownY", value: +e.currentTarget.value }); }}
      />
    </label>
  {:else}
    <p>Waiting for the kiosk page <code>{kioskId}</code> to report in…</p>
  {/if}
</main>

<style>
  :global(body) {
    margin: 0;
    background: #0f1117;
  }
  main {
    max-width: 480px;
    margin: 0 auto;
    padding: 16px;
    display: flex;
    flex-direction: column;
    gap: 8px;
    color: #e1e4ea;
    font: 15px system-ui, -apple-system, sans-serif;
  }
  h1 {
    font-size: 18px;
    margin: 0;
  }
  h1 small {
    font-size: 12px;
    color: #e5484d;
  }
  h1 small.on {
    color: #3fb950;
  }
  h2 {
    margin: 14px 0 0;
    font-size: 11px;
    text-transform: uppercase;
    color: #8b8fa3;
  }
  .row,
  .grid {
    display: flex;
    gap: 8px;
  }
  .grid {
    flex-wrap: wrap;
  }
  .row button,
  .grid button {
    flex: 1;
  }
  .x {
    flex: 0 0 48px !important;
  }
  label {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  button {
    font: 600 15px system-ui, -apple-system, sans-serif;
    padding: 12px;
    border-radius: 8px;
    border: 1px solid #333;
    background: #1c1f2a;
    color: #e1e4ea;
  }
  button.active {
    background: #a78bfa;
    color: #0f1117;
    border-color: #a78bfa;
  }
  button.snap {
    background: #e1306c;
    border-color: #e1306c;
    color: #fff;
  }
</style>
