import '../../fixtures/test-guard.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { changelogPaths, parseChangelog, releaseNotes, extensionChangelog, loadChangelog } from '../../../scripts/release/changelog.mjs';

const repository = 'https://github.com/chpock/pi-tidy-ui';
const unreleased = '## [Unreleased]\n\n';
const entry = (version, body = '- A user-visible change.', date = '2026-11-03') => `## [${version}] - ${date}\n\n${body}\n`;
const history = (...entries) => '# Changelog\n\nIntroductory prose.\n\n' + unreleased + entries.join('\n');
const dependency = version => `### Occipital dependency\n\nThis release packages Occipital [${version}](${repository}/releases/tag/occipital-v${version}). Shared services are selected by protocol compatibility, not by this packaged version.\n`;

test('parseChangelog preserves Unicode and exact entry Markdown while normalizing line endings', () => {
  const current = entry('2.0.0', '### Added\n\n- Привет, 世界 👋.\n\n[Details](https://example.com/change)');
  const older = entry('1.0.0', '- Earlier change.').trimEnd();
  const parsed = parseChangelog(history(current, older).replaceAll('\n', '\r\n'));
  assert.deepEqual(parsed, [
    { version: 'Unreleased', date: null, markdown: unreleased },
    { version: '2.0.0', date: '2026-11-03', markdown: current + '\n' },
    { version: '1.0.0', date: '2026-11-03', markdown: older + '\n' },
  ]);
  assert.equal(parseChangelog(unreleased)[0].markdown, unreleased);
  assert.equal(parseChangelog(history(entry('1.0.0')).replaceAll('\n', '\r'))[1].markdown, entry('1.0.0'));
});

test('parseChangelog requires exactly one first Unreleased entry', () => {
  for (const text of ['', '# Changelog\n', entry('1.0.0'), unreleased + unreleased, entry('1.0.0') + unreleased]) {
    assert.throws(() => parseChangelog(text), /Unreleased/i);
  }
});

test('parseChangelog accepts full SemVer precedence, including unbounded numeric components', () => {
  const versions = [
    '999999999999999999999999.0.0', '999999999999999999999998.99.99',
    '10.0.0', '2.100000000000000000000.0', '2.99999999999999999999.999',
    '2.0.100000000000000000000', '2.0.99999999999999999999',
    '1.0.0', '1.0.0-rc.100000000000000000000', '1.0.0-rc.99999999999999999999',
    '1.0.0-rc.10', '1.0.0-rc.2', '1.0.0-rc', '1.0.0-beta.a', '1.0.0-beta.10', '1.0.0-alpha-beta.10', '1.0.0-alpha-beta.2', '1.0.0-alpha',
  ];
  assert.deepEqual(parseChangelog(history(...versions.map(version => entry(version)))).slice(1).map(item => item.version), versions);
});

test('parseChangelog rejects duplicates and non-descending full SemVer', () => {
  for (const versions of [
    ['1.0.0', '1.0.0'], ['1.0.0-rc.2', '1.0.0-rc.10'], ['1.0.0-rc.10', '1.0.0'],
    ['1.0.0-rc', '1.0.0-rc.1'], ['1.0.0-9', '1.0.0-a'], ['1.0.0-a', '1.0.0-b'],
    ['999999999999999999999998.0.0', '999999999999999999999999.0.0'],
  ]) assert.throws(() => parseChangelog(history(...versions.map(version => entry(version)))), /duplicate|descending/i);
});

test('parseChangelog validates Gregorian dates without calendar rollover', () => {
  for (const date of ['2024-02-29', '2000-02-29', '2026-04-30', '0001-01-01']) {
    assert.equal(parseChangelog(history(entry('1.0.0', '- Change.', date)))[1].date, date);
  }
  for (const date of ['2026-02-29', '1900-02-29', '2024-02-30', '2026-04-31', '2026-00-01', '2026-13-01', '2026-01-00', '0000-01-01', '2026-2-01']) {
    assert.throws(() => parseChangelog(history(entry('1.0.0', '- Change.', date))), /date|heading/i);
  }
});

test('parseChangelog rejects malformed, unknown and unpublishable H2 headings', () => {
  for (const heading of [
    '## Added', '##', '## Unreleased', '## [unreleased]', '## [Unreleased] - 2026-11-03',
    '## [1.0.0]', '## 1.0.0 - 2026-11-03', '## [v1.0.0] - 2026-11-03',
    '## [1.0] - 2026-11-03', '## [01.0.0] - 2026-11-03', '## [1.0.0-rc.01] - 2026-11-03',
    '## [0.0.0] - 2026-11-03', '## [1.0.0+build] - 2026-11-03',
    ' ## [1.0.0] - 2026-11-03', '## [1.0.0] - 2026-11-03 ###',
    '## [1.0.0] - 2026-11-03 trailing',
  ]) assert.throws(() => parseChangelog(unreleased + heading + '\n\n- Change.\n'), /heading|version|SemVer/i, heading);
  assert.throws(() => parseChangelog('## Introduction\n\n' + unreleased), /heading/i);
  assert.throws(() => parseChangelog(history(entry('1.0.0', '- Change.\n\n## Added\n\n- More.'))), /heading/i);
});

test('parseChangelog requires meaningful released bodies but permits empty Unreleased', () => {
  for (const body of ['', ' \t\n', '### Added\n\n', '<!-- pending -->', '-\n\n---\n\n>\n', '```js\n```',
    '> ### Added', '> ---', '> ### Added\n>\n> ---']) {
    assert.throws(() => parseChangelog(history(entry('1.0.0', body))), /body|empty|meaningful/i);
  }
  assert.equal(parseChangelog(unreleased).length, 1);
  assert.equal(parseChangelog(history(entry('1.0.0', '```js\nconst value = 1;\n```'))).length, 2);
  assert.equal(parseChangelog(history(entry('1.0.0', '```html\n<!-- actual code -->\n```'))).length, 2);
  const quoted = entry('1.0.0', '> A real compatibility change.');
  assert.equal(parseChangelog(history(quoted))[1].markdown, quoted);
});

test('parseChangelog ignores headings in correctly matched backtick and tilde fences', () => {
  const body = '- Change.\n\n````markdown\n## Not a version\n```\n### Occipital dependency\n`````\n\n   ~~~ markdown\n## [7.0.0] - 2026-01-01\n~~~not-a-close\n   ~~~~\n';
  const current = entry('1.0.0', body);
  assert.equal(parseChangelog(history(current))[1].markdown, current);
  assert.equal(parseChangelog('```md\n## Intro in code\n```\n' + unreleased).length, 1);
  assert.throws(() => parseChangelog(history(entry('1.0.0', '```bad`info\n## Not fenced'))), /heading/i);
});

test('parseChangelog rejects unclosed and mismatched fences, including intro fences', () => {
  for (const text of [
    history(entry('1.0.0', '- Change.\n\n```js\nvalue')), history(entry('1.0.0', '- Change.\n\n~~~\nvalue\n```')),
    history(entry('1.0.0', '````\nvalue\n```')), '```md\n' + unreleased,
  ]) assert.throws(() => parseChangelog(text), /fence/i);
});

test('authored Occipital dependency headings are reserved outside code, including in Unreleased', () => {
  for (const heading of ['### Occipital dependency', '### Occipital dependency ###', '### occipital dependency']) {
    assert.throws(() => parseChangelog(history(entry('1.0.0', heading + '\n\n- Authored footer.'))), /reserved|dependency/i);
    assert.throws(() => parseChangelog(unreleased + heading + '\n\n- Future.\n'), /reserved|dependency/i);
  }
});

test('releaseNotes selects exactly one released entry without its neighbors or intro', () => {
  const current = entry('1.0.0', '- Current.\n\n[Absolute](https://example.com/current)');
  const text = history(entry('2.0.0', '- Future.'), current, entry('0.9.0', '- Past.'));
  assert.equal(releaseNotes(text, '1.0.0'), current + '\n');
  assert.equal(releaseNotes(text, '0.9.0'), entry('0.9.0', '- Past.'));
  for (const version of ['Unreleased', '0.0.0', 'v1.0.0', '1.0', '1.0.0+build', '1.0.0\n', '9.0.0', undefined, null, 1]) {
    assert.throws(() => releaseNotes(text, version), /version|SemVer|missing|found/i);
  }
});

test('releaseNotes adds exactly one deterministic version-specific Occipital footer', () => {
  const current = entry('1.0.0', '- Current.');
  const text = history(current);
  assert.equal(releaseNotes(text, '1.0.0', '0.3.0-rc.10'), current + '\n' + dependency('0.3.0-rc.10'));
  assert.equal(releaseNotes(text, '1.0.0', '0.3.0-rc.10'), releaseNotes(text, '1.0.0', '0.3.0-rc.10'));
  for (const version of ['', null, '0.0.0', '0.3', '0.3.0+build', '0.3.0\n']) {
    assert.throws(() => releaseNotes(text, '1.0.0', version), /version|SemVer/i);
  }
});

test('generated dependency notes preserve all authored entry whitespace', () => {
  const current = entry('1.0.0', '- Current.  \n\n\n');
  const text = history(current);
  assert.equal(releaseNotes(text, '1.0.0'), current);
  assert.equal(releaseNotes(text, '1.0.0', '0.3.0'), current + dependency('0.3.0'));
  assert.ok(extensionChangelog(text, '1.0.0', '0.3.0').endsWith(current + dependency('0.3.0')));
});

test('extensionChangelog omits Unreleased, future and all prerelease entries from stable packages', () => {
  const text = history(
    entry('3.0.0', '- Future stable.'), entry('3.0.0-rc.1', '- Future preview.'),
    entry('2.0.0', '- Current.'), entry('2.0.0-rc.10', '- Preview.'), entry('1.0.0', '- Past.'), entry('1.0.0-beta.1', '- Old preview.'),
  );
  assert.equal(extensionChangelog(text, '2.0.0', '0.3.0'),
    `# pi-tidy-ui changelog\n\n[Full history](${repository}/blob/main/CHANGELOG.md).\n\n` +
    entry('2.0.0', '- Current.') + '\n' + dependency('0.3.0') + '\n' + entry('1.0.0', '- Past.') + '\n');
});

test('extensionChangelog retains only full SemVer history at or before a prerelease', () => {
  const text = history(entry('2.0.0'), entry('2.0.0-rc.10'), entry('2.0.0-rc.2'), entry('1.0.0'), entry('1.0.0-beta.1'));
  const packaged = extensionChangelog(text, '2.0.0-rc.2', '0.3.0');
  assert.deepEqual([...packaged.matchAll(/^## \[([^\]]+)\]/gm)].map(match => match[1]), ['2.0.0-rc.2', '1.0.0', '1.0.0-beta.1']);
  assert.ok(packaged.includes(releaseNotes(text, '2.0.0-rc.2', '0.3.0')));
});

test('extensionChangelog preserves authored relative links rather than silently rewriting them', () => {
  const body = '- See [relative](docs/example.md) and [absolute](https://example.com/docs).';
  assert.ok(extensionChangelog(history(entry('1.0.0', body)), '1.0.0', '0.3.0').includes(body));
});

test('extensionChangelog requires existing publishable current and Occipital versions', () => {
  const text = history(entry('1.0.0'));
  for (const [version, native] of [['1.1.0', '0.3.0'], ['Unreleased', '0.3.0'], ['1.0.0', undefined], ['1.0.0', '0.0.0'], ['1.0.0', '0.3.0+build']]) {
    assert.throws(() => extensionChangelog(text, version, native), /version|SemVer|missing|found/i);
  }
});

test('public pure helpers reject non-text changelog inputs at the boundary', () => {
  for (const text of [undefined, null, 1, {}, Buffer.from(unreleased)]) {
    assert.throws(() => parseChangelog(text), /text|string/i);
    assert.throws(() => releaseNotes(text, '1.0.0'), /text|string/i);
    assert.throws(() => extensionChangelog(text, '1.0.0', '0.3.0'), /text|string/i);
  }
});

test('loadChangelog maps products exactly and reads and validates only that product', async t => {
  const root = await mkdtemp(join(tmpdir(), 'changelog-products-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  assert.deepEqual(changelogPaths, { 'pi-tidy-ui': 'CHANGELOG.md', occipital: 'docs/occipital/CHANGELOG.md' });
  await mkdir(join(root, 'docs/occipital'), { recursive: true });
  const extension = history(entry('2.0.0', '- Extension only.')).replaceAll('\n', '\r\n');
  const native = history(entry('0.3.0', '- Native only.'));
  await writeFile(join(root, 'CHANGELOG.md'), extension);
  await writeFile(join(root, 'docs/occipital/CHANGELOG.md'), native);
  assert.equal(await loadChangelog(root, 'pi-tidy-ui'), extension);
  assert.equal(await loadChangelog(root, 'occipital'), native);
  await writeFile(join(root, 'docs/occipital/CHANGELOG.md'), 'invalid');
  assert.equal(await loadChangelog(root, 'pi-tidy-ui'), extension);
  await assert.rejects(loadChangelog(root, 'occipital'), /Unreleased/i);
  await rm(join(root, 'docs/occipital/CHANGELOG.md'));
  await assert.rejects(loadChangelog(root, 'occipital'), { code: 'ENOENT' });
  await writeFile(join(root, 'docs/occipital/CHANGELOG.md'), native);
  await rm(join(root, 'CHANGELOG.md'));
  assert.equal(await loadChangelog(root, 'occipital'), native);
  await assert.rejects(loadChangelog(root, 'pi-tidy-ui'), { code: 'ENOENT' });
  for (const product of ['native', 'Occipital', '../CHANGELOG.md', '__proto__', 'toString', undefined, null, 1]) {
    await assert.rejects(loadChangelog(root, product), /product/i);
  }
  for (const badRoot of [undefined, null, 1, '']) await assert.rejects(loadChangelog(badRoot, 'pi-tidy-ui'), /root/i);
});


test('stable Pi history rejects literal column-zero H2 rows that its native reader would treat as entries', () => {
  for (const heading of ['## Example', '## [999.0.0] - 2026-11-03']) {
    const text = history(entry('1.0.0', '- A change.\n\n```markdown\n' + heading + '\n```'));
    assert.doesNotThrow(() => releaseNotes(text, '1.0.0'));
    assert.throws(() => extensionChangelog(text, '1.0.0', '0.3.0'), /Pi.*heading|column.zero|H2/i);
  }
  const indented = history(entry('1.0.0', '- A change.\n\n```markdown\n ## Example\n```'));
  assert.ok(extensionChangelog(indented, '1.0.0', '0.3.0').includes(' ## Example'));
});
