<script lang="ts">
  // Falling confetti behind the festive template. Transform-only animation (cheap enough to run on a venue screen for hours);
  // pieces are laid out from their index so the pattern is fixed and the first frame is already full.
  const COLOURS = ['#ff5a3c', '#ffd23f', '#7fd8be', '#9bc6ff', '#ffb3c7', '#7c3aed'];
  const rnd = (i: number, k: number) => ((Math.sin(i * 12.9898 + k * 78.233) * 43758.5453) % 1 + 1) % 1;
  const pieces = Array.from({ length: 64 }, (_, i) => ({
    left: rnd(i, 1) * 100,
    size: 1.1 + rnd(i, 2) * 1.4,
    dur: 11 + rnd(i, 3) * 12,
    delay: -rnd(i, 4) * 23,
    dx: (rnd(i, 5) - 0.5) * 24,
    rot: (rnd(i, 6) > 0.5 ? 1 : -1) * (360 + rnd(i, 7) * 720),
    colour: COLOURS[i % COLOURS.length],
    round: i % 4 === 0,
  }));
</script>

<div class="lw-confetti" aria-hidden="true">
  {#each pieces as p}
    <i class:round={p.round} style="left:{p.left}%;--s:{p.size};--dx:{p.dx}vw;--r:{p.rot}deg;background:{p.colour};animation-duration:{p.dur}s;animation-delay:{p.delay}s"></i>
  {/each}
</div>
