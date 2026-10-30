import '../../fixtures/test-guard.mjs';
import { createSemanticRuleDefinition } from '../../../src/syntax/semantic-rules.ts';
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile, writeFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { getThemeByName } from '../../../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js';
import { SourceController } from '../../../src/occipital/controller.ts';
import { ProviderBroker } from '../../../src/occipital/provider.ts';
import { StdioTransport } from '../../../src/occipital/stdio.ts';
import { PI_MARKER_REGIONS, PI_RULE_BINDINGS, type PiMarkerBinding } from '../../../src/syntax/pi-adapter.ts';
import { samplePiBindings, samplePiPrefix } from '../../../src/syntax/pi-bindings.ts';
import { samplePiPalette } from '../../../src/syntax/pi-palette.ts';
import { compileStyleAnsi } from '../../../src/syntax/style-ansi.ts';
import { fingerprintRules, type RuleDefinition } from '../../../src/occipital/style-rules.ts';
import { readInputs, validateNative } from '../../../scripts/test/context.mjs';
import { awaitFixture } from '../../fixtures/await-fixture.ts';
import { followPiTheme } from '../../fixtures/follow-pi-themes.ts';
import { followPiScreenshotText, followPiText } from '../../fixtures/follow-pi-source.ts';

const inputs = readInputs(), binary = validateNative(inputs);
const corpus: { id: string; language: string; source: string }[] = JSON.parse(await readFile(new URL('../../../crates/occipital/tests/fixtures/follow_pi_corpus.json', import.meta.url), 'utf8'));
corpus.push({ id: 'role-combinations', language: 'markdown', source: followPiText });
corpus.push({ id: 'operator-screenshot-excerpt', language: 'markdown', source: followPiScreenshotText });
const parents = { headingMarker: 'markdown-heading', stringDelimiter: 'syntax-string', inlineCodeDelimiter: 'markdown-code', linkDelimiter: 'markdown-link-text' } as const;
const slot = (region: typeof PI_RULE_BINDINGS[number]) => PI_RULE_BINDINGS.indexOf(region);
const markerSlot = (binding: PiMarkerBinding) => slot(PI_MARKER_REGIONS[binding]);
const baseline: RuleDefinition = JSON.parse(await readFile(new URL('../../fixtures/follow-pi-baseline-rules.json', import.meta.url), 'utf8'));
const baselineHeadingForeground = baseline.rules.find(rule => rule.path.includes('markup.heading'))?.foreground;
if (baselineHeadingForeground?.kind !== 'binding') throw new Error('baseline Markdown heading must use a direct binding');
assert.equal(baselineHeadingForeground.slot, slot('markdown-heading'), 'the frozen baseline keeps heading content on the common semantic slot');

test('Follow Pi early whole-source comparison: baseline, same-parent and role-specific colors across actual retained contexts', { timeout: 30000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'pi-palette-visual-'));
  const pipe = new StdioTransport({ command: binary.path, args: ['--stdio'], cwd: root,
    env: { ...process.env, HOME: root, XDG_CONFIG_HOME: root, XDG_DATA_HOME: root, XDG_CACHE_HOME: root, XDG_RUNTIME_DIR: root }, requestDeadlineMs: 5000, terminateGraceMs: 100 });
  const nativeRequest = pipe.request.bind(pipe);
  let dataTail: Promise<void> = Promise.resolve();
  let queuedData = 0, activeData = 0, peakQueuedData = 0, peakActiveData = 0, startedData = 0, admittedData = 0, peakTransportData = 0;
  // Palette comparisons measure completed output, not competing for bounded DATA admission.
  pipe.request = (frame, options) => {
    if (frame.op === 'describe') return nativeRequest(frame, options);
    queuedData++; peakQueuedData = Math.max(peakQueuedData, queuedData);
    const current = dataTail.then(async () => {
      queuedData--; activeData++; startedData++;
      peakActiveData = Math.max(peakActiveData, activeData);
      try {
        const response = nativeRequest(frame, options);
        const transportPending = pipe.stats().unsettledData;
        peakTransportData = Math.max(peakTransportData, transportPending);
        if (transportPending > 0) admittedData++;
        return await response;
      } finally { activeData--; }
    });
    dataTail = current.then(() => undefined, () => undefined);
    return current;
  };
  const broker = new ProviderBroker({ async tryShared() { return undefined; }, async acquireOwned() { return pipe; } });
  const owner = new SourceController(broker, { deadlineMs: 5000 });
  const output = resolve('.test-artifacts/follow-pi-visual'); await mkdir(output, { recursive: true });
  const definition = createSemanticRuleDefinition();
  let revision = 0;
  try {
    await awaitFixture(broker.start());
    for (const item of corpus) owner.observe({ key: item.id, version: 1, language: item.language, text: item.source, complete: true });
    for (const name of ['dark', 'light', 'gruvbox', 'saturated', 'monochrome', 'low-contrast', 'terminal-default', 'mixed-foreground', 'faint', 'faint-donor', 'faint-parent']) {
      for (const mode of ['truecolor', '256color'] as const) {
        const theme = name === 'dark' || name === 'light' ? getThemeByName(name)! : followPiTheme(name, mode, getThemeByName('dark')!);
        const prepared = samplePiPalette(theme, mode), direct = samplePiBindings(theme);
        const variants = name === 'gruvbox' && mode === 'truecolor'
          ? ['baseline', 'same-parent', 't2-heading', 'role-specific'] as const
          : ['baseline', 'same-parent', 'role-specific'] as const;
        const t2Bindings = [...prepared.bindings];
        if (name === 'gruvbox' && mode === 'truecolor')
          t2Bindings[markerSlot('headingMarker')] = Object.freeze({
            ...t2Bindings[markerSlot('headingMarker')]!,
            ink: samplePiPrefix('\u001b[38;2;152;183;171m').ink,
          });
        const sameParent = [...direct];
        for (const [name, parent] of Object.entries(parents)) sameParent[markerSlot(name as keyof typeof parents)] = direct[slot(parent)]!;
        for (const variant of variants) {
          const rules = variant === 'baseline' ? baseline : definition;
          const bindings = variant === 'baseline' ? sameParent.slice(0, rules.binding_slots)
            : variant === 'same-parent' ? sameParent
            : variant === 't2-heading' ? t2Bindings : prepared.bindings;
          if (variant === 'same-parent') for (const [name, parent] of Object.entries(parents))
            assert.deepEqual(bindings[markerSlot(name as keyof typeof parents)], direct[slot(parent)], `${name} comparison uses its own exact parent binding`);
          if (variant === 'role-specific') for (const decision of prepared.variantDecisions) {
            const actual = bindings[markerSlot(decision.binding)];
            const parent = direct[PI_RULE_BINDINGS.indexOf(parents[decision.binding])];
            const expectedInk = decision.status === 'derived' ? decision.emittedInk : parent?.ink;
            assert.deepEqual(actual?.ink, expectedInk, `${decision.binding} comparison uses the prepared role-specific result`);
            assert.equal(actual?.attributes, parent?.attributes, `${decision.binding} keeps its semantic parent's typography`);
            assert.equal(actual?.attribute_mask, parent?.attribute_mask, `${decision.binding} keeps its semantic parent's attribute mask`);
          }
          if (variant === 't2-heading') {
            const heading = markerSlot('headingMarker');
            assert.deepEqual(t2Bindings[heading]?.ink, samplePiPrefix('\u001b[38;2;152;183;171m').ink, 'the T2 control retains its frozen weak Gruvbox heading ink');
            assert.deepEqual(bindings[heading]?.ink, t2Bindings[heading]?.ink);
          }
          const activeBindings = bindings.map((binding, slot) => ({ slot, role: PI_RULE_BINDINGS[slot], ink: binding.ink,
            attributes: binding.attributes, attributeMask: binding.attribute_mask }));
          const before = broker.stats(), publications = owner.stats().stylePublications;
          const fingerprint = fingerprintRules(rules), phase = `${name}/${mode}/${variant}`;
          const palette = `visual:${++revision}`;
          assert.equal(owner.setStyleSelection({ definition: rules, bindingRevision: revision,
            palette, bindings, roles: prepared.roles }), true);
          const settled = await awaitFixture(owner.whenSettled(), 10000).catch(cause => {
            throw new Error(`${phase}: controller did not settle; ${JSON.stringify(owner.stats())}`, { cause });
          });
          assert.equal(settled, true, `${phase}: cancelled work is not a completed comparison`);
          assert.ok(owner.stats().stylePublications >= publications + corpus.length, `${phase}: every corpus entry publishes`);
          const sections = corpus.map(item => {
            const label = `${phase}/${item.id}`, basis = owner.displayBasis(item.id);
            assert.ok(basis, `${label}: a current display exists`);
            assert.equal(basis.palette, palette, `${label}: current palette`);
            assert.equal(basis.rules, fingerprint, `${label}: current rules`);
            assert.equal(basis.bindingRevision, revision, `${label}: current bindings`);
            assert.equal(basis.complete, true, `${label}: complete source`);
            assert.equal(basis.exactVersion, 1, `${label}: exact observed source version`);
            const ranges: { from: number; to: number; foreground: unknown; background: unknown; attributes: number; ansi: ReturnType<typeof compileStyleAnsi> }[] = [];
            assert.equal(basis.visit((source, spans) => {
              assert.equal(source, item.source, `${label}: exact source text`);
              assert.equal(spans((from, to, style) => ranges.push({ from, to, foreground: style.foreground, background: style.background, attributes: style.attributes, ansi: compileStyleAnsi(style, mode) })), true,
                `${label}: complete range visit`);
            }), true, `${label}: display reader remains valid`);
            return { ...item, ranges };
          });
          const roleSpecificCandidateDecisions = variant === 't2-heading' ? prepared.variantDecisions.map(item => item.binding === 'headingMarker'
            ? { binding: item.binding, status: 'historical-reference', reason: 'frozen weak T2 Gruvbox screenshot ink #98b7ab' }
            : item) : prepared.variantDecisions;
          await writeFile(join(output, `${name}-${mode}-${variant}.json`), JSON.stringify({ name, mode, variant,
            activeBindings, roleSpecificCandidateDecisions, panelAnsi: compileStyleAnsi(prepared.roles.code, mode), sections }));
          const after = broker.stats();
          if (revision > 1) assert.equal(after.sourceDispatches, before.sourceDispatches, 'all comparison palettes reuse retained SOURCE');
          if (variant === 'role-specific') assert.equal(after.styleDispatches, before.styleDispatches, 'role-specific inks are only a local rebind');
        }
      }
    }
    await dataTail;
    const transport = pipe.stats(), provider = broker.stats();
    const dataDispatches = provider.sourceDispatches + provider.styleDispatches;
    assert.equal(broker.stats().sourceDispatches, corpus.length);
    assert.equal(queuedData, 0); assert.equal(activeData, 0); assert.equal(transport.unsettledData, 0);
    assert.ok(peakQueuedData <= 2, 'fixture queue stays within the controller DATA job window');
    assert.equal(peakActiveData, 1); assert.equal(peakTransportData, 1);
    assert.equal(admittedData, startedData, 'every wrapped DATA request reaches transport admission');
    assert.equal(startedData, dataDispatches, 'fixture forwards every broker DATA dispatch');
    console.log(JSON.stringify({ followPiEarlyVisual: { output, publications: owner.stats().stylePublications,
      comparisons: revision, sourceDispatches: provider.sourceDispatches, styleDispatches: provider.styleDispatches,
      dataAdmission: { started: startedData, admitted: admittedData, peakQueued: peakQueuedData,
        peakActive: peakActiveData, peakTransportUnsettled: peakTransportData, settled: queuedData === 0 && activeData === 0 },
      sourceBytes: corpus.reduce((sum, item) => sum + Buffer.byteLength(item.source), 0), nativeSha256: binary.sha256 } }));
  } finally {
    owner.dispose();
    await awaitFixture(Promise.all([dataTail, broker.dispose()]));
    await rm(root, { recursive: true, force: true });
  }
  assert.equal(owner.stats().retention.retainedBytes, 0); assert.equal(owner.stats().globalTransientBytes, 0);
  assert.equal(pipe.stats().childState, 'exited'); assert.equal(pipe.stats().ownedListeners, 0);
});
