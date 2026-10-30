import '../../fixtures/test-guard.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { MAX_SHEBANG_BYTES, shebangLanguage } from '../../../src/syntax/shebang-language.ts';

const vectors = JSON.parse(readFileSync(new URL('../../../protocol/syntax-v4/source-hint-vectors.json', import.meta.url), 'utf8')) as {
  revision: number;
  max_shebang_bytes: number;
  interpreters: Record<string, string[]>;
  versioned_interpreters: [string, string][];
  accepted_env_lines: [string, string][];
  rejected_lines: string[];
  invalid_wire_language_values: unknown[];
  optional_hint_cases: { hint: Record<string, unknown>; language: string | null; path: string | null }[];
};

test('shebang language: only reviewed direct interpreter basenames and Python version aliases map to formats', () => {
  assert.equal(shebangLanguage('#!/usr/bin/python3.12 -I'), 'python');
  assert.equal(shebangLanguage('#!/usr/bin/mawk1.3'), 'awk');
  assert.equal(shebangLanguage('#!/usr/bin/nodejs22.1'), 'javascript');
  assert.equal(shebangLanguage('#!/usr/bin/rust-script'), 'rust');
  assert.equal(shebangLanguage('#!/usr/bin/runhugs'), 'haskell');
  assert.equal(shebangLanguage('#! /bin/sh -eu'), 'bash');
  assert.equal(shebangLanguage('#!/usr/bin/env -S Rscript --vanilla'), 'r');
  assert.equal(shebangLanguage('#!/opt/tools/ts-node'), 'typescript');
  assert.equal(shebangLanguage('#!/bin/luajit'), 'lua');
  assert.equal(shebangLanguage('#!/usr/bin/node'), 'javascript', 'Node is a JavaScript interpreter by default');
  assert.equal(shebangLanguage('#!/usr/bin/node22'), 'javascript');
  assert.equal(shebangLanguage('#!/usr/bin/python2.7'), 'python');
  assert.equal(shebangLanguage('#!/usr/bin/pypy2'), 'python');
  assert.equal(shebangLanguage('#!/usr/bin/ruby3.2'), 'ruby');
  assert.equal(shebangLanguage('#!/usr/bin/lua'), 'lua');
  assert.equal(shebangLanguage('#!/usr/bin/fish'), undefined, 'unreviewed aliases are not inferred');
  for (const name of ['constructor', 'toString', '__proto__']) {
    assert.equal(shebangLanguage(`#!/usr/bin/${name}`), undefined, `prototype property ${name} is not an alias`);
    assert.equal(shebangLanguage(`#!/usr/bin/env ${name}`), undefined, `env prototype property ${name} is not an alias`);
  }
});

test('shebang language: shared protocol vectors resolve every curated interpreter to one shipped format', () => {
  assert.equal(vectors.revision, 2);
  assert.equal(vectors.max_shebang_bytes, MAX_SHEBANG_BYTES);
  assert.deepEqual(vectors.optional_hint_cases.map(testCase => [testCase.language, testCase.path]),
    [[null, null], [null, null], [null, null], [null, 'script.py'], [null, 'script.py'], ['python', null]],
    'shared request vectors distinguish omitted, null, empty and explicit selectors without requiring a path');
  for (const [language, aliases] of Object.entries(vectors.interpreters)) for (const alias of aliases)
    assert.equal(shebangLanguage(`#!/usr/bin/${alias}`), language, alias);
  for (const [alias, language] of vectors.versioned_interpreters)
    assert.equal(shebangLanguage(`#!/usr/bin/${alias}`), language, alias);
  for (const [line, language] of vectors.accepted_env_lines) assert.equal(shebangLanguage(line), language, line);
  for (const line of vectors.rejected_lines) assert.equal(shebangLanguage(line), undefined, line);
});

test('shebang language: env parsing is limited to one plain command or simple -S words', () => {
  assert.equal(shebangLanguage('#!/usr/bin/env python3'), 'python');
  assert.equal(shebangLanguage('#!/usr/bin/env -S python3 -u'), 'python');
  assert.equal(shebangLanguage('#!/usr/bin/env\tpython3'), 'python');
  assert.equal(shebangLanguage('#!\t/usr/bin/python3'), 'python');
  assert.equal(shebangLanguage('#!/usr/bin/env -S /usr/bin/python3 -u'), 'python');
  assert.equal(shebangLanguage('#!/usr/bin/env python3 -u'), undefined, 'plain env receives one command argument');
  for (const line of [
    '#!/usr/bin/env -S python3 "-u"',
    "#!/usr/bin/env -S 'python3' -u",
    '#!/usr/bin/env -S python3\\ -u',
    '#!/usr/bin/env -S PYTHONPATH=x python3',
    '#!/usr/bin/env -S -i python3',
    '#!C:/env python3',
    '#!/usr/bin\\tools/env python3',
  ]) assert.equal(shebangLanguage(line), undefined, line);
});

test('shebang language: exact first-row syntax, byte cap and line endings are enforced', () => {
  assert.equal(shebangLanguage('#!/usr/bin/python3\r'), 'python');
  assert.equal(shebangLanguage('\uFEFF#!/usr/bin/python3'), undefined);
  assert.equal(shebangLanguage(' #!/usr/bin/python3'), undefined);
  assert.equal(shebangLanguage('ordinary text'), undefined);
  assert.equal(shebangLanguage('#!/usr/bin/python3\x00'), undefined, 'embedded NUL is rejected');
  assert.equal(shebangLanguage('#!/usr/bin/python3\x1b[31m'), undefined, 'control bytes are rejected before display cleanup');
  assert.equal(shebangLanguage('#!/usr/bin/python3\u0085'), undefined, 'Unicode C1 controls are rejected');
  assert.equal(shebangLanguage('#!/usr/bin/python3\nprint(1)'), undefined, 'the input must be exactly one source row');
  const prefix = '#!/usr/bin/python3 ';
  assert.equal(shebangLanguage(`${prefix}${'x'.repeat(MAX_SHEBANG_BYTES - Buffer.byteLength(prefix))}`), 'python', 'the byte limit is inclusive');
  assert.equal(shebangLanguage(`#!/usr/bin/python3 ${'x'.repeat(MAX_SHEBANG_BYTES)}`), undefined);
  assert.equal(shebangLanguage(`#!/usr/bin/python3 ${'😀'.repeat(512)}`), undefined, 'oversized UTF-8 is bounded even when UTF-16 length is short');
  assert.equal(shebangLanguage('#!/usr/bin/Rscript'), 'r');
  assert.equal(shebangLanguage('#!/usr/bin/rscript'), undefined, 'executable names are case-sensitive');
  assert.equal(shebangLanguage('#!/usr/bin\\python3'), undefined, 'shebang paths use POSIX slash separators');
  assert.equal(shebangLanguage('#!/usr/bin/ENV python3'), undefined, 'the env executable name is case-sensitive');
});
