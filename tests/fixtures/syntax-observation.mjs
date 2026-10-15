import { readFileSync } from 'node:fs';

export function readPendingJson(path) {
  try { return JSON.parse(readFileSync(path, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT' || error instanceof SyntaxError) return undefined; throw error; }
}

export const nativeReady = snapshot => snapshot.client?.provider.availability === 'ready' && snapshot.client.effective
  && snapshot.source?.globalUnsettledJobs === 0;

export async function themePhaseReady(observe, readEvents, phase, markers) {
  const sources = readEvents().filter(event => event.type === 'syntax_theme_reply' && event.phase === phase)
    .flatMap(event => event.payload.sources);
  if (!markers.every(marker => sources.some(source => source.text.includes(marker)))) return false;
  const snapshot = await observe();
  return nativeReady(snapshot) ? snapshot : false;
}
