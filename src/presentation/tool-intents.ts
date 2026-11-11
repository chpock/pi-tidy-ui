export type ToolPresentationIntent = 'native' | 'compact' | 'bash' | 'file' | 'suppressed';

export function selectToolPresentationIntent(
  width: number,
  fileCard: boolean,
  bashCard: boolean,
  compactSummary: boolean,
): ToolPresentationIntent {
  if (width < 1 && !bashCard && (fileCard || compactSummary)) return 'suppressed';
  if (fileCard) return 'file';
  if (bashCard) return 'bash';
  if (compactSummary) return 'compact';
  return 'native';
}
