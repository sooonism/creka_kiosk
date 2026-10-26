<script lang="ts">
  import CamWithPalm from "./CamWithPalm.svelte";

  type ScreenBox = {
    left: number;
    top: number;
    width: number;
    height: number;
    hand?: "Left" | "Right";
  };

  let camCanvas: HTMLCanvasElement | null = null;
  // smoothed boxes, one per tracked hand slot — lerped toward the latest
  // detection each frame instead of snapping, which is what caused the jitter
  let smoothed: ScreenBox[] = [];
  let screenBoxes = $state<ScreenBox[]>([]);

  const LERP = 0.35;

  function handlePalmBoxes(
    boxes: Array<{ x: number; y: number; width: number; height: number; hand?: "Left" | "Right" }>
  ) {
    if (!camCanvas) {
      smoothed = [];
      screenBoxes = [];
      return;
    }

    const canvasRect = camCanvas.getBoundingClientRect();
    if (!canvasRect.width || !canvasRect.height) return;

    // camCanvas renders with object-fit:cover, so its on-screen box and its
    // internal buffer can have different aspect ratios — map the normalized
    // (0-1) palm box into on-screen pixels with a uniform "cover" scale,
    // same technique used in NkobOverlay for the capture composite.
    const scale = Math.max(
      canvasRect.width / camCanvas.width,
      canvasRect.height / camCanvas.height
    );
    const contentW = camCanvas.width * scale;
    const contentH = camCanvas.height * scale;
    const offsetX = canvasRect.left + (canvasRect.width - contentW) / 2;
    const offsetY = canvasRect.top + (canvasRect.height - contentH) / 2;

    const ZOOM = 4;
    const targets = boxes.map((box) => {
      const rawLeft = offsetX + box.x * contentW;
      const rawTop = offsetY + box.y * contentH;
      const rawWidth = box.width * contentW;
      const rawHeight = box.height * contentH;
      const width = rawWidth * ZOOM;
      const height = rawHeight * ZOOM;
      return {
        left: rawLeft - (width - rawWidth) / 2,
        top: rawTop - (height - rawHeight) / 2,
        width,
        height,
        hand: box.hand,
      };
    });

    // one smoothing slot per hand, by index — new hands snap in instantly,
    // existing ones ease toward their new target each frame
    smoothed = targets.map((target, i) => {
      const prev = smoothed[i];
      if (!prev) return target;
      return {
        left: prev.left + (target.left - prev.left) * LERP,
        top: prev.top + (target.top - prev.top) * LERP,
        width: prev.width + (target.width - prev.width) * LERP,
        height: prev.height + (target.height - prev.height) * LERP,
        hand: target.hand,
      };
    });
    screenBoxes = smoothed;
  }
</script>

<CamWithPalm onPalmBoxes={handlePalmBoxes} onReady={(canvas) => (camCanvas = canvas)} />

{#each screenBoxes as box, i (i)}
  <img
    src="/img/cardhand.svg"
    alt="Card Hand"
    class="card-hand"
    class:flip={box.hand === "Left"}
    style="left: {box.left}px; top: {box.top}px; width: {box.width}px; height: {box.height}px;"
  />
{/each}

<style>
  .card-hand {
    position: fixed;
    z-index: 5;
    object-fit: contain;
    pointer-events: none;
  }
  .card-hand.flip {
    transform: scaleX(-1);
  }
</style>
