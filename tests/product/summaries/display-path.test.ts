import '../../fixtures/test-guard.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { fileHeading, readHeading } from '../../../src/file-card.ts';
import { displayPath } from '../../../src/display-path.ts';
import { describeArgs } from '../../../src/summary-args.ts';
import { Tool, plain, setup } from '../../fixtures/sdk-contract-support.ts';

const cwd = '/w/projects/pi-toolview';

test('file headings: paths reaching root use the absolute name, not a parent ladder', () => {
  for (const path of ['/home/kot/recovery.md', '../../../home/kot/recovery.md', '../../../../home/kot/recovery.md']) {
    assert.equal(fileHeading(path, cwd, 'Edited'), '← Edited /home/kot/recovery.md');
    assert.equal(fileHeading(path, cwd, 'Created'), '← Created /home/kot/recovery.md');
    assert.equal(readHeading(path, cwd), '→ Read /home/kot/recovery.md');
  }
  assert.equal(fileHeading('/w/projects/pi-toolview/src/app.ts', cwd, 'Edited'), '← Edited src/app.ts');
  assert.equal(fileHeading('../neighbor/app.ts', cwd, 'Edited'), '← Edited ../neighbor/app.ts');
  assert.equal(readHeading('../../shared/app.ts', cwd), '→ Read ../../shared/app.ts');
  assert.equal(readHeading('../../../home/kot/recovery.md', undefined), '→ Read ../../../home/kot/recovery.md');
});

test('compact summaries: every owned file tool uses its render cwd without changing arguments', () => {
  for (const name of ['read', 'write', 'edit', 'custom']) {
    const tool = new Tool(name, { path: '../../../../home/kot/recovery.md' });
    tool.getRenderContext = () => ({ cwd });
    const snapshot = structuredClone(tool.args);
    const { controller } = setup([tool]);
    try {
      const rows = tool.render(120).map(plain).join('\n');
      assert.ok(rows.includes(`${name} /home/kot/recovery.md`), rows);
      assert.deepEqual(tool.args, snapshot);
    } finally { controller.restore(); }
  }
});

test('compact summaries: path arrays and nested path fields normalize without rewriting payload or URLs', () => {
  const raw = '../../../tmp/body.txt';
  const tool = new Tool('custom', {
    pattern: raw, path: raw, paths: [raw, '../neighbor'], destination: '../../../tmp/moved.txt',
    args: { file_path: raw, content: raw, url: raw }, url: 'https://example.org/../../source',
  });
  tool.getRenderContext = () => ({ cwd });
  const snapshot = structuredClone(tool.args);
  const { controller } = setup([tool]);
  try {
    const rows = tool.render(200).map(plain).join('');
    assert.ok(rows.includes(`"${raw}" in /tmp/body.txt`), rows);
    assert.ok(rows.includes('paths=["/tmp/body.txt","../neighbor"]'), rows);
    assert.ok(rows.includes('destination="/tmp/moved.txt"'), rows);
    assert.ok(rows.includes('"file_path":"/tmp/body.txt"'), rows);
    assert.ok(rows.includes(`"content":"${raw}"`), rows);
    assert.ok(rows.includes(`"url":"${raw}"`), rows);
    assert.ok(rows.includes('https://example.org/../../source'), rows);
    assert.deepEqual(tool.args, snapshot);
  } finally { controller.restore(); }
});

test('compact summaries: a changed render cwd invalidates the displayed path, warm frames reuse it', () => {
  const tool = new Tool('read', { path: '../../../home/kot/recovery.md' });
  let directory = cwd;
  tool.getRenderContext = () => ({ cwd: directory });
  const { controller } = setup([tool]);
  try {
    const first = tool.render(120).map(plain);
    assert.ok(first.join('').includes('read /home/kot/recovery.md'));
    const builds = controller.cacheStats().builds;
    assert.deepEqual(tool.render(120).map(plain), first);
    assert.equal(controller.cacheStats().builds, builds);
    directory = '/w/projects/pi-toolview/deeper';
    assert.ok(tool.render(120).map(plain).join('').includes('read ../../../home/kot/recovery.md'));
  } finally { controller.restore(); }
});

test('display paths: normalize root-reaching walks but preserve nearby and unknown locations', () => {
  for (const path of ['../../../tmp/a.ts', '../../../../tmp/a.ts', './../../../tmp/a.ts', 'child/../../../../tmp/a.ts', '..//..//..//tmp/a.ts'])
    assert.equal(displayPath(path, cwd), '/tmp/a.ts');
  assert.equal(displayPath('../../..', cwd), '/');
  assert.equal(displayPath('../tmp/a.ts', '/'), '/tmp/a.ts');
  assert.equal(displayPath('a.ts', '/'), 'a.ts');
  assert.equal(displayPath('../../../tmp/../etc/a.ts', cwd), '/etc/a.ts');
  for (const path of ['', 'a.ts', '../a.ts', '../../a.ts', '/tmp/a.ts', '~/../../../a.ts', '..file/a.ts'])
    assert.equal(displayPath(path, cwd), path);
  for (const directory of [undefined, '', 'project']) {
    assert.equal(displayPath('../../../tmp/a.ts', directory), '../../../tmp/a.ts');
    assert.equal(readHeading('/tmp/a.ts', directory), '→ Read /tmp/a.ts');
  }
});

test('display paths: Windows drive and UNC roots use their own separators and depth', () => {
  const directory = 'C:\\work\\project';
  assert.equal(displayPath('..\\..\\Users\\kot\\a.ts', directory), 'C:\\Users\\kot\\a.ts');
  assert.equal(displayPath('..\\..\\..\\Users\\kot\\a.ts', directory), 'C:\\Users\\kot\\a.ts');
  assert.equal(displayPath('../../Users/kot/a.ts', directory), 'C:\\Users\\kot\\a.ts');
  assert.equal(displayPath('../../Users/kot/a.ts', 'C:/work/project'), 'C:\\Users\\kot\\a.ts');
  assert.equal(displayPath('..\\..\\file.ts', '\\\\server\\share/project'), '\\\\server\\share\\file.ts');
  assert.equal(displayPath('..\\file.ts', '\\\\server\\share'), '\\\\server\\share\\file.ts');
  assert.equal(displayPath('..\\sibling\\a.ts', directory), '..\\sibling\\a.ts');
  assert.equal(displayPath('D:..\\..\\a.ts', directory), 'D:..\\..\\a.ts');
  assert.equal(displayPath('D:\\source\\a.ts', directory), 'D:\\source\\a.ts');
  assert.equal(displayPath('..\\a.ts', 'C:\\'), 'C:\\a.ts');
  assert.equal(displayPath('a.ts', 'C:\\'), 'a.ts');
  assert.equal(displayPath('..\\..\\file.ts', '\\\\server\\share\\project'), '\\\\server\\share\\file.ts');
  assert.equal(displayPath('..\\file.ts', '\\\\server\\share\\parent\\project'), '..\\file.ts');
  assert.equal(displayPath('..\\..\\file.ts', cwd), '..\\..\\file.ts', 'backslashes remain filename characters on POSIX');
});

test('compact summaries: truncated path prefixes are never resolved as if complete', () => {
  const raw = '../../../' + 'segment/'.repeat(40) + '..filename.ts';
  const value = describeArgs('edit', { path: raw }, cwd);
  assert.equal(value, raw.slice(0, 255) + '…');
  assert.equal(describeArgs('edit', { path: '../../../tmp/..filename.ts' }, cwd), '/tmp/..filename.ts');
  assert.equal(describeArgs('custom', { target: '../../../tmp/a.ts' }, cwd), '/tmp/a.ts');
  assert.equal(describeArgs('custom', { scope: ['../../../tmp/a.ts'] }, cwd), '[scope=["/tmp/a.ts"]]');
  assert.equal(describeArgs('custom', { url: '../../../tmp/a.ts' }, cwd), '../../../tmp/a.ts');
  assert.equal(describeArgs('custom', { command: '../../../bin/sh' }, cwd), '[command="../../../bin/sh"]');
  assert.equal(describeArgs('read', { path: '..\\..\\Users\\kot\\a.ts' }, 'C:/work/project'), JSON.stringify('C:\\Users\\kot\\a.ts'));
});

test('compact summaries: named file locations and path collections share normalization', () => {
  for (const key of ['file_path', 'filePath', 'destination', 'cwd', 'workdir', 'dir', 'toPath', 'handoffPath', 'sessionDir'])
    assert.equal(describeArgs('custom', { [key]: '../../../tmp/a.ts' }, cwd), `[${key}="/tmp/a.ts"]`);
  for (const key of ['paths', 'targets', 'scope', 'files', 'outputPaths'])
    assert.equal(describeArgs('custom', { [key]: ['../../../tmp/a.ts', '../a.ts'] }, cwd), `[${key}=["/tmp/a.ts","../a.ts"]]`);
});
