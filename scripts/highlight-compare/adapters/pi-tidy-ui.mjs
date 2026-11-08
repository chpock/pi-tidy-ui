import { chmodSync, copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import { PiTerminal, root } from '../../../tests/fixtures/terminal-harness.mjs';
import { validateNative } from '../../test/context.mjs';
import { digest } from '../model.mjs';
import { mapPiDiffView, verifyPiDiffPaint } from './pi-diff.mjs';

const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };

export function validatePiReadiness(sample, fixture, theme, variant, call) {
  const selected = sample?.client?.selected, effective = sample?.client?.effective;
  if (selected?.kind !== 'theme' || selected.id !== theme || selected.variant !== variant ||
    effective?.kind !== 'theme' || effective.id !== `${theme}-${variant}`) throw new Error('Pi effective theme/variant mismatch');
  if (!sample.client.enabled || sample.client.provider.availability !== 'ready') throw new Error('Pi native highlighting is unavailable');
  const preparation = sample.preparations?.findLast(item => item.call === call && item.phase === 'prepared');
  if (!preparation?.sourceEligible || preparation.applied !== true) throw new Error('Pi full-card preparation has not completed');
  const views = sample.views?.filter(view => view.kind === 'file' && view.path === fixture.filename) ?? [];
  if (views.length !== 1 || !views[0].accepted || views[0].preview || views[0].omitted || views[0].error || views[0].origin !== 'owned') throw new Error('Pi full owned card paint is unavailable');
  const view = views[0], palette = `theme:${effective.id}:${effective.fingerprint}:${view.mode}`;
  if (fixture.kind === 'source') {
    const sources = view.sources ?? [], bytes = Buffer.byteLength(fixture.content);
    if (sources.length !== 1 || !sources.every(source => source.complete && source.basisAccepted && source.rangesAccepted
      && source.textSha256 === fixture.sha256 && source.source?.sha256 === fixture.sha256 && source.source.bytes === bytes
      && source.source.complete && source.source.version === source.version && source.status?.exact && source.status.complete
      && source.status.availability === 'ready' && !source.status.protective && source.status.execution === 'acknowledged'
      && source.display?.complete && (source.display.version === source.version || source.display.exactVersion === source.version)
      && source.display.palette === palette)) throw new Error('Pi current full-source native paint is incomplete or mismatched');
    for (const source of sources) {
      let end = 0;
      for (const range of source.ranges ?? []) {
        if (!Array.isArray(range) || range.length !== 2 || !range.every(Number.isSafeInteger) || range[0] < end || range[1] <= range[0] || range[1] > bytes) throw new Error('Invalid Pi paint byte ranges');
        end = range[1];
      }
    }
  }
  return { status: 'ready', method: 'producer-settle-frame-and-current-compiled-paint-borrow',
    preparationSemantics: 'Request-time outcomes are history, not final paint authority.', sample };
}

export function savedPiSession(directory, fixture) {
  mkdirSync(directory, { recursive: true });
  const manager = SessionManager.create(directory, join(directory, 'sessions'));
  manager.appendModelChange('tidy-ui-offline', 'scripted'); manager.appendThinkingLevelChange('off');
  const call = 'hc-' + fixture.id, name = fixture.kind === 'source' ? 'write' : 'edit';
  const args = name === 'write' ? { path: fixture.filename, content: fixture.content }
    : { path: fixture.filename, oldText: fixture.before, newText: fixture.after };
  const details = name === 'write' ? {} : { diff: fixture.logicalRows.map(row => {
    const sign = row.role === 'added' ? '+' : row.role === 'removed' ? '-' : ' ';
    // Stock numbered metadata stores context in old-file coordinates; its presenter applies the delta.
    return `${sign}${row.role === 'added' ? row.newLine : row.oldLine} ${row.text}`;
  }).join('\n') };
  const now = 1760000000000;
  manager.appendMessage({ role: 'user', content: [{ type: 'text', text: `Saved comparison input: ${fixture.id}` }], timestamp: now });
  manager.appendMessage({ role: 'assistant', content: [{ type: 'toolCall', id: call, name, arguments: args }],
    api: 'openai-completions', provider: 'tidy-ui-offline', model: 'scripted', usage, stopReason: 'toolUse', timestamp: now });
  manager.appendMessage({ role: 'toolResult', toolCallId: call, toolName: name,
    content: [{ type: 'text', text: 'Saved successful comparison result.' }], details, isError: false, timestamp: now });
  return { file: manager.getSessionFile(), call, args, details };
}

export async function collectPi({ inputs, fixture, theme, variant, dimensions, output }) {
  const helper = validateNative(inputs), colocated = join(root, process.platform === 'win32' ? 'occipital.exe' : 'occipital');
  if (!existsSync(colocated)) { copyFileSync(helper.path, colocated); chmodSync(colocated, 0o700); }
  if (digest(readFileSync(colocated)) !== helper.sha256) throw new Error('Prepared colocated helper differs from admitted native bytes');
  mkdirSync(output, { recursive: true });
  const saved = savedPiSession(join(output, 'native-session'), fixture), original = readFileSync(saved.file);
  const terminal = new PiTerminal(`highlight-${fixture.id}-${process.pid}`, { session: saved.file, mode: 'fullscreen', dimensions,
    seedFixtures: false, extensions: [join(root, 'scripts/highlight-compare/adapters/pi-observer.ts')],
    tidyUiSettings: { syntaxTheme: { kind: 'theme', id: theme }, syntaxThemeVariant: variant } });
  const controls = [], send = terminal.send.bind(terminal);
  terminal.send = data => { controls.push({ sequence: controls.length, base64: Buffer.from(data).toString('base64') }); send(data); };
  const pages = [];
  let failure;
  try {
    await terminal.ready();
    const capture = await terminal.captureSettled('full', { action: async () => terminal.send('\x0f') });
    writeFileSync(join(output, 'native-readiness.json'), JSON.stringify({ sample: capture.sample, receipt: capture.receipt }, null, 2), { flag: 'wx' });
    let readiness = validatePiReadiness(capture.sample, fixture, theme, variant, saved.call), diffMap;
    pages.push({ screen: capture.screen, cells: capture.cells, width: dimensions.columns, rows: dimensions.rows, receipt: capture.receipt });
    if (fixture.kind === 'diff') {
      diffMap = mapPiDiffView(fixture, pages);
      await verifyPiDiffPaint(fixture, pages, diffMap, readiness);
      const alternate = dimensions.columns === 240 ? dimensions.columns - 1 : dimensions.columns + 1;
      await terminal.captureSettled('diff-resize-away', { action: async () => terminal.resize(alternate, dimensions.rows) });
      const repeated = await terminal.captureSettled('diff-repeat-full', { action: async () => terminal.resize(dimensions.columns, dimensions.rows) });
      const current = validatePiReadiness(repeated.sample, fixture, theme, variant, saved.call);
      pages.push({ screen: repeated.screen, cells: repeated.cells, width: dimensions.columns, rows: dimensions.rows, receipt: repeated.receipt });
      const repeatedMap = mapPiDiffView(fixture, [pages.at(-1)]);
      if (repeatedMap.viewIdentity !== diffMap.viewIdentity) throw new Error('Pi repeated native diff view changed');
      diffMap = mapPiDiffView(fixture, pages);
      readiness = await verifyPiDiffPaint(fixture, pages, diffMap, current);
      readiness.diff.repeatedFrame = repeated.receipt;
    }
    if (terminal.events().some(event => ['call', 'result', 'model_context'].includes(event.type))) throw new Error('Saved comparison unexpectedly executed tools or submitted model traffic');
    await terminal.quit();
    if (digest(readFileSync(saved.file)) !== digest(original)) throw new Error('Pi changed the saved session during comparison');
    return { pages, readiness, ...(diffMap ? { diffMap } : {}), effectiveTheme: { family: theme, variant, evidence: readiness.sample.client.effective },
      runtimeAssets: [{ path: helper.path, sha256: helper.sha256, bytes: helper.bytes, nativeTree: helper.nativeTree }] };
  } catch (error) { failure = error; throw error; }
  finally {
    try { await terminal.close(); }
    catch (error) { if (failure) throw new AggregateError([failure, error], 'Pi capture and cleanup failed'); throw error; }
    finally {
      try {
        cpSync(terminal.output, join(output, 'terminal'), { recursive: true, errorOnExist: true, force: false });
        writeFileSync(join(output, 'controls.json'), JSON.stringify(controls, null, 2));
      } finally { terminal.dispose(); rmSync(terminal.output, { recursive: true, force: true }); }
    }
  }
}
