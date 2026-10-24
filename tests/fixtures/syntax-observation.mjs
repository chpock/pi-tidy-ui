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

// v3 SOURCE dictionaries and STYLE dictionaries are correlated by scope paths,
// never by reply-local IDs. These observers consume only actual recorded replies.
const paths = rows => {
  const result = [];
  for (const row of rows) result.push([...(result.at(-1) ?? []).slice(0, row[0]), ...row.slice(1)]);
  return result;
};
export function semanticStyle(events, marker, profile, language) {
  const matches = source => source.text.includes(marker) && (language === undefined || source.hint?.language === language);
  const sourceEvent = events.findLast(event => event.type === 'syntax_native_reply' && event.kind === 'source'
    && event.reply.status === 'ok' && event.payload.sources?.some(matches));
  if (!sourceEvent) return;
  const offered = sourceEvent.payload.sources.find(matches);
  const source = sourceEvent.reply.body.sources.find(source => source.key === offered.key);
  const offset = Buffer.byteLength(offered.text.slice(0, offered.text.indexOf(marker)));
  let end = source.replace_from, context;
  for (let i = 0; i < source.runs.length; i += 2) {
    end += source.runs[i]; if (offset < end) { context = paths(source.contexts)[source.runs[i + 1] - 1]; break; }
  }
  if (!context) return;
  for (const event of events.toReversed()) {
    if (event.type !== 'syntax_native_reply' || event.kind !== 'style' || event.reply.status !== 'ok'
      || event.payload.vocabulary !== sourceEvent.reply.body.vocabulary) continue;
    const rules = event.payload.rules;
    if (profile === 'pi' ? rules.kind !== 'client' : rules.kind !== 'native' || rules.id !== profile) continue;
    const index = paths(event.payload.contexts).findIndex(path => path.length === context.length && path.every((word, i) => word === context[i]));
    if (index >= 0) return { expression: event.reply.body.styles[event.reply.body.indices[index] - 1], sourceEvent, styleEvent: event };
  }
}
export function semanticSourceContext(events, marker, language) {
  for (const dispatched of events.toReversed()) {
    if (dispatched.type !== 'syntax_native_dispatch' || dispatched.kind !== 'source') continue;
    const offered = dispatched.payload.sources?.find(source => source.hint?.language === language && source.text.includes(marker));
    if (!offered) continue;
    const response = events.findLast(event => event.type === 'syntax_native_reply' && event.kind === 'source'
      && event.payload.ticket === dispatched.payload.ticket);
    if (response?.reply.status !== 'ok') continue;
    const source = response.reply.body.sources.find(result => result.key === offered.key);
    if (!source) continue;
    const offset = Buffer.byteLength(offered.text.slice(0, offered.text.indexOf(marker)));
    let end = source.replace_from;
    const contexts = paths(source.contexts);
    for (let i = 0; i < source.runs.length; i += 2) {
      end += source.runs[i];
      if (offset < end) return contexts[source.runs[i + 1] - 1];
    }
  }
}

export async function semanticPhaseReady(observe, readEvents, markers, profile) {
  if (!markers.every(marker => semanticStyle(readEvents(), marker, profile))) return false;
  const snapshot = await observe();
  return nativeReady(snapshot) && snapshot.client.effective.id === profile ? snapshot : false;
}
