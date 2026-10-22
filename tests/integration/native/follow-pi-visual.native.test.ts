import '../../fixtures/test-guard.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile, writeFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { setImmediate as turn } from 'node:timers/promises';
import { getThemeByName } from '../../../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js';
import { SourceController } from '../../../src/occipital/controller.ts';
import { ProviderBroker } from '../../../src/occipital/provider.ts';
import { StdioTransport } from '../../../src/occipital/stdio.ts';
import { createPiRuleDefinition, PI_RULE_BINDINGS } from '../../../src/syntax/pi-rules.ts';
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
const parents = { headingMarker: 'mdHeading', stringDelimiter: 'syntaxString', inlineCodeDelimiter: 'mdCode', linkDelimiter: 'mdLink' } as const;
const baseline: RuleDefinition = JSON.parse(await readFile(new URL('../../fixtures/follow-pi-baseline-rules.json', import.meta.url), 'utf8'));
const baselineHeadingForeground = baseline.rules.find(rule => rule.path.includes('markup.heading'))?.foreground;
if (baselineHeadingForeground?.kind !== 'binding') throw new Error('baseline Markdown heading must use a direct binding');
assert.equal(baselineHeadingForeground.slot, PI_RULE_BINDINGS.indexOf('mdHeading'), 'the frozen baseline colors heading markers with the authored title role');

test('Follow Pi early whole-source comparison: baseline, same-parent and role-specific colors across actual retained contexts', { timeout: 30000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'pi-palette-visual-'));
  const pipe = new StdioTransport({ command: binary.path, args: ['--stdio', '--config', join(root, 'config.json')], cwd: root,
    env: { ...process.env, HOME: root, XDG_CONFIG_HOME: root, XDG_DATA_HOME: root, XDG_CACHE_HOME: root, XDG_RUNTIME_DIR: root }, requestDeadlineMs: 5000, terminateGraceMs: 100 });
  const broker = new ProviderBroker({ async tryShared() { return undefined; }, async acquireOwned() { return pipe; } });
  const owner = new SourceController(broker, { deadlineMs: 5000 });
  const output = resolve('.test-artifacts/follow-pi-visual'); await mkdir(output, { recursive: true });
  const definition = createPiRuleDefinition();
  let revision = 0;
  const drain = async (ready: () => boolean) => {
    let active = true;
    try { await awaitFixture((async () => {
      for (; active && (!ready() || owner.stats().unsettledJobs);) { owner.flush(); await turn(); }
    })(), 10000); } finally { active = false; }
  };
  try {
    await awaitFixture(broker.start());
    for (const item of corpus) owner.observe({ key: item.id, version: 1, language: item.language, profile: 'pi', fingerprint: 'a'.repeat(64), text: item.source, complete: true });
    for (const name of ['dark', 'light', 'gruvbox', 'saturated', 'monochrome', 'low-contrast', 'terminal-default', 'mixed-foreground', 'faint', 'faint-donor', 'faint-parent']) {
      for (const mode of ['truecolor', '256color'] as const) {
        const theme = name === 'dark' || name === 'light' ? getThemeByName(name)! : followPiTheme(name, mode, getThemeByName('dark')!);
        const prepared = samplePiPalette(theme, mode), direct = samplePiBindings(theme);
        const variants = name === 'gruvbox' && mode === 'truecolor'
          ? ['baseline', 'same-parent', 't2-heading', 'role-specific'] as const
          : ['baseline', 'same-parent', 'role-specific'] as const;
        const t2Bindings = [...prepared.bindings];
        if (name === 'gruvbox' && mode === 'truecolor')
          t2Bindings[PI_RULE_BINDINGS.indexOf('headingMarker')] = Object.freeze({
            ...t2Bindings[PI_RULE_BINDINGS.indexOf('headingMarker')]!,
            ink: samplePiPrefix('\u001b[38;2;152;183;171m').ink,
          });
        const sameParent = [...direct];
        for (const [name, parent] of Object.entries(parents)) sameParent[PI_RULE_BINDINGS.indexOf(name as keyof typeof parents)] = direct[PI_RULE_BINDINGS.indexOf(parent)]!;
        for (const variant of variants) {
          const rules = variant === 'baseline' ? baseline : definition;
          const bindings = variant === 'baseline' ? sameParent.slice(0, rules.binding_slots)
            : variant === 'same-parent' ? sameParent
            : variant === 't2-heading' ? t2Bindings : prepared.bindings;
          if (variant === 'same-parent') for (const [name, parent] of Object.entries(parents))
            assert.deepEqual(bindings[PI_RULE_BINDINGS.indexOf(name as keyof typeof parents)], direct[PI_RULE_BINDINGS.indexOf(parent)], `${name} comparison uses its own exact parent binding`);
          if (variant === 'role-specific') for (const decision of prepared.variantDecisions) {
            const actual = bindings[PI_RULE_BINDINGS.indexOf(decision.binding)];
            const parent = direct[PI_RULE_BINDINGS.indexOf(parents[decision.binding])];
            const expectedInk = decision.status === 'derived' ? decision.emittedInk : parent?.ink;
            assert.deepEqual(actual?.ink, expectedInk, `${decision.binding} comparison uses the prepared role-specific result`);
            assert.equal(actual?.attributes, parent?.attributes, `${decision.binding} keeps its semantic parent's typography`);
            assert.equal(actual?.attribute_mask, parent?.attribute_mask, `${decision.binding} keeps its semantic parent's attribute mask`);
          }
          if (variant === 't2-heading') {
            const heading = PI_RULE_BINDINGS.indexOf('headingMarker');
            assert.deepEqual(t2Bindings[heading]?.ink, samplePiPrefix('\u001b[38;2;152;183;171m').ink, 'the T2 control retains its frozen weak Gruvbox heading ink');
            assert.deepEqual(bindings[heading]?.ink, t2Bindings[heading]?.ink);
          }
          const activeBindings = bindings.map((binding, slot) => ({ slot, role: PI_RULE_BINDINGS[slot], ink: binding.ink,
            attributes: binding.attributes, attributeMask: binding.attribute_mask }));
          const before = broker.stats(), publications = owner.stats().stylePublications;
          const fingerprint = fingerprintRules(rules);
          assert.equal(owner.setStyleSelection({ kind: 'client', definition: rules, bindingRevision: ++revision,
            palette: `visual:${revision}`, bindings, roles: prepared.roles }), true);
          await drain(() => owner.stats().stylePublications >= publications + corpus.length
            && corpus.every(item => owner.displayBasis(item.id)?.fingerprint === fingerprint));
          const sections = corpus.map(item => {
            const ranges: { from: number; to: number; foreground: unknown; background: unknown; attributes: number; ansi: ReturnType<typeof compileStyleAnsi> }[] = [];
            owner.displayBasis(item.id)!.visit((source, spans) => {
              assert.equal(source, item.source);
              spans((from, to, style) => ranges.push({ from, to, foreground: style.foreground, background: style.background, attributes: style.attributes, ansi: compileStyleAnsi(style, mode) }));
            });
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
    assert.equal(broker.stats().sourceDispatches, corpus.length);
    console.log(JSON.stringify({ followPiEarlyVisual: { output, publications: owner.stats().stylePublications,
      comparisons: revision, sourceDispatches: broker.stats().sourceDispatches, styleDispatches: broker.stats().styleDispatches,
      sourceBytes: corpus.reduce((sum, item) => sum + Buffer.byteLength(item.source), 0), nativeSha256: binary.sha256 } }));
  } finally { owner.dispose(); await awaitFixture(broker.dispose()); await rm(root, { recursive: true, force: true }); }
  assert.equal(owner.stats().retention.retainedBytes, 0); assert.equal(owner.stats().globalTransientBytes, 0);
  assert.equal(pipe.stats().childState, 'exited'); assert.equal(pipe.stats().ownedListeners, 0);
});
