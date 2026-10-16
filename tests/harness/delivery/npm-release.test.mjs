import "../../fixtures/test-guard.mjs";
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, cp, readFile, writeFile, rm, readdir, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { candidateTargets, stageRelease } from "../../../scripts/release/native-release.mjs";
import { assembleRelease, artifactName, assetName } from "../../../scripts/release/native-ci.mjs";
import { enabledTargets } from "../../../scripts/release/platforms.mjs";
import { releaseRef } from "../../../scripts/release/version.mjs";

const repo = resolve(import.meta.dirname, "../../.."), repository = 'chpock/pi-tidy-ui', commit = 'a'.repeat(40);
const json = async path => JSON.parse(await readFile(path, 'utf8'));
const publisher = () => import("../../../scripts/release/npm-release.mjs");
const host = { GITHUB_ACTIONS: 'true', GITHUB_REPOSITORY: repository, GITHUB_EVENT_NAME: 'push', GITHUB_REF: 'refs/tags/occipital-v0.1.5',
  GITHUB_SHA: commit, GITHUB_WORKFLOW_SHA: commit,
  GITHUB_WORKFLOW_REF: `${repository}/.github/workflows/ci.yml@refs/tags/occipital-v0.1.5`,
  ACTIONS_ID_TOKEN_REQUEST_URL: 'https://example.invalid/oidc', ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'fixture-only' };
async function fixture(t, version = '0.1.5', targets = enabledTargets()) {
  const root = await mkdtemp(join(tmpdir(), 'occipital-npm-release-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'crates/occipital'), { recursive: true });
  await writeFile(join(root, 'crates/occipital/Cargo.toml'), `[package]\nname = "occipital"\nversion = "${version}"\n`);
  await cp(join(repo, 'packages'), join(root, 'packages'), { recursive: true });
  await cp(join(repo, 'LICENSE'), join(root, 'LICENSE'));
  const binary = join(root, 'tiny'), notice = join(root, 'NOTICE'), directory = join(root, 'artifacts');
  await writeFile(binary, 'Inert native fixture, never executed.\n');
  await writeFile(notice, 'Exact inert notice ☃\r\n'); await mkdir(directory);
  const tag = 'occipital-v' + version;
  for (const target of targets) {
    const output = join(directory, artifactName(version, target));
    await stageRelease({ root, output, targets: [target], input: { notice, artifacts: [{ target, path: binary,
      url: `https://github.com/${repository}/releases/download/${encodeURIComponent(tag)}/${encodeURIComponent(assetName(version, target))}` }] } });
    await writeFile(join(output, 'build-info.json'), JSON.stringify({ commit, version, target }));
    await mkdir(join(output, 'notices'));
    await writeFile(join(output, 'notices/notice-sources.json'), JSON.stringify({ inventory: [{ name: 'fixture' }], gaps: [] }));
  }
  const publicDirectory = join(root, 'public');
  await assembleRelease({ directory, tag, repository, commit, output: publicDirectory, targets });
  return { root, directory, publicDirectory, tag, version, repository, commit, targets, output: join(root, 'prepared') };
}

test('automatic npm publication requires a published matching GitHub release, not a draft or wrong prerelease', async () => {
  const { validatePublicRelease } = await publisher();
  const valid = { tag_name: 'occipital-v0.1.5', draft: false, prerelease: false };
  validatePublicRelease(valid, valid.tag_name);
  for (const value of [{ ...valid, draft: true }, { ...valid, tag_name: 'other' }, { ...valid, prerelease: true }]) assert.throws(() => validatePublicRelease(value, valid.tag_name));
});

test('native templates carry the canonical repository required by npm trusted-publisher provenance', async () => {
  for (const target of Object.keys(candidateTargets)) {
    assert.deepEqual((await json(join(repo, 'packages/native', target, 'package.json.template'))).repository,
      { type: 'git', url: `git+https://github.com/${repository}.git` });
  }
});

test('npm preparation packs the default five real inert packages with unchanged bytes/notices and restored executable modes', async t => {
  const f = await fixture(t), { prepareNpmRelease } = await publisher();
  const plan = await prepareNpmRelease(f);
  assert.equal(plan.version, '0.1.5'); assert.equal(plan.commit, commit); assert.equal(plan.packages.length, 5);
  assert.deepEqual(plan, await json(join(f.output, 'plan.json')));
  for (const entry of plan.packages) {
    assert.equal(entry.name, `@kchpock/occipital-${entry.target}`); assert.equal(entry.version, f.version);
    assert.match(entry.integrity, /^sha512-/); assert.ok((await stat(entry.tarball)).size > 0);
    const copied = join(f.output, 'packages', entry.target), source = join(f.directory, artifactName(f.version, entry.target), 'packages', entry.target);
    assert.deepEqual((await readdir(copied)).sort(), ['LICENSE', 'NOTICE', 'package.json', candidateTargets[entry.target].executable].sort());
    for (const name of await readdir(copied)) assert.deepEqual(await readFile(join(copied, name)), await readFile(join(source, name)));
    if (process.platform !== 'win32') assert.equal((await stat(join(copied, candidateTargets[entry.target].executable))).mode & 0o777, 0o755);
  }
  await assert.rejects(prepareNpmRelease(f), { code: 'EEXIST' });
});

for (const change of ['name', 'version', 'os', 'cpu', 'libc', 'repository', 'scripts', 'files', 'extra-file', 'binary', 'NOTICE', 'LICENSE', 'public-binary']) {
  test(`npm preparation refuses ${change} before the first npm pack or publish`, async t => {
    const f = await fixture(t), { prepareNpmRelease } = await publisher(), target = 'linux-x64-gnu';
    const packageDir = join(f.directory, artifactName(f.version, target), 'packages', target), manifestPath = join(packageDir, 'package.json');
    if (['binary', 'NOTICE', 'LICENSE', 'extra-file'].includes(change)) {
      await writeFile(join(packageDir, change === 'binary' ? 'occipital' : change), 'changed');
    } else if (change === 'public-binary') await writeFile(join(f.publicDirectory, assetName(f.version, target)), 'changed public bytes');
    else {
      const manifest = await json(manifestPath);
      const values = { name: 'pi-tidy-ui', version: '0.0.0', os: ['win32'], cpu: ['arm64'], libc: ['musl'],
        repository: { type: 'git', url: 'https://github.com/stranger/repo' }, scripts: { postinstall: 'must never run' }, files: ['*'] };
      manifest[change] = values[change]; await writeFile(manifestPath, JSON.stringify(manifest));
    }
    let calls = 0;
    await assert.rejects(prepareNpmRelease({ ...f, execute: async () => { calls++; throw new Error('Must reject before npm'); } }));
    assert.equal(calls, 0);
  });
}

function absent() { return Object.assign(new Error('fixture absent'), { stdout: JSON.stringify({ error: { code: 'E404' } }) }); }
async function planned(t, version) { const f = await fixture(t, version), { prepareNpmRelease } = await publisher(); return { f, plan: await prepareNpmRelease(f) }; }
function registryFetcher(plan, { corrupt = false, missing = false } = {}) {
  return async url => {
    const archive = String(url).includes('/archive/');
    const row = plan.packages.find(row => archive ? String(url).endsWith('/' + row.target) : String(url).includes(encodeURIComponent(row.name) + '/'));
    assert.ok(row, 'exact package identity in registry request');
    if (archive) {
      const bytes = await readFile(row.tarball);
      if (corrupt) bytes[bytes.length - 1] ^= 1;
      return new Response(bytes);
    }
    if (missing) return new Response('{}', { status: 404 });
    return Response.json({ name: row.name, version: row.version, dist: { integrity: row.integrity, tarball: 'https://registry.npmjs.org/archive/' + row.target } });
  };
}

test('publication requires the exact automatic push-tag CI OIDC caller and never uses local npm login', async t => {
  const { f } = await planned(t), { publishNpmRelease } = await publisher(); let calls = 0;
  for (const env of [{}, { ...host, GITHUB_REF: 'refs/heads/other' }, { ...host, ACTIONS_ID_TOKEN_REQUEST_TOKEN: '' }, { ...host, ACTIONS_ID_TOKEN_REQUEST_URL: '' },
    { ...host, GITHUB_REF: 'refs/heads/main' }, { ...host, GITHUB_EVENT_NAME: 'pull_request' }, { ...host, GITHUB_EVENT_NAME: 'workflow_dispatch' },
    { ...host, GITHUB_SHA: 'b'.repeat(40) }, { ...host, GITHUB_WORKFLOW_SHA: 'b'.repeat(40) },
    { ...host, GITHUB_WORKFLOW_REF: `${repository}/.github/workflows/other.yml@refs/heads/main` }]) {
    await assert.rejects(publishNpmRelease({ planPath: join(f.output, 'plan.json'), env, execute: async () => { calls++; } }));
  }
  assert.equal(calls, 0);
});

test('all-selected registry preflight rejects a late mismatch/auth failure without any partial publication', async t => {
  const { f, plan } = await planned(t), { publishNpmRelease } = await publisher();
  for (const failure of ['different', 'unauthorized', 'null', 'multiple']) {
    const calls = [];
    await assert.rejects(publishNpmRelease({ planPath: join(f.output, 'plan.json'), env: host, execute: async (_npm, args) => {
      calls.push(args); assert.equal(args[0], 'view');
      if (args[1].startsWith(plan.packages.at(-1).name + '@')) {
        if (failure === 'unauthorized') throw Object.assign(new Error('no access'), { stdout: JSON.stringify({ error: { code: 'E401' } }) });
        if (failure === 'null') return { stdout: 'null' };
        if (failure === 'multiple') return { stdout: JSON.stringify([{}, {}]) };
        return { stdout: JSON.stringify({ name: plan.packages.at(-1).name, version: plan.version, dist: { integrity: 'sha512-different' } }) };
      }
      throw absent();
    } }));
    assert.equal(calls.length, 5); assert.equal(calls.filter(args => args[0] === 'publish').length, 0);
  }
});

test('existing byte-identical packages are skipped and unpublished packages get direct public OIDC publish only', async t => {
  const { f, plan } = await planned(t), { publishNpmRelease } = await publisher(), calls = [];
  const result = await publishNpmRelease({ planPath: join(f.output, 'plan.json'), env: host, fetcher: registryFetcher(plan), execute: async (_npm, args) => {
    calls.push(args);
    if (args[0] === 'view') {
      const index = plan.packages.findIndex(row => args[1] === `${row.name}@${row.version}`), row = plan.packages[index];
      if (index % 2 === 0) return { stdout: JSON.stringify([{ name: row.name, version: row.version, dist: { integrity: row.integrity } }]) };
      throw absent();
    }
    assert.equal(args[0], 'publish'); assert.ok(args.includes('--ignore-scripts')); assert.ok(args.includes('--access=public'));
    assert.ok(args.includes('--provenance'));
    assert.equal(args.includes('--force'), false); assert.equal(args.includes('approve'), false); assert.equal(args.includes('--provenance=false'), false);
    const row = plan.packages.find(row => row.tarball === args[1]);
    return { stdout: JSON.stringify({ [row.name]: { name: row.name, version: row.version, integrity: row.integrity } }) };
  } });
  assert.deepEqual(calls.slice(0, 5).map(args => args[0]), Array(5).fill('view'));
  assert.equal(calls.filter(args => args[0] === 'publish').length, 2);
  assert.deepEqual(result.packages.map(row => row.outcome), ['already-published', 'published', 'already-published', 'published', 'already-published']);
  assert.equal(result.packages.filter(row => row.registryByteVerified).length, 5);
});

test('prerelease publication uses next rather than replacing stable latest', async t => {
  const { f } = await planned(t, '0.1.5-rc.1'), { publishNpmRelease } = await publisher();
  const path = join(f.output, 'plan.json'), value = await json(path);
  await publishNpmRelease({ planPath: path, env: { ...host, GITHUB_REF: 'refs/tags/' + value.tag, GITHUB_WORKFLOW_REF: `${repository}/.github/workflows/ci.yml@refs/tags/${value.tag}` }, fetcher: registryFetcher(value), execute: async (_npm, args) => {
    if (args[0] === 'view') throw absent();
    assert.ok(args.includes('--tag=next'));
    const row = value.packages.find(row => row.tarball === args[1]);
    return { stdout: JSON.stringify({ [row.name]: { name: row.name, version: row.version, integrity: row.integrity } }) };
  } });
});

test('explicit Windows ARM64 opt-in packs and publishes all six same-run packages', async t => {
  const targets = enabledTargets({ windowsArm64: true }), f = await fixture(t, '0.1.5', targets);
  const { prepareNpmRelease, publishNpmRelease } = await publisher(), plan = await prepareNpmRelease(f);
  assert.deepEqual(plan.packages.map(row => row.target), targets);
  let uploads = 0;
  const result = await publishNpmRelease({ planPath: join(f.output, 'plan.json'), targets, env: host, report: () => {}, fetcher: registryFetcher(plan), execute: async (_, args) => {
    if (args[0] === 'view') throw absent();
    uploads++;
    const row = plan.packages.find(row => row.tarball === args[1]);
    return { stdout: JSON.stringify([{ name: row.name, version: row.version, integrity: row.integrity }]) };
  } });
  assert.equal(uploads, 6); assert.equal(result.packages.filter(row => row.registryByteVerified).length, 6);
});


test('an interrupted publication preserves per-package outcomes and never continues to later uploads', async t => {
  const { f, plan } = await planned(t), { publishNpmRelease } = await publisher();
  let uploads = 0;
  const execute = async (_, args) => {
    if (args[0] === 'view') throw absent();
    assert.equal(args[0], 'publish'); uploads++;
    if (uploads === 2) throw new Error('Injected uncertain publication response');
    const row = plan.packages.find(row => row.tarball === args[1]);
    return { stdout: JSON.stringify({ [row.name]: { name: row.name, version: row.version, integrity: row.integrity } }) };
  };
  await assert.rejects(publishNpmRelease({ planPath: join(f.output, 'plan.json'), env: host, execute }), /Injected uncertain/);
  assert.equal(uploads, 2);
  const receipts = await json(join(f.output, 'receipts.json'));
  assert.deepEqual(receipts.packages.map(row => row.outcome), ['published', 'unconfirmed', 'not-started', 'not-started', 'not-started']);
});

test('public tarball corruption is refused even when registry metadata reports the expected integrity', async t => {
  const { f, plan } = await planned(t), { publishNpmRelease } = await publisher();
  let uploads = 0;
  const execute = async (_, args) => {
    const row = plan.packages.find(row => args[1] === `${row.name}@${row.version}`);
    if (args[0] === 'view') return { stdout: JSON.stringify([{ name: row.name, version: row.version, dist: { integrity: row.integrity } }]) };
    if (args[0] === 'publish') { uploads++; throw new Error('Unexpected upload'); }
    assert.fail('Archive verification must not resolve the version through npm pack');
  };
  await assert.rejects(publishNpmRelease({ planPath: join(f.output, 'plan.json'), env: host, execute, fetcher: registryFetcher(plan, { corrupt: true }) }), /Public registry archive differs/);
  assert.equal(uploads, 0);
  assert.equal((await json(join(f.output, 'receipts.json'))).packages.some(row => row.registryByteVerified), false);
});


test('npm public-release checks reject build metadata without narrowing GitHub SemVer', async () => {
  const { validatePublicRelease } = await publisher();
  for (const version of ['0.1.5+build.1', '0.1.5-rc.1+build.2']) {
    const tag = 'occipital-v' + version;
    const release = releaseRef('refs/tags/' + tag);
    assert.equal(release.version, version);
    assert.throws(() => validatePublicRelease({ tag_name: tag, draft: false, prerelease: release.prerelease }, tag), /build metadata/);
  }
});

test('npm CLI rejects build metadata before writing workflow output', async t => {
  const root = await mkdtemp(join(tmpdir(), 'occipital-npm-input-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const output = join(root, 'github-output');
  for (const tag of ['occipital-v0.1.5+build.1', 'occipital-v0.1.5-rc.1+build.2']) {
    assert.throws(() => execFileSync(process.execPath, [join(repo, 'scripts/release/npm-release.mjs'), 'validate-input', tag], {
      env: { ...process.env, GITHUB_OUTPUT: output }, timeout: 10000, stdio: 'pipe',
    }), error => error.status === 1 && /build metadata/.test(error.stderr.toString()));
    await assert.rejects(readFile(output), { code: 'ENOENT' });
  }
});

test('npm preparation rejects build metadata before creating output or packing', async t => {
  const f = await fixture(t, '0.1.5+build.1'), { prepareNpmRelease } = await publisher();
  let calls = 0;
  await assert.rejects(prepareNpmRelease({ ...f, execute: async () => {
    calls++; throw new Error('Unexpected npm pack');
  } }), /build metadata/);
  assert.equal(calls, 0);
  await assert.rejects(stat(f.output), { code: 'ENOENT' });
});

test('npm publication rejects build metadata in a supplied plan before registry access', async t => {
  const { f, plan } = await planned(t), { publishNpmRelease } = await publisher();
  plan.version += '+build.1'; plan.tag = 'occipital-v' + plan.version;
  for (const row of plan.packages) row.version = plan.version;
  await writeFile(join(f.output, 'plan.json'), JSON.stringify(plan));
  let calls = 0;
  await assert.rejects(publishNpmRelease({ planPath: join(f.output, 'plan.json'), env: host, execute: async () => {
    calls++; throw new Error('Unexpected registry access');
  } }), /build metadata/);
  assert.equal(calls, 0);
  await assert.rejects(stat(join(f.output, 'receipts.json')), { code: 'ENOENT' });
});

test('provenance generation failure stops the native family without a fallback upload', async t => {
  const { f } = await planned(t), { publishNpmRelease } = await publisher();
  let attempts = 0;
  await assert.rejects(publishNpmRelease({ planPath: join(f.output, 'plan.json'), env: host, execute: async (_, args) => {
    if (args[0] === 'view') throw absent();
    assert.equal(args[0], 'publish'); assert.ok(args.includes('--provenance'));
    attempts++; throw new Error('Injected provenance generation failure');
  } }), /Injected provenance generation failure/);
  assert.equal(attempts, 1);
  const receipts = await json(join(f.output, 'receipts.json'));
  assert.deepEqual(receipts.packages.map(row => row.outcome), ['unconfirmed', 'not-started', 'not-started', 'not-started', 'not-started']);
});

test('post-publication verification reads exact version and raw archive, never package-version resolution or a second publish', async t => {
  const { f, plan } = await planned(t), { publishNpmRelease } = await publisher(), requests = [], calls = [];
  const fetcher = registryFetcher(plan), execute = async (_npm, args) => {
    calls.push(args);
    const row = plan.packages.find(row => args[1] === `${row.name}@${row.version}` || args[1] === row.tarball);
    assert.ok(row);
    if (args[0] === 'view') return { stdout: JSON.stringify({ name: row.name, version: row.version, dist: { integrity: row.integrity } }) };
    assert.fail('Existing versions cannot be republished or packed');
  };
  const result = await publishNpmRelease({ planPath: join(f.output, 'plan.json'), env: host, execute,
    fetcher: async (url, options) => { requests.push(String(url)); assert.ok(options.signal); assert.equal(options.redirect, 'error'); return fetcher(url); } });
  assert.equal(calls.length, 5); assert.equal(requests.length, 10);
  assert.equal(requests.filter(url => url.endsWith('/0.1.5')).length, 5);
  assert.equal(requests.filter(url => url.includes('/archive/')).length, 5);
  assert.equal(result.packages.filter(row => row.registryByteVerified).length, 5);
  requests.length = 0;
  await assert.rejects(publishNpmRelease({ planPath: join(f.output, 'plan.json'), env: host, execute,
    fetcher: async url => { requests.push(url); return new Response('{}', { status: 404 }); } }), /HTTP 404/);
  assert.equal(requests.length, 1, 'an unavailable exact version is surfaced, never slept/retried');
});

test('public verification cancels HTTP-error and oversized bodies without replacing the HTTP failure', async t => {
  const { f, plan } = await planned(t), { publishNpmRelease } = await publisher(), row = plan.packages[0];
  const execute = async (_, args) => {
    const item = plan.packages.find(item => args[1] === `${item.name}@${item.version}`);
    assert.equal(args[0], 'view');
    return { stdout: JSON.stringify({ name: item.name, version: item.version, dist: { integrity: item.integrity } }) };
  };
  const expectedSize = (await stat(row.tarball)).size;
  for (const kind of ['metadata', 'archive', 'oversized']) {
    let cancelled = 0;
    const fetcher = async url => {
      const archive = String(url).includes('/archive/');
      if (kind !== 'metadata' && !archive) return Response.json({ name: row.name, version: row.version,
        dist: { integrity: row.integrity, tarball: 'https://registry.npmjs.org/archive/' + row.target } });
      const stream = new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(kind === 'oversized' ? (expectedSize + 1) : 1)); },
        cancel() { cancelled++; if (kind === 'metadata') throw new Error('Cancellation must not replace HTTP failure'); } });
      return new Response(stream, { status: kind === 'metadata' ? 404 : kind === 'archive' ? 503 : 200 });
    };
    await assert.rejects(publishNpmRelease({ planPath: join(f.output, 'plan.json'), env: host, execute, fetcher }),
      kind === 'oversized' ? /Public registry archive differs/ : new RegExp(kind === 'metadata' ? 'HTTP 404' : 'HTTP 503'));
    assert.equal(cancelled, 1, kind);
    assert.equal((await json(join(f.output, 'receipts.json'))).packages.some(item => item.registryByteVerified), false);
  }
});

test('npm target boundaries reject unknown, duplicate, empty and incomplete publication plans before registry access', async t => {
  const f = await fixture(t), { prepareNpmRelease, publishNpmRelease } = await publisher();
  for (const targets of [[], ['unknown'], ['linux-x64-gnu', 'linux-x64-gnu']]) {
    await assert.rejects(prepareNpmRelease({ ...f, targets }));
    await assert.rejects(publishNpmRelease({ planPath: 'absent-plan', targets }));
    await assert.rejects(stat(f.output), { code: 'ENOENT' });
  }
  const plan = await prepareNpmRelease(f), path = join(f.output, 'plan.json');
  for (const packages of [plan.packages.slice(1), [...plan.packages, plan.packages[0]], [{ ...plan.packages[0], target: 'unknown' }, ...plan.packages.slice(1)]]) {
    await writeFile(path, JSON.stringify({ ...plan, packages }));
    let calls = 0;
    await assert.rejects(publishNpmRelease({ planPath: path, env: host, execute: async () => { calls++; } }));
    assert.equal(calls, 0);
  }
});

test('publication prints only safe structured receipts, including uncertain partial failure', async t => {
  const { f, plan } = await planned(t), { publishNpmRelease } = await publisher(), reports = [];
  let attempts = 0;
  await assert.rejects(publishNpmRelease({ planPath: join(f.output, 'plan.json'), env: host,
    report: value => reports.push(JSON.parse(JSON.stringify(value))), execute: async (_, args) => {
      if (args[0] === 'view') throw absent();
      attempts++;
      if (attempts === 2) throw new Error('secret opaque error text');
      const row = plan.packages.find(row => row.tarball === args[1]);
      return { stdout: JSON.stringify([{ name: row.name, version: row.version, integrity: row.integrity }]) };
    } }), /secret opaque/);
  const final = reports.at(-1);
  assert.deepEqual(final, await json(join(f.output, 'receipts.json')));
  assert.deepEqual(Object.keys(final).sort(), ['commit', 'packages', 'version']);
  for (const row of final.packages) assert.deepEqual(Object.keys(row).sort(), ['integrity', 'name', 'outcome', 'version']);
  assert.deepEqual(final.packages.map(row => row.outcome), ['published', 'unconfirmed', 'not-started', 'not-started', 'not-started']);
  assert.doesNotMatch(JSON.stringify(reports), /secret|https:|fixture-only|tarball|npm publish/);
});

test('npm preparation refuses a missing selected CI artifact before packing any package', async t => {
  const f = await fixture(t), { prepareNpmRelease } = await publisher();
  await rm(join(f.directory, artifactName(f.version, 'windows-x64-msvc')), { recursive: true });
  let calls = 0;
  await assert.rejects(prepareNpmRelease({ ...f, execute: async () => { calls++; } }), { code: 'ENOENT' });
  assert.equal(calls, 0);
});
