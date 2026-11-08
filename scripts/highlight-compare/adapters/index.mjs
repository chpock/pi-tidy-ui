export const adapters = {
  'pi-tidy-ui': { load: () => import('./pi-tidy-ui.mjs'), collect: 'collectPi' },
  opencode: { load: () => import('./opencode.mjs'), prepare: 'prepareOpenCode', collect: 'collectOpenCode' },
};
