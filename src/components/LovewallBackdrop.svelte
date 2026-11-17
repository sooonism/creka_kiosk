<script lang="ts">
  // The slow, quiet motion behind each template. Festive and garden need elements (confetti, leaves); the others are one
  // CSS layer in lovewall.css. All of it is transform/opacity only so it can run on a venue screen for hours.
  import LovewallConfetti from './LovewallConfetti.svelte';
  let { theme }: { theme?: string } = $props();

  const rnd = (i: number, k: number) => ((Math.sin(i * 12.9898 + k * 78.233) * 43758.5453) % 1 + 1) % 1;
  const GREENS = ['#2f7d4f', '#5a9e5f', '#86b36a', '#3f8f6b', '#a7c47a'];
  const leaves = Array.from({ length: 14 }, (_, i) => ({
    left: rnd(i, 1) * 100,
    size: 2.6 + rnd(i, 2) * 2.4,
    dur: 46 + rnd(i, 3) * 40,
    delay: -rnd(i, 4) * 86,
    dx: (rnd(i, 5) - 0.5) * 18,
    rot: (rnd(i, 6) > 0.5 ? 1 : -1) * (120 + rnd(i, 7) * 220),
    colour: GREENS[i % GREENS.length],
  }));
</script>

{#if theme === 'festive'}
  <LovewallConfetti />
{:else}
  <div class="lw-bg" aria-hidden="true">
    {#if theme === 'garden'}
      {#each leaves as l}
        <svg class="lw-leaf" viewBox="0 0 24 24" style="left:{l.left}%;--s:{l.size};--dx:{l.dx}vw;--r:{l.rot}deg;color:{l.colour};animation-duration:{l.dur}s;animation-delay:{l.delay}s">
          <path d="M12 1.5C6 5.5 4 11.5 6 17.5c1.6 3.2 4.4 4.9 6 5 1.6-.1 4.4-1.8 6-5 2-6 0-12-6-16z" fill="currentColor" />
          <path d="M12 6v15" stroke="#fff" stroke-opacity=".45" stroke-width=".9" stroke-linecap="round" fill="none" />
        </svg>
      {/each}
    {/if}
  </div>
{/if}
