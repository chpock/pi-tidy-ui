import { Theme } from '@earendil-works/pi-coding-agent';
import type { TerminalColorMode } from '@earendil-works/pi-tui';

/** Explicit authored inputs shared by the early comparison and actual CLI. */
export function followPiTheme(name: string, mode: TerminalColorMode, base: Theme): Theme {
  const backgrounds = new Set(['selectedBg', 'searchMatchBg', 'userMessageBg', 'customMessageBg', 'toolPendingBg', 'toolSuccessBg', 'toolErrorBg']);
  const fg: Record<string, string | number> = {}, bg: Record<string, string | number> = {};
  for (const role of Object.keys(base.colors)) (backgrounds.has(role) ? bg : fg)[role] = backgrounds.has(role) ? '#242424' : '#d0d0d0';
  Object.assign(bg, { toolSuccessBg: '#303030', toolErrorBg: '#202020' });
  if (['gruvbox', 'faint-donor', 'faint-parent'].includes(name)) {
    Object.assign(fg, {
      toolOutput: '#ebdbb2', toolTitle: '#8ec07c', dim: '#928374', muted: '#a89984',
      syntaxComment: '#928374', syntaxKeyword: '#fb4934', syntaxString: '#d79921', syntaxNumber: '#d3869b',
      syntaxType: '#8ec07c', syntaxFunction: '#b8bb26', syntaxVariable: '#83a598', syntaxOperator: '#fe8019', syntaxPunctuation: '#ebdbb2',
      mdHeading: '#83a598', mdLink: '#b8bb26', mdLinkUrl: '#8ec07c', mdCode: '#fabd2f', mdCodeBlock: '#ebdbb2',
      mdQuote: '#928374', mdQuoteBorder: '#7c6f64', mdCodeBlockBorder: '#928374', mdListBullet: '#83a598', mdHr: '#928374',
      error: '#fb4934', warning: '#fe8019', toolDiffAdded: '#b8bb26', toolDiffRemoved: '#fb4934',
    });
    Object.assign(bg, { toolPendingBg: '#32302f', toolSuccessBg: '#282828', toolErrorBg: '#322929' });
  } else if (name === 'saturated') {
    Object.assign(fg, { mdHeading: '#ffcc33', syntaxString: '#55dd99', mdCode: '#bb88ff', mdLink: '#55bbff' });
    Object.assign(bg, { toolPendingBg: '#121822', toolSuccessBg: '#1c3d32', toolErrorBg: '#442b30' });
  } else if (name === 'low-contrast') {
    for (const key of Object.keys(fg)) fg[key] = '#555555';
    for (const key of Object.keys(bg)) bg[key] = '#777777';
  } else if (name === 'terminal-default' || name === 'mixed-foreground') {
    if (name === 'terminal-default') bg.toolPendingBg = '';
    fg.toolOutput = ''; fg.mdCode = ''; fg.syntaxString = 17;
  } else if (name !== 'monochrome' && name !== 'faint') throw new Error('Unknown authored Follow Pi fixture');
  return new Theme(fg as ConstructorParameters<typeof Theme>[0], bg as ConstructorParameters<typeof Theme>[1], mode,
      name === 'faint' ? { dim: ['toolOutput', 'mdCode', 'syntaxString'] }
      : name === 'faint-donor' ? { dim: ['syntaxPunctuation'] }
      : name === 'faint-parent' ? { dim: ['mdHeading', 'mdLink'] } : {});
}
