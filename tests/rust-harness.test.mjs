import './fixtures/test-guard.mjs';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, sep } from 'node:path';
import { childEnv, readInputs } from '../scripts/test/context.mjs';
import { materializeSource } from '../scripts/test/prepare.mjs';

test('real pinned Cargo cannot inherit the checkout ancestor rustc wrapper', t => {
  const inputs = readInputs();
  assert.ok(inputs.rust, 'rust-harness requires an explicitly prepared pinned Cargo/rustc');
  assert.equal(realpathSync(inputs.pi.root).startsWith(realpathSync(inputs.source.root) + sep), false);
  assert.equal(realpathSync(inputs.pi.root).startsWith(realpathSync(inputs.runRoot) + sep), true);
  const root = mkdtempSync(join(tmpdir(), 'cargo-ancestor-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  const ancestor = join(root, 'polluted'), checkout = join(ancestor, 'checkout'), neutral = join(root, 'neutral');
  for (const path of [join(ancestor, '.cargo'), join(checkout, 'src'), join(root, 'cargo-home')]) mkdirSync(path, { recursive: true });
  const counter = join(root, 'wrapper-calls'), wrapper = join(root, process.platform === 'win32' ? 'wrapper.cmd' : 'wrapper.sh');
  writeFileSync(wrapper, process.platform === 'win32' ? '@echo off\r\necho hit>>"%TIDY_RUST_WRAPPER_COUNTER%"\r\nexit /b 73\r\n' : '#!/bin/sh\nprintf hit >> "$TIDY_RUST_WRAPPER_COUNTER"\nexit 73\n', { mode: 0o700 });
  writeFileSync(join(ancestor, '.cargo/config.toml'), `[build]\nrustc-wrapper = ${JSON.stringify(wrapper)}\n`);
  writeFileSync(join(checkout, 'Cargo.toml'), '[package]\nname = "harness-probe"\nversion = "0.0.0"\nedition = "2024"\n');
  writeFileSync(join(checkout, 'Cargo.lock'), 'version = 4\n[[package]]\nname = "harness-probe"\nversion = "0.0.0"\n');
  writeFileSync(join(checkout, 'src/lib.rs'), 'pub fn probe() -> u32 { 42 }\n');
  const env = childEnv(join(root, 'environment'), { ...inputs.rust.environment, CARGO_HOME: join(root, 'cargo-home'),
    CARGO_TARGET_DIR: join(root, 'target'), CARGO_NET_OFFLINE: 'true', RUSTC: inputs.rust.rustc, RUSTUP_AUTO_INSTALL: '0',
    PATH: dirname(inputs.rust.rustc) + delimiter + (inputs.rust.environment?.PATH ?? inputs.tools.bin),
    TIDY_RUST_WRAPPER_COUNTER: counter }, inputs);
  const check = cwd => spawnSync(inputs.rust.cargo, ['check', '--locked', '--offline'], { cwd, env, encoding: 'utf8', timeout: 30000 });
  const poisoned = check(checkout);
  assert.notEqual(poisoned.status, 0, 'positive control must observe ancestor Cargo configuration');
  assert.ok(readFileSync(counter).length > 0, 'positive control executed the actual configured wrapper');
  writeFileSync(counter, '');
  materializeSource(checkout, neutral, ['Cargo.toml', 'Cargo.lock', 'src/lib.rs']);
  const isolated = check(neutral);
  assert.equal(isolated.status, 0, isolated.stderr);
  assert.equal(readFileSync(counter).length, 0, 'owned neutral materialization executes the ambient wrapper zero times');
});
