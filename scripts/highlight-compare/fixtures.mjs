import { readFileSync, realpathSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { digest, logicalLines } from './model.mjs';

// Use the standard patch library already owned by the selected Pi SDK dependency graph.
const { parsePatch, applyPatch } = createRequire(import.meta.resolve('@earendil-works/pi-coding-agent'))('diff');

function textFile(root, name) {
  if (typeof name !== 'string' || !name || isAbsolute(name) || name.includes('\\') || name.split('/').some(part => !part || part === '.' || part === '..')) throw new Error('Invalid fixture-relative path');
  const path = realpathSync(join(root, name));
  if (relative(root, path).startsWith('..' + sep) || isAbsolute(relative(root, path))) throw new Error('Fixture escapes its root');
  if (!statSync(path).isFile() || statSync(path).size > 65536) throw new Error('Fixture must be a bounded regular file');
  const bytes = readFileSync(path), text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  if (logicalLines(text).length > 8192) throw new Error('Fixture exceeds full-source line limit');
  return { text, sha256: digest(bytes), path };
}

export function loadFixtures(directory) {
  const root = realpathSync(resolve(directory)), { text } = textFile(root, 'manifest.json'), manifest = JSON.parse(text);
  if (manifest.schema !== 1 || !Array.isArray(manifest.languages) || !Array.isArray(manifest.diffs)) throw new Error('Unsupported fixture manifest');
  const ids = new Set(), fixtures = [];
  const identity = item => {
    if (!/^[a-z0-9]+(?:[.-][a-z0-9]+)*$/.test(item.id) || ids.has(item.id)) throw new Error('Invalid or duplicate fixture ID');
    ids.add(item.id);
  };
  for (const item of manifest.languages) {
    identity(item);
    const data = textFile(root, item.path), lines = logicalLines(data.text);
    if (typeof item.language !== 'string' || typeof item.version !== 'string' || !Array.isArray(item.cases) || !item.cases.length) throw new Error('Language fixture requires versioned feature cases');
    const cases = new Set();
    for (const entry of item.cases) {
      if (typeof entry.id !== 'string' || cases.has(entry.id) || !Array.isArray(entry.features) || !entry.features.length || entry.features.some(value => typeof value !== 'string' || !value) || !Number.isSafeInteger(entry.startLine) || !Number.isSafeInteger(entry.endLine) || entry.startLine < 1 || entry.endLine < entry.startLine || entry.endLine > lines.length) throw new Error('Invalid fixture feature range');
      cases.add(entry.id);
    }
    fixtures.push({ ...item, kind: 'source', filename: basename(item.path), content: data.text, sha256: data.sha256 });
  }
  for (const item of manifest.diffs) {
    identity(item);
    const before = textFile(root, item.oldPath), after = textFile(root, item.newPath);
    if (!Array.isArray(item.roleSamples) || !item.roleSamples.length) throw new Error('Diff fixture requires independent role samples');
    for (const sample of item.roleSamples) {
      if (!['added', 'removed', 'context'].includes(sample.role) || typeof sample.text !== 'string') throw new Error('Invalid diff role');
      const check = (side, line) => Number.isSafeInteger(line) && line >= 1 && logicalLines(side)[line - 1]?.text === sample.text;
      if (sample.role !== 'added' && !check(before.text, sample.oldLine) || sample.role !== 'removed' && !check(after.text, sample.newLine)) throw new Error('Diff role/source-coordinate mismatch');
    }
    fixtures.push({ ...item, kind: 'diff', filename: item.id + '.txt', before: before.text, after: after.text,
      sha256: digest(JSON.stringify([before.sha256, after.sha256])) });
  }
  return { schema: 1, manifestSha256: digest(text), fixtures };
}

export function diffRows(patch, before, after) {
  const parsed = parsePatch(patch);
  if (parsed.length !== 1 || !parsed[0].hunks.length) throw new Error('Diff fixture requires one changed file');
  if (applyPatch(before, parsed[0], { fuzzFactor: 0, autoConvertLineEndings: false }) !== after) throw new Error('Native patch/source reconstruction mismatch');
  const oldLines = before ? logicalLines(before) : [], newLines = after ? logicalLines(after) : [], rows = [];
  for (const hunk of parsed[0].hunks) {
    let oldLine = hunk.oldStart, newLine = hunk.newStart;
    for (const line of hunk.lines) {
      const sign = line[0];
      if (sign === '\\') continue;
      const text = line.slice(1).replace(/\r$/, ''), role = sign === '+' ? 'added' : sign === '-' ? 'removed' : 'context';
      if (sign !== '+' && oldLines[oldLine - 1]?.text !== text || sign !== '-' && newLines[newLine - 1]?.text !== text) throw new Error('Native patch/source coordinate mismatch');
      rows.push({ role, text, ...(sign !== '+' ? { oldLine: oldLine++ } : {}), ...(sign !== '-' ? { newLine: newLine++ } : {}) });
    }
  }
  return rows;
}

export function prepareDiff(fixture, directory, git, env) {
  mkdirSync(directory, { recursive: true });
  const oldPath = join(directory, 'before.txt'), newPath = join(directory, 'after.txt');
  writeFileSync(oldPath, fixture.before, { flag: 'wx' }); writeFileSync(newPath, fixture.after, { flag: 'wx' });
  const result = spawnSync(git, ['diff', '--no-index', '--no-ext-diff', '--no-textconv', '--no-color', '--unified=3', '--', oldPath, newPath], { env, encoding: 'utf8', timeout: 10000, maxBuffer: 1048576 });
  if (result.error || result.status !== 1) throw new Error('Unable to derive changed native diff fixture');
  const rows = diffRows(result.stdout, fixture.before, fixture.after);
  for (const sample of fixture.roleSamples) if (!rows.some(row => row.role === sample.role && row.text === sample.text && row.oldLine === sample.oldLine && row.newLine === sample.newLine)) throw new Error('Independent diff-role witness disagrees with native patch');
  return { ...fixture, patch: result.stdout, logicalRows: rows };
}
