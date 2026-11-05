<script lang="ts">
  import KiosksAdmin from "./KiosksAdmin.svelte";
  import AppsList from "./AppsList.svelte";

  const tabs = ["kiosks", "apps"] as const;
  let tab = $state<(typeof tabs)[number]>(
    typeof location !== "undefined" && location.hash === "#apps" ? "apps" : "kiosks"
  );
  const pick = (t: (typeof tabs)[number]) => ((tab = t), history.replaceState(null, "", `#${t}`));
</script>

<h1>Dashboard</h1>
<div class="tabs">
  {#each tabs as t}
    <button class:on={tab === t} onclick={() => pick(t)}>{t === "kiosks" ? "Kiosks" : "Apps"}</button>
  {/each}
</div>

<!-- hidden, not unmounted, so unsaved kiosk edits survive a tab switch -->
<div hidden={tab !== "kiosks"}><KiosksAdmin /></div>
{#if tab === "apps"}<AppsList />{/if}

<style>
  .tabs { display: flex; gap: 0.25rem; border-bottom: 1px solid #2a2d37; margin-bottom: 1rem; }
  .tabs button { background: none; color: #8b8fa3; border: 0; border-bottom: 2px solid transparent; padding: 0.5rem 1rem; font: inherit; cursor: pointer; }
  .tabs button.on { color: #e1e4ea; border-bottom-color: #a78bfa; }
</style>
