export type Flag = 'camera' | 'touch' | 'internet' | 'gpu';
export const FLAGS: Flag[] = ['camera', 'touch', 'internet', 'gpu'];

// kiosk-worthy pages; `needs` are hardware flags a kiosk must have to run it
export const MODULES: { route: string; label: string; needs: Flag[] }[] = [
  { route: '/admin/step_test/', label: 'Step Test', needs: ['camera', 'internet'] },
  { route: '/admin/slide_show/', label: 'Slide Show', needs: [] },
  { route: '/admin/gesture/', label: 'Gesture', needs: ['camera', 'internet'] },
  { route: '/admin/camwithme/', label: 'CamWithMe', needs: ['camera', 'internet'] },
  { route: '/admin/human_counter/', label: 'Human Counter', needs: ['camera', 'internet'] },
  { route: '/admin/perf_debug/', label: 'Perf Debug', needs: ['camera', 'internet'] },
  { route: '/demo/camwithnkob/', label: 'CamWithNkob', needs: ['camera', 'internet'] },
  { route: '/demo/camwithnkob/remote', label: 'Nkob phone remote', needs: ['touch', 'internet'] },
];
