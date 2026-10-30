import type { TerminalColorMode } from '@earendil-works/pi-tui';
import type { StyleSelection } from '../../src/occipital/controller-styles.ts';
import { sampleOwnedPalette } from '../../src/themes/owned-palette.ts';
import { createSemanticRuleDefinition } from '../../src/syntax/semantic-rules.ts';

export function ownedStyleSelection(id = 'gruvbox-dark', mode: TerminalColorMode = 'truecolor', bindingRevision = 1): StyleSelection {
  const palette = sampleOwnedPalette(id, mode);
  return {
    definition: createSemanticRuleDefinition(),
    bindingRevision,
    palette: `owned-palette-v1:${id}`,
    bindings: palette.bindings,
    roles: palette.roles,
  };
}
