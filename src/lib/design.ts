// camwithnkob graphics the designer can swap: the background and nkob's expressions (the poses cycled in the live cam).
// Defaults are the images shipped in public/img; designer uploads live next to the captures and override them.
export interface Design { bg: string; poses: string[] }

const IMG = '/img/demo/camwithnkob';
export const DEFAULT_DESIGN: Design = {
  bg: `${IMG}/bg.webp`,
  poses: [1, 2, 3, 4, 5].map((n) => `${IMG}/pose${n}.png`),
};
