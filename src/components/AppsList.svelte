<script lang="ts">
  import { APPS } from "../lib/apps";
  const groups = [...new Set(APPS.map((a) => a.group))];
</script>

{#each groups as g}
  <h3>{g}</h3>
  <div class="list">
    {#each APPS.filter((a) => a.group === g) as a}
      <a class="app" href={a.route}>
        <b>{a.label}</b>
        <small>{a.route}{a.component ? ` · ${a.component}` : ""}</small>
        <span>{a.note}</span>
      </a>
    {/each}
  </div>
{/each}

<style>
  h3 { margin: 1.25rem 0 0.5rem; font-size: 0.9rem; color: #8b8fa3; }
  .list { display: grid; grid-template-columns: repeat(auto-fill, minmax(240px, 1fr)); gap: 0.5rem; }
  .app { display: flex; flex-direction: column; gap: 0.15rem; background: #1a1d27; border: 1px solid #2a2d37; border-radius: 8px; padding: 0.6rem 0.75rem; color: inherit; text-decoration: none; }
  .app:hover { border-color: #a78bfa; }
  small { color: #8b8fa3; word-break: break-all; }
  span { font-size: 0.8rem; }
</style>
