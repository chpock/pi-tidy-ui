import './fixtures/test-guard.mjs';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import ts from 'typescript';
import { test } from 'node:test';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import tidyUi, * as entry from '../src/index.ts';

test('package and root lock declare the same pi-tidy-ui development identity', async () => {
  const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  const lock = JSON.parse(await readFile(new URL('../package-lock.json', import.meta.url), 'utf8'));
  assert.equal(manifest.name, 'pi-tidy-ui');
  assert.equal(lock.name, manifest.name);
  assert.equal(lock.packages[''].name, manifest.name);
  assert.equal(manifest.version, '0.0.0');
  assert.equal(lock.version, manifest.version);
  assert.equal(lock.packages[''].version, manifest.version);
});

test('entry exposes the canonical TidyUi installer and default function', () => {
  assert.equal(typeof Reflect.get(entry, 'installTidyUi'), 'function');
  assert.equal(tidyUi.name, 'tidyUi');
});

test('entry registers only the tidy-ui command and flags, with branded diagnostics and usage', async () => {
  const commands = new Map<string, { handler(args: string, ctx: ExtensionContext): Promise<void> }>();
  const flags: string[] = [], notices: [string, string][] = [];
  const pi = {
    registerCommand: (name: string, command: { handler(args: string, ctx: ExtensionContext): Promise<void> }) => commands.set(name, command),
    registerFlag: (name: string) => flags.push(name),
    on() {},
  } as unknown as ExtensionAPI;
  tidyUi(pi);
  assert.deepEqual([...commands.keys()], ['tidy-ui']);
  assert.deepEqual(flags, ['tidy-ui-card', 'tidy-ui-compact', 'tidy-ui-cache-mb', 'tidy-ui-card-cache-mb']);
  const ctx = { mode: 'rpc', hasUI: false, ui: { notify: (message: string, type: string) => notices.push([message, type]) } } as unknown as ExtensionContext;
  const command = commands.get('tidy-ui')!;
  await command.handler('status', ctx);
  assert.deepEqual(notices.pop(), ['pi-tidy-ui: unavailable outside terminal mode', 'info']);
  await command.handler('colors status', ctx);
  assert.deepEqual(notices.pop(), ['pi-tidy-ui colors: unavailable outside terminal mode', 'info']);
  await command.handler('cache', ctx);
  assert.deepEqual(notices.pop(), ['pi-tidy-ui cache: unavailable outside an initialized terminal runtime', 'info']);
  await command.handler('syntax extra', ctx);
  assert.deepEqual(notices.pop(), ['Usage: /tidy-ui syntax', 'warning']);
  await command.handler('colors extra', ctx);
  assert.deepEqual(notices.pop(), ['Usage: /tidy-ui colors on|off|status', 'warning']);
  await command.handler('unknown', ctx);
  assert.deepEqual(notices.pop(), ['Usage: /tidy-ui on|off|status|syntax|colors on|off|status|cache [clear]|logs [on|off|snapshot]', 'warning']);
});


test('the real Bash fixture closes its heredoc and executes the following command', async () => {
  const source = ts.createSourceFile('driver.ts', await readFile(new URL('./fixtures/driver.ts', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true);
  let calls: ts.ArrayLiteralExpression | undefined;
  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === 'bashReal' && node.initializer && ts.isArrayLiteralExpression(node.initializer)) calls = node.initializer;
    ts.forEachChild(node, visit);
  };
  visit(source);
  assert.ok(calls);
  const first = calls.elements[0];
  assert.ok(ts.isObjectLiteralExpression(first));
  const args = first.properties.find((property): property is ts.PropertyAssignment => ts.isPropertyAssignment(property) && ts.isIdentifier(property.name) && property.name.text === 'arguments');
  assert.ok(args && ts.isObjectLiteralExpression(args.initializer));
  const command = args.initializer.properties.find((property): property is ts.PropertyAssignment => ts.isPropertyAssignment(property) && ts.isIdentifier(property.name) && property.name.text === 'command');
  assert.ok(command && ts.isStringLiteral(command.initializer));
  const result = spawnSync('bash', ['--noprofile', '--norc', '-c', command.initializer.text], {
    encoding: 'utf8', timeout: 5000, env: { PATH: process.env.PATH, LC_ALL: 'C' },
  });
  assert.ifError(result.error);
  assert.deepEqual({ status: result.status, stdout: result.stdout, stderr: result.stderr }, {
    status: 0, stdout: '  HEREDOC_INDENT\nHEREDOC_END\nAFTER_HEREDOC\n', stderr: '',
  });
});
