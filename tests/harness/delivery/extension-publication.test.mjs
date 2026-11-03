import "../../fixtures/test-guard.mjs";
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { stageExtensionPackage } from '../../../scripts/release/extension-release.mjs';
import { enabledTargets } from '../../../scripts/release/platforms.mjs';

const repository = 'chpock/pi-tidy-ui', name = 'pi-tidy-ui', commit = 'a'.repeat(40);
const run = promisify(execFile), repo = resolve(import.meta.dirname, '../../..');
const publisher = () => import('../../../scripts/release/extension-publication.mjs');
const json = async path => JSON.parse(await readFile(path, 'utf8'));
const integrity = bytes => 'sha512-' + createHash('sha512').update(bytes).digest('base64');
const bytes = Buffer.from('Inert archive bytes; staged payload admission belongs to extension-release.\n');
const registry = '--registry=https://registry.npmjs.org';
const archiveURL = 'https://registry.npmjs.org/pi-tidy-ui/-/fixture.tgz';
function host(version = '0.1.0') {
  const ref = `refs/tags/pi-tidy-ui-v${version}`;
  return { GITHUB_ACTIONS: 'true', GITHUB_REPOSITORY: repository, GITHUB_EVENT_NAME: 'push', GITHUB_REF: ref,
    GITHUB_SHA: commit, GITHUB_WORKFLOW_SHA: commit, GITHUB_WORKFLOW_REF: `${repository}/.github/workflows/ci.yml@${ref}`,
    ACTIONS_ID_TOKEN_REQUEST_URL: 'https://example.invalid/oidc', ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'fixture-only-secret' };
}
async function fixture(t, version = '0.1.0') {
  const root = await mkdtemp(join(tmpdir(), 'extension-publication-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const packageDirectory = join(root, 'extension'); await mkdir(packageDirectory);
  const manifest = { name, version, type: 'module', repository: { type: 'git', url: `git+https://github.com/${repository}.git` } };
  await writeFile(join(packageDirectory, 'package.json'), JSON.stringify(manifest));
  const plan = { ref: `refs/tags/pi-tidy-ui-v${version}`, commit, version, daemonTag: 'occipital-v0.2.0',
    release: { version: '0.2.0', artifacts: [] }, packageDirectory };
  const planPath = join(root, 'plan.json'); await writeFile(planPath, JSON.stringify(plan));
  const calls = [];
  const execute = async (_command, args, options) => {
    calls.push(args);
    assert.equal(args[0], 'pack'); assert.equal(options.cwd, packageDirectory);
    assert.ok(args.includes('--ignore-scripts')); assert.ok(args.includes('--json'));
    const destination = args[args.indexOf('--pack-destination') + 1];
    assert.equal(destination, join(root, 'tarballs'));
    const filename = `${name}-${version}.tgz`;
    await writeFile(join(destination, filename), bytes);
    return { stdout: JSON.stringify([{ name, version, filename, integrity: integrity(bytes) }]) };
  };
  return { root, packageDirectory, manifest, plan, planPath, execute, calls };
}
async function packed(t, version) {
  const f = await fixture(t, version), { packExtensionRelease } = await publisher();
  const publication = await packExtensionRelease({ planPath: f.planPath, execute: f.execute });
  return { ...f, publication, publicationPath: join(f.root, 'publication.json') };
}
function absent() {
  return Object.assign(new Error('fixture E404'), { stdout: JSON.stringify({ error: { code: 'E404' } }) });
}
function existing(row) { return { name, version: row.version, dist: { integrity: row.integrity } }; }
function published(row) { return { stdout: JSON.stringify([{ name, version: row.version, integrity: row.integrity }]) }; }
function publicFetcher(row, requests = []) {
  return async (url, options) => {
    requests.push(String(url));
    assert.equal(options.redirect, 'error'); assert.ok(options.signal);
    if (String(url) === `https://registry.npmjs.org/${name}/${row.version}`) {
      return Response.json({ ...existing(row), dist: { integrity: row.integrity, tarball: archiveURL } });
    }
    assert.equal(String(url), archiveURL);
    return new Response(bytes);
  };
}
function verificationClock(start = 0) {
  let current = start;
  const requestStarts = [], requestTimeouts = [], waits = [];
  return {
    now: () => current,
    advance: milliseconds => { current += milliseconds; },
    wait: async milliseconds => { waits.push(milliseconds); current += milliseconds; },
    timeoutSignal: milliseconds => {
      assert.ok(Number.isInteger(milliseconds) && milliseconds > 0);
      requestStarts.push(current); requestTimeouts.push(milliseconds);
      return new AbortController().signal;
    },
    requestStarts, requestTimeouts, waits, current: () => current,
  };
}
function options(f, extra = {}) {
  return { planPath: f.publicationPath, env: host(f.publication.version), report: () => {}, ...extra };
}

// These bytes are deliberately not a tar archive: preparation, not publication, admits the staged payload.
test('extension packing binds the admitted plan to actual SHA512 bytes without rewriting plan or staged manifest', async t => {
  const f = await fixture(t), { packExtensionRelease } = await publisher();
  const beforePlan = await readFile(f.planPath), beforeManifest = await readFile(join(f.packageDirectory, 'package.json'));
  const publication = await packExtensionRelease({ planPath: f.planPath, execute: f.execute });
  assert.deepEqual(publication, { schema: 1, ref: f.plan.ref, commit, version: '0.1.0', prerelease: false,
    tarball: join(f.root, 'tarballs/pi-tidy-ui-0.1.0.tgz'), integrity: integrity(bytes) });
  assert.deepEqual(await json(join(f.root, 'publication.json')), publication);
  assert.deepEqual(await readFile(publication.tarball), bytes);
  assert.deepEqual(await readFile(f.planPath), beforePlan);
  assert.deepEqual(await readFile(join(f.packageDirectory, 'package.json')), beforeManifest);
  assert.equal(f.calls.length, 1);
});

for (const change of ['name', 'version', 'repository', 'development', 'ref', 'commit', 'build-metadata']) {
  test(`extension packing rejects invalid ${change} before npm runs`, async t => {
    const f = await fixture(t), { packExtensionRelease } = await publisher();
    if (change === 'name') f.manifest.name = 'another-package';
    if (change === 'version') f.manifest.version = '9.0.0';
    if (change === 'repository') f.manifest.repository.url = 'git+https://github.com/other/repo.git';
    if (change === 'ref') f.plan.ref = 'refs/tags/occipital-v0.1.0';
    if (change === 'commit') f.plan.commit = 'not-a-source-sha';
    if (change === 'development' || change === 'build-metadata') {
      f.plan.version = f.manifest.version = change === 'development' ? '0.0.0' : '0.1.0+build.1';
      f.plan.ref = `refs/tags/pi-tidy-ui-v${f.plan.version}`;
    }
    await writeFile(f.planPath, JSON.stringify(f.plan));
    await writeFile(join(f.packageDirectory, 'package.json'), JSON.stringify(f.manifest));
    let calls = 0;
    await assert.rejects(packExtensionRelease({ planPath: f.planPath, execute: async () => { calls++; } }));
    assert.equal(calls, 0);
    await assert.rejects(readFile(join(f.root, 'publication.json')), { code: 'ENOENT' });
  });
}

for (const change of ['name', 'version', 'filename', 'integrity', 'multiple', 'invalid-json']) {
  test(`extension packing refuses ${change} in npm output instead of recording an unverified archive`, async t => {
    const f = await fixture(t), { packExtensionRelease } = await publisher();
    await assert.rejects(packExtensionRelease({ planPath: f.planPath, execute: async (...args) => {
      const result = await f.execute(...args), rows = JSON.parse(result.stdout);
      if (change === 'multiple') rows.push(rows[0]);
      else if (change !== 'invalid-json') rows[0][change] = change === 'filename' ? '../outside.tgz' : 'wrong';
      return { stdout: change === 'invalid-json' ? 'not JSON' : JSON.stringify(rows) };
    } }));
    await assert.rejects(readFile(join(f.root, 'publication.json')), { code: 'ENOENT' });
  });
}

test('extension publication rejects local, PR, manual, wrong repository/ref/source/caller and missing OIDC before npm or fetch', async t => {
  const f = await packed(t), { publishExtensionRelease } = await publisher(), valid = host();
  const candidates = [{}, ...[
    { GITHUB_ACTIONS: 'false' }, { GITHUB_REPOSITORY: 'other/pi-tidy-ui' }, { GITHUB_EVENT_NAME: 'pull_request' },
    { GITHUB_EVENT_NAME: 'workflow_dispatch' }, { GITHUB_REF: 'refs/heads/main' },
    { GITHUB_REF: 'refs/tags/pi-tidy-ui-v0.1.1' }, { GITHUB_REF: 'refs/tags/occipital-v0.1.0' },
    { GITHUB_SHA: 'b'.repeat(40) }, { GITHUB_WORKFLOW_SHA: 'b'.repeat(40) },
    { GITHUB_WORKFLOW_REF: `${repository}/.github/workflows/other.yml@${valid.GITHUB_REF}` },
    { GITHUB_WORKFLOW_REF: `${repository}/.github/workflows/ci.yml@refs/heads/main` },
    { ACTIONS_ID_TOKEN_REQUEST_URL: '' }, { ACTIONS_ID_TOKEN_REQUEST_TOKEN: '' },
  ].map(patch => ({ ...valid, ...patch }))];
  let npmCalls = 0, fetchCalls = 0;
  for (const env of candidates) await assert.rejects(publishExtensionRelease(options(f, { env,
    execute: async () => { npmCalls++; }, fetcher: async () => { fetchCalls++; } })));
  assert.equal(npmCalls, 0); assert.equal(fetchCalls, 0);
});

for (const change of ['schema', 'commit', 'version', 'ref', 'prerelease', 'integrity', 'bytes']) {
  test(`extension publication rejects changed ${change} before registry access`, async t => {
    const f = await packed(t), { publishExtensionRelease } = await publisher();
    if (change === 'bytes') await writeFile(f.publication.tarball, 'tampered archive');
    else {
      const values = { schema: 2, commit: 'invalid', version: '0.1.1', ref: 'refs/heads/main', prerelease: true, integrity: 'sha512-wrong' };
      await writeFile(f.publicationPath, JSON.stringify({ ...f.publication, [change]: values[change] }));
    }
    let calls = 0;
    await assert.rejects(publishExtensionRelease(options(f, { execute: async () => { calls++; }, fetcher: async () => { calls++; } })));
    assert.equal(calls, 0);
  });
}

for (const version of ['0.1.0', '0.1.0-rc.1']) {
  test(`extension ${version} publishes exactly once with provenance and verifies public bytes`, async t => {
    const f = await packed(t, version), { publishExtensionRelease } = await publisher(), calls = [], requests = [];
    const receipt = await publishExtensionRelease(options(f, { fetcher: publicFetcher(f.publication, requests), execute: async (_npm, args) => {
      calls.push(args);
      if (args[0] === 'view') {
        assert.equal(args[1], `${name}@${version}`); assert.ok(args.includes('--json')); assert.ok(args.includes(registry));
        throw absent();
      }
      assert.equal(args[0], 'publish'); assert.equal(args[1], f.publication.tarball);
      for (const flag of ['--provenance', '--ignore-scripts', '--access=public', '--json', registry]) assert.ok(args.includes(flag), flag);
      assert.equal(args.includes('--tag=next'), version.includes('-'));
      assert.equal(args.some(arg => /^--tag(?:=|$)/.test(arg)), version.includes('-'), 'stable retains implicit latest');
      assert.equal(args.some(arg => /force|approve|provenance=false/.test(arg)), false);
      return published(f.publication);
    } }));
    assert.deepEqual(calls.map(args => args[0]), ['view', 'publish']);
    assert.deepEqual(requests, [`https://registry.npmjs.org/${name}/${version}`, archiveURL]);
    assert.deepEqual(receipt, { name, version, commit, integrity: f.publication.integrity, outcome: 'published', registryByteVerified: true });
    assert.deepEqual(await json(join(f.root, 'receipts.json')), receipt);
  });
}

test('fresh extension upload waits through metadata 404 and an existing version waits without another upload', async t => {
  const f = await packed(t), { publishExtensionRelease } = await publisher();
  const calls = [], requests = [], baseFetcher = publicFetcher(f.publication, requests);
  let viewCount = 0, uploads = 0, metadata404s = 2, metadataRequests = 0, archiveRequests = 0;
  const execute = async (_npm, args) => {
    calls.push(args);
    if (args[0] === 'view') {
      viewCount++;
      if (viewCount === 1) throw absent();
      return { stdout: JSON.stringify(existing(f.publication)) };
    }
    uploads++;
    return published(f.publication);
  };
  const fetcher = async (url, fetchOptions) => {
    assert.ok(fetchOptions.signal); assert.equal(fetchOptions.redirect, 'error');
    if (String(url) === `https://registry.npmjs.org/${name}/${f.publication.version}`) {
      metadataRequests++;
      if (metadata404s > 0) { metadata404s--; return new Response('{}', { status: 404 }); }
    } else archiveRequests++;
    return baseFetcher(url, fetchOptions);
  };
  const firstClock = verificationClock(0.25);
  const first = await publishExtensionRelease(options(f, { execute, fetcher, verification: firstClock }));
  assert.equal(first.outcome, 'published'); assert.equal(first.registryByteVerified, true);
  assert.equal(uploads, 1); assert.equal(metadataRequests, 3); assert.equal(archiveRequests, 1);
  assert.deepEqual(firstClock.waits, [5000, 5000]);

  metadata404s = 1;
  const secondClock = verificationClock(3.5);
  const second = await publishExtensionRelease(options(f, { execute, fetcher, verification: secondClock }));
  assert.equal(second.outcome, 'already-published'); assert.equal(second.registryByteVerified, true);
  assert.equal(uploads, 1); assert.equal(metadataRequests, 5); assert.equal(archiveRequests, 2);
  assert.deepEqual(secondClock.waits, [5000]);
  assert.deepEqual(calls.map(args => args[0]), ['view', 'publish', 'view']);
});

test('a matching existing extension version skips upload but still verifies exact registry record and archive', async t => {
  const f = await packed(t), { publishExtensionRelease } = await publisher(), calls = [], requests = [];
  const result = await publishExtensionRelease(options(f, { fetcher: publicFetcher(f.publication, requests), execute: async (_npm, args) => {
    calls.push(args); assert.equal(args[0], 'view');
    return { stdout: JSON.stringify(existing(f.publication)) };
  } }));
  assert.equal(calls.length, 1); assert.equal(requests.length, 2);
  assert.deepEqual(result, { name, version: f.publication.version, commit, integrity: f.publication.integrity,
    outcome: 'already-published', registryByteVerified: true });
});

for (const failure of ['integrity', 'name', 'version', 'null', 'multiple', 'invalid-json', 'E401', 'E500', 'unstructured-E404']) {
  test(`extension registry preflight fails closed on ${failure}, without upload or raw-byte requests`, async t => {
    const f = await packed(t), { publishExtensionRelease } = await publisher(); let calls = 0, fetches = 0;
    await assert.rejects(publishExtensionRelease(options(f, { fetcher: async () => { fetches++; }, execute: async (_npm, args) => {
      calls++; assert.equal(args[0], 'view');
      if (failure.startsWith('E')) throw Object.assign(new Error('registry unavailable'), { stdout: JSON.stringify({ error: { code: failure } }) });
      if (failure === 'unstructured-E404') throw new Error('E404 is only opaque text, not registry absence');
      const item = existing(f.publication);
      if (failure === 'integrity') item.dist.integrity = integrity(Buffer.from('conflicting bytes'));
      if (failure === 'name') item.name = 'other-package';
      if (failure === 'version') item.version = '0.1.1';
      return { stdout: failure === 'invalid-json' ? 'invalid' : JSON.stringify(failure === 'null' ? null : failure === 'multiple' ? [item, item] : item) };
    } })));
    assert.equal(calls, 1); assert.equal(fetches, 0);
  });
}

test('uncertain provenance/upload failure keeps only safe receipts and never retries or leaks npm diagnostics', async t => {
  const f = await packed(t), { publishExtensionRelease } = await publisher(), reports = []; let uploads = 0, fetches = 0;
  const secret = 'PRIVATE_SENTINEL_NPM_OUTPUT';
  await assert.rejects(publishExtensionRelease(options(f, { report: value => reports.push(structuredClone(value)),
    fetcher: async () => { fetches++; }, execute: async (_npm, args) => {
      if (args[0] === 'view') throw absent();
      uploads++; assert.ok(args.includes('--provenance'));
      throw Object.assign(new Error(secret), { stdout: secret, stderr: secret, env: host() });
    } })), error => {
    assert.doesNotMatch(String(error.stack), /PRIVATE_SENTINEL|fixture-only-secret|https:\/\//);
    assert.equal(error.cause, undefined); assert.equal(error.stdout, undefined); assert.equal(error.stderr, undefined);
    return true;
  });
  assert.equal(uploads, 1); assert.equal(fetches, 0);
  const receipt = { name, version: f.publication.version, commit, integrity: f.publication.integrity, outcome: 'unconfirmed' };
  assert.deepEqual(await json(join(f.root, 'receipts.json')), receipt);
  assert.deepEqual(reports.at(-1), receipt);
  assert.doesNotMatch(JSON.stringify(reports), /PRIVATE_SENTINEL|fixture-only-secret|https:|tarball|npm publish/);
  for (const report of reports) assert.deepEqual(Object.keys(report).sort(), ['commit', 'integrity', 'name', 'outcome', 'version']);
});

test('extension verifier preserves safe stage/reason diagnostics and discards poisoned transport details', async t => {
  const f = await packed(t), { publishExtensionRelease } = await publisher();
  const secrets = ['PRIVATE_VERIFY_SENTINEL', 'https://private.invalid/secret-url', '/private/archive/secret-path', 'credential-value', 'stdout-value', 'stderr-value', 'cause-value'];
  const raw = Object.assign(new Error(secrets.join(' '), { cause: new Error('cause-value') }), {
    stdout: 'stdout-value', stderr: 'stderr-value', path: '/private/archive/secret-path',
    url: 'https://private.invalid/secret-url', env: { TOKEN: 'credential-value' },
  });
  await assert.rejects(publishExtensionRelease(options(f, {
    execute: async (_npm, args) => {
      assert.equal(args[0], 'view');
      return { stdout: JSON.stringify(existing(f.publication)) };
    }, fetcher: async () => { throw raw; },
  })), error => {
    assert.equal(error.stage, 'metadata'); assert.equal(error.reason, 'transport'); assert.equal(error.status, undefined);
    assert.equal(error.cause, undefined); assert.equal(error.stdout, undefined); assert.equal(error.stderr, undefined);
    for (const secret of secrets) {
      assert.equal(JSON.stringify(error).includes(secret), false);
      assert.equal(String(error.stack).includes(secret), false);
    }
    return true;
  });
});

test('extension metadata response body-read failures are distinct from invalid JSON and suppress raw errors', async t => {
  const f = await packed(t), { publishExtensionRelease } = await publisher();
  const secret = 'PRIVATE_BODY_STREAM_SENTINEL';
  const raw = new Error(secret);
  await assert.rejects(publishExtensionRelease(options(f, {
    execute: async (_npm, args) => {
      assert.equal(args[0], 'view');
      return { stdout: JSON.stringify(existing(f.publication)) };
    }, fetcher: async () => new Response(new ReadableStream({ start(controller) { controller.error(raw); } }), { status: 200 }),
  })), error => {
    assert.equal(error.stage, 'metadata'); assert.equal(error.reason, 'body-read'); assert.equal(error.status, undefined);
    assert.equal(error.cause, undefined); assert.doesNotMatch(String(error), /PRIVATE_BODY_STREAM_SENTINEL/);
    assert.doesNotMatch(String(error.stack), /PRIVATE_BODY_STREAM_SENTINEL/);
    return true;
  });
  const receipt = await json(join(f.root, 'receipts.json'));
  assert.equal(receipt.outcome, 'already-published');
  assert.equal(receipt.registryByteVerified, undefined);
});

test('extension metadata body consumption counts against the readiness deadline', async t => {
  const f = await packed(t), { publishExtensionRelease } = await publisher(), clock = verificationClock(0.25);
  const item = { ...existing(f.publication), dist: { integrity: f.publication.integrity, tarball: archiveURL } };
  let archiveRequests = 0;
  await assert.rejects(publishExtensionRelease(options(f, { verification: clock,
    execute: async (_npm, args) => {
      assert.equal(args[0], 'view');
      return { stdout: JSON.stringify(existing(f.publication)) };
    }, fetcher: async url => {
      if (String(url) === archiveURL) archiveRequests++;
      return new Response(new ReadableStream({ pull(controller) {
        clock.advance(120000);
        controller.enqueue(new TextEncoder().encode(JSON.stringify(item)));
        controller.close();
      } }, { highWaterMark: 0 }), { status: 200 });
    },
  })), error => {
    assert.equal(error.stage, 'metadata'); assert.equal(error.reason, 'deadline'); assert.equal(error.status, undefined);
    return true;
  });
  assert.equal(clock.current(), 120000.25);
  assert.equal(archiveRequests, 0);
  const receipt = await json(join(f.root, 'receipts.json'));
  assert.equal(receipt.outcome, 'already-published');
  assert.equal(receipt.registryByteVerified, undefined);
});

test('fresh extension upload exhaustion persists published without verification flag or archive request', async t => {
  const f = await packed(t), { publishExtensionRelease } = await publisher(), clock = verificationClock(0.25);
  const calls = [], requests = [];
  let uploads = 0;
  await assert.rejects(publishExtensionRelease(options(f, { verification: clock,
    execute: async (_npm, args) => {
      calls.push(args);
      if (args[0] === 'view') throw absent();
      assert.equal(args[0], 'publish'); uploads++;
      return published(f.publication);
    }, fetcher: async (url, fetchOptions) => {
      assert.ok(fetchOptions.signal); assert.equal(fetchOptions.redirect, 'error');
      requests.push(String(url));
      return new Response('{}', { status: 404 });
    },
  })), error => {
    assert.equal(error.stage, 'metadata'); assert.equal(error.reason, 'not-found'); assert.equal(error.status, 404);
    return true;
  });
  assert.deepEqual(calls.map(args => args[0]), ['view', 'publish']);
  assert.equal(uploads, 1);
  assert.equal(requests.length, 24);
  assert.equal(requests.every(url => url === `https://registry.npmjs.org/${name}/${f.publication.version}`), true);
  assert.equal(requests.some(url => url === archiveURL), false);
  assert.deepEqual(clock.waits, Array(24).fill(5000));
  const receipt = await json(join(f.root, 'receipts.json'));
  assert.equal(receipt.outcome, 'published');
  assert.equal(receipt.registryByteVerified, undefined);
});

test('unstructured npm view failure is sanitized rather than mistaken for absence', async t => {
  const f = await packed(t), { publishExtensionRelease } = await publisher(); let calls = 0;
  await assert.rejects(publishExtensionRelease(options(f, { execute: async () => {
    calls++; throw Object.assign(new Error('PRIVATE_VIEW_SENTINEL'), { stdout: 'PRIVATE_VIEW_SENTINEL', stderr: 'PRIVATE_VIEW_SENTINEL' });
  } })), error => {
    assert.doesNotMatch(String(error.stack), /PRIVATE_VIEW_SENTINEL/); assert.equal(error.cause, undefined);
    assert.equal(error.stdout, undefined); assert.equal(error.stderr, undefined); return true;
  });
  assert.equal(calls, 1);
});

test('non-404 metadata HTTP failure is classified immediately without a later successful retry', async t => {
  const f = await packed(t), { publishExtensionRelease } = await publisher();
  let requests = 0, uploads = 0, archiveRequests = 0;
  await assert.rejects(publishExtensionRelease(options(f, {
    execute: async (_npm, args) => {
      if (args[0] === 'view') return { stdout: JSON.stringify(existing(f.publication)) };
      uploads++; return published(f.publication);
    }, fetcher: async (url, fetchOptions) => {
      assert.ok(fetchOptions.signal); assert.equal(fetchOptions.redirect, 'error'); requests++;
      if (String(url) === `https://registry.npmjs.org/${name}/${f.publication.version}`) return new Response('{}', { status: 503 });
      archiveRequests++;
      return Response.json({ ...existing(f.publication), dist: { integrity: f.publication.integrity, tarball: archiveURL } });
    },
  })), error => {
    assert.equal(error.stage, 'metadata'); assert.equal(error.reason, 'http-status'); assert.equal(error.status, 503);
    return true;
  });
  assert.equal(requests, 1); assert.equal(archiveRequests, 0); assert.equal(uploads, 0);
  const receipt = await json(join(f.root, 'receipts.json'));
  assert.equal(receipt.outcome, 'already-published'); assert.equal(receipt.registryByteVerified, undefined);
});

for (const failure of ['metadata-http', 'metadata-json', 'metadata-name', 'metadata-version', 'metadata-integrity', 'unsafe-http', 'unsafe-host', 'unsafe-user', 'unsafe-port',
  'metadata-redirect', 'archive-redirect', 'archive-http-404', 'archive-http-503', 'short', 'hash', 'oversized']) {
  test(`extension raw registry verification rejects ${failure} without republishing`, async t => {
    const f = await packed(t), { publishExtensionRelease } = await publisher(), verification = verificationClock();
    let npmCalls = 0, requests = 0, cancelled = 0;
    const urls = { 'unsafe-http': 'http://registry.npmjs.org/archive', 'unsafe-host': 'https://other.invalid/archive',
      'unsafe-user': 'https://user@registry.npmjs.org/archive', 'unsafe-port': 'https://registry.npmjs.org:444/archive' };
    const fetcher = async (url, fetchOptions) => {
      requests++; assert.equal(fetchOptions.redirect, 'error'); assert.ok(fetchOptions.signal);
      const archive = String(url) === archiveURL;
      if (failure === (archive ? 'archive-redirect' : 'metadata-redirect')) throw new TypeError('redirect refused');
      if (!archive) {
        if (failure === 'metadata-http') return new Response('{}', { status: 404 });
        if (failure === 'metadata-json') return new Response('not JSON');
        const record = { ...existing(f.publication), dist: { integrity: f.publication.integrity, tarball: urls[failure] || archiveURL } };
        if (failure === 'metadata-name') record.name = 'other';
        if (failure === 'metadata-version') record.version = '0.1.1';
        if (failure === 'metadata-integrity') record.dist.integrity = integrity(Buffer.from('other'));
        return Response.json(record);
      }
      if (failure.startsWith('archive-http-')) return new Response('unavailable', { status: Number(failure.slice('archive-http-'.length)) });
      if (failure === 'oversized') return new Response(new ReadableStream({
        start(controller) { controller.enqueue(new Uint8Array(bytes.length + 1)); }, cancel() { cancelled++; },
      }));
      return new Response(failure === 'short' ? bytes.subarray(1) : Buffer.alloc(bytes.length));
    };
    await assert.rejects(publishExtensionRelease(options(f, { fetcher, verification, execute: async (_npm, args) => {
      npmCalls++; assert.equal(args[0], 'view'); return { stdout: JSON.stringify(existing(f.publication)) };
    } })), error => {
      if (failure === 'metadata-http') {
        assert.equal(error.stage, 'metadata'); assert.equal(error.reason, 'not-found'); assert.equal(error.status, 404);
      } else if (failure === 'metadata-json') {
        assert.equal(error.stage, 'metadata'); assert.equal(error.reason, 'invalid-json');
      } else if (failure.startsWith('metadata-') && !failure.endsWith('redirect')) {
        assert.equal(error.stage, 'metadata'); assert.equal(error.reason, 'identity-mismatch');
      } else if (failure.startsWith('unsafe-')) {
        assert.equal(error.stage, 'metadata'); assert.equal(error.reason, 'unsafe-url');
      } else if (failure.startsWith('metadata-') || failure === 'archive-redirect') {
        assert.equal(error.stage, failure.startsWith('metadata-') ? 'metadata' : 'archive'); assert.equal(error.reason, 'transport');
      } else {
        assert.equal(error.stage, 'archive');
        assert.equal(error.reason, failure.startsWith('archive-http-') ? 'http-status' : failure === 'oversized' || failure === 'short' ? 'size-mismatch' : 'integrity-mismatch');
        if (failure.startsWith('archive-http-')) assert.equal(error.status, Number(failure.slice('archive-http-'.length)));
      }
      return true;
    });
    assert.equal(npmCalls, 1);
    assert.equal(requests, failure === 'metadata-http' ? 24 : failure.startsWith('metadata-') || failure.startsWith('unsafe-') ? 1 : 2);
    if (failure === 'metadata-http') assert.deepEqual(verification.waits, Array(24).fill(5000));
    if (failure === 'oversized') assert.equal(cancelled, 1, 'bounded stream is cancelled at the first oversized chunk');
    assert.notEqual((await json(join(f.root, 'receipts.json'))).registryByteVerified, true);
  });
}

test('a successful upload with wrong npm response identity remains unconfirmed and is not retried', async t => {
  const f = await packed(t), { publishExtensionRelease } = await publisher(); let uploads = 0, fetches = 0;
  await assert.rejects(publishExtensionRelease(options(f, { fetcher: async () => { fetches++; }, execute: async (_npm, args) => {
    if (args[0] === 'view') throw absent();
    uploads++; return { stdout: JSON.stringify([{ name: 'other', version: '0.1.0', integrity: f.publication.integrity }]) };
  } })));
  assert.equal(uploads, 1); assert.equal(fetches, 0);
  assert.equal((await json(join(f.root, 'receipts.json'))).outcome, 'unconfirmed');
});

test('real staged extension packs exact metadata/native pins and verifies its actual archive without scripts or public mutation', async t => {
  const f = await fixture(t), { packExtensionRelease, publishExtensionRelease } = await publisher();
  const source = join(f.root, 'source'); await mkdir(join(source, 'src/occipital'), { recursive: true });
  const sentinel = join(f.root, 'lifecycle-ran');
  const manifest = { ...f.manifest, version: '0.0.0', files: ['src', 'README.md', 'CHANGELOG.md', 'LICENSE'], pi: { changelogPath: '' },
    description: 'Offline publication fixture', keywords: ['pi-package'], author: { name: 'Fixture' },
    scripts: { prepack: `node -e ${JSON.stringify(`require('node:fs').writeFileSync(${JSON.stringify(sentinel)}, 'unexpected')`)}` } };
  await writeFile(join(source, 'package.json'), JSON.stringify(manifest));
  await writeFile(join(source, 'README.md'), 'Inert fixture; not a real native or public release.\n');
  await writeFile(join(source, 'LICENSE'), 'MIT fixture\n');
  await writeFile(join(source, 'CHANGELOG.md'), '# Changes\n\n## [Unreleased]\n');
  await writeFile(join(source, 'src/occipital/release.ts'), await readFile(join(repo, 'src/occipital/release.ts')));
  const release = JSON.parse(await readFile(join(repo, 'tests/fixtures/occipital-release-0.1.4.json'), 'utf8'));
  const packageDirectory = join(f.root, 'staged-extension');
  await stageExtensionPackage({ root: source, output: packageDirectory, version: '0.1.0', release });
  await writeFile(f.planPath, JSON.stringify({ ...f.plan, packageDirectory }));
  const publication = await packExtensionRelease({ planPath: f.planPath,
    execute: (command, args, options) => run(command, args, { ...options,
      env: { ...process.env, npm_config_ignore_scripts: 'false' } }) });
  await assert.rejects(readFile(sentinel), { code: 'ENOENT' }, 'explicit --ignore-scripts beats an environment permitting scripts');
  const archiveBytes = await readFile(publication.tarball);
  const archived = JSON.parse((await run('tar', ['-xOf', publication.tarball, 'package/package.json'], { timeout: 10000 })).stdout);
  assert.equal(archived.name, name); assert.equal(archived.version, '0.1.0');
  for (const field of ['description', 'keywords', 'author', 'repository']) assert.deepEqual(archived[field], manifest[field]);
  for (const target of enabledTargets()) assert.equal(archived.optionalDependencies[`@kchpock/occipital-${target}`], release.version);
  const declaration = (await run('tar', ['-xOf', publication.tarball, 'package/src/occipital/release.ts'], { timeout: 10000 })).stdout;
  const native = JSON.parse(declaration.match(/export const NATIVE_RELEASE[^=]*= ([\s\S]*);\s*$/)[1]);
  assert.equal(native.version, release.version); assert.deepEqual(native.artifacts.map(row => row.target).sort(), [...enabledTargets()].sort());
  assert.equal((await json(join(source, 'package.json'))).version, '0.0.0');
  assert.equal(publication.integrity, integrity(archiveBytes));
  const calls = [];
  const receipt = await publishExtensionRelease({ planPath: join(f.root, 'publication.json'), env: host(), report: () => {},
    execute: async (_npm, args) => {
      calls.push(args[0]);
      if (args[0] === 'view') throw absent();
      assert.equal(args[0], 'publish'); assert.equal(args[1], publication.tarball);
      return published(publication);
    }, fetcher: async url => String(url) === archiveURL ? new Response(archiveBytes)
      : Response.json({ name, version: publication.version, dist: { integrity: publication.integrity, tarball: archiveURL } }) });
  assert.deepEqual(calls, ['view', 'publish']); assert.equal(receipt.registryByteVerified, true);
});
