import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { readInputs, toolPath } from '../test/context.mjs';
import { compareCaptures, digest, normalizeSource, renderReport } from './model.mjs';
import { compareDiffCaptures, normalizeDiff } from './diff.mjs';
import { renderDiffReport } from './report.mjs';
import { renderTerminalExcerpts } from './excerpts.mjs';
import { loadFixtures, prepareDiff } from './fixtures.mjs';
import { mapNumberedSource } from './alignment.mjs';
import { adapters } from './adapters/index.mjs';
const save = (path, value) => writeFileSync(path, JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
const readJson = path => JSON.parse(readFileSync(path, 'utf8'));

export async function execute(options, inputs = readInputs()) {
  const output = options.output;
  if (options.command === 'compare') {
    const left = readJson(options.left), right = readJson(options.right), diff = left.fixture?.kind === 'diff';
    const report = diff ? compareDiffCaptures(left, right) : compareCaptures(left, right);
    const ansi = renderTerminalExcerpts(report);
    save(join(output, 'comparison.json'), report);
    writeFileSync(join(output, 'comparison.md'), diff ? renderDiffReport(report) : renderReport(report), { flag: 'wx' });
    writeFileSync(join(output, 'comparison.ansi'), ansi, { flag: 'wx' });
    return;
  }
  const corpus = loadFixtures(join(inputs.pi.root, 'tests/fixtures/highlight-compare'));
  if (options.command === 'fixtures') { save(join(output, 'fixtures.json'), corpus); return; }
  const registration = adapters[options.adapter], implementation = await registration.load();
  if (options.command === 'prepare') {
    const prepared = await implementation[registration.prepare]({ inputs, binary: options.binary, output,
      theme: options.theme, variant: options.variant });
    save(join(output, 'prepared.json'), prepared);
    return;
  }
  let fixture = corpus.fixtures.find(value => value.id === options.fixture);
  if (!fixture) throw new Error('Unknown fixture: ' + options.fixture);
  if (fixture.kind === 'diff') fixture = prepareDiff(fixture, join(output, 'diff-input'), toolPath('git', inputs), process.env);
  save(join(output, 'fixture.json'), fixture);
  const raw = await implementation[registration.collect]({ inputs, binary: options.binary,
    prepared: options.prepared ? readJson(options.prepared) : undefined, fixture, theme: options.theme, variant: options.variant,
    dimensions: { columns: options.columns, rows: options.rows }, output });
  save(join(output, 'pages.json'), raw.pages);
  save(join(output, 'readiness.json'), raw.readiness);
  if (fixture.kind === 'diff' && raw.diffMap) save(join(output, 'diff-map.json'), raw.diffMap);
  if (raw.readiness?.status !== 'ready') throw new Error('Adapter did not establish ready highlighting or structural surfaces');
  let normalized, mapping;
  if (fixture.kind === 'diff') {
    normalized = normalizeDiff(fixture, raw.pages, raw.diffMap);
    mapping = { diffMap: { path: 'diff-map.json', sha256: digest(readFileSync(join(output, 'diff-map.json'))) } };
  } else {
    const alignment = raw.sourceMap ?? mapNumberedSource(fixture.content, raw.pages, { tabSize: raw.tabSize ?? 4, tabMode: raw.tabMode ?? 'stops' });
    save(join(output, 'source-map.json'), alignment);
    normalized = normalizeSource(fixture.content, raw.pages, alignment.maps, { tabSize: alignment.tabSize, tabMode: alignment.tabMode });
    mapping = { sourceMap: { path: 'source-map.json', sha256: digest(readFileSync(join(output, 'source-map.json'))) } };
  }
  save(join(output, 'capture.json'), { ...normalized, schema: 1, status: 'ready', application: options.adapter,
    fixture: { id: fixture.id, kind: fixture.kind, sha256: fixture.sha256, manifestSha256: corpus.manifestSha256, cases: fixture.cases },
    source: fixture.content, theme: { family: options.theme, variant: options.variant },
    effectiveTheme: raw.effectiveTheme, readiness: raw.readiness, runtimeAssets: raw.runtimeAssets,
    identity: { application: raw.identity, source: inputs.source, node: inputs.node.version, pi: inputs.pi.version,
      hostLockSha256: inputs.pi.lockSha256, nativeSha256: inputs.native?.sha256 },
    terminal: { columns: options.columns, rows: options.rows, term: 'xterm-256color', color: 'truecolor' },
    evidence: { pages: { path: 'pages.json', sha256: digest(readFileSync(join(output, 'pages.json'))) },
      ...mapping } });
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const options = readJson(process.argv[2]);
  try {
    await execute(options);
    console.log(join(options.output, { collect: 'capture.json', prepare: 'prepared.json', compare: 'comparison.json', fixtures: 'fixtures.json' }[options.command]));
  } catch (error) {
    save(join(options.output, 'failure.json'), { schema: 1, status: 'failed', name: error.name, message: String(error.message).slice(0, 4000) });
    throw error;
  }
}
