<script lang="ts">
  // A guest photo with its stickers drawn back over it. The wrapper hugs the photo, so a sticker's % position is a
  // fraction of the photo, the same as when the guest placed it.
  type Sticker = { src: string; x: number; y: number; s: number; r: number };
  let { src, stickers = [], big = false }: { src: string; stickers?: Sticker[]; big?: boolean } = $props();
</script>

<div class="lw-ph" class:big>
  <div class="lw-ph-in">
    <img {src} alt="" />
    {#each stickers as t}
      <img class="lw-stk" src={t.src} alt="" style="left:{t.x * 100}%;top:{t.y * 100}%;width:{t.s * 100}%;transform:translate(-50%,-50%) rotate({t.r}deg)" />
    {/each}
  </div>
</div>
