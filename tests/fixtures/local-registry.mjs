import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { isAbsolute } from 'node:path';

const packageName = /^(@[a-z0-9._-]+\/)?[a-z0-9._-]+$/i;
const digest = value => createHash('sha256').update(value).digest('hex');
async function verifiedFile(path, algorithm, expected, encoding = 'base64') {
  assert.ok(typeof path === 'string' && isAbsolute(path), 'Prepared archive path must be absolute');
  const info = await stat(path);
  assert.ok(info.isFile() && info.size > 0, 'Prepared file must be nonempty');
  const hash = createHash(algorithm);
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  assert.equal(hash.digest(encoding), expected, 'Prepared file integrity mismatch');
  return { path, size: info.size };
}

/** Execution supplies only frozen inputs. prepareMissing is an explicit preparation-only
 * resolver; no public lookup exists without it. OS egress enforcement belongs to the runner.
 */
export async function startLocalRegistry({ packages, documents = [], downloads = [], prepareMissing }) {
  assert.ok(Array.isArray(packages) && packages.length, 'Prepared registry packages are mandatory');
  const manifests = new Map(), files = new Map(), rawRoutes = new Map(), pending = new Map(), archiveSources = new Map();
  const records = new Map();
  async function addPackage(record) {
    assert.ok(record && typeof record.name === 'string' && packageName.test(record.name), 'Invalid prepared package name');
    assert.equal(record.manifest?.name, record.name, 'Prepared manifest name mismatch');
    assert.equal(record.manifest?.version, record.version, 'Prepared manifest version mismatch');
    assert.ok(typeof record.version === 'string' && record.version.length, 'Prepared package version required');
    const integrity = typeof record.integrity === 'string' && /^(sha512|sha256|sha1)-([A-Za-z0-9+/]+={0,2})$/.exec(record.integrity);
    assert.ok(integrity, 'Prepared archive integrity required');
    const identity = `${record.name}@${record.version}`;
    assert.ok(!records.has(identity), 'Duplicate prepared package version');
    const route = `/tarballs/${digest(identity)}.tgz`;
    const file = { ...await verifiedFile(record.path, integrity[1], integrity[2]), kind: 'tarballs' };
    files.set(route, file); records.set(identity, { record, route, file });
    if (record.synthetic === true) {
      if (!manifests.has(record.name)) manifests.set(record.name, { name: record.name, versions: {} });
      manifests.get(record.name).versions[record.version] = { ...structuredClone(record.manifest), dist: { ...record.manifest.dist, integrity: record.integrity, tarball: route } };
    }
    return file;
  }
  for (const record of packages) await addPackage(record);
  function addDocument(name, document) {
    assert.ok(typeof name === 'string' && packageName.test(name) && document.name === name && document.versions && typeof document.versions === 'object', 'Invalid frozen registry document');
    const projected = structuredClone(document);
    for (const [version, manifest] of Object.entries(projected.versions)) {
      assert.equal(manifest.name, name); assert.equal(manifest.version, version);
      const sourceURL = manifest.dist?.tarball;
      assert.equal(typeof sourceURL, 'string', 'Frozen version needs an exact archive URL');
      const route = '/archives/' + digest(sourceURL);
      archiveSources.set(route, { sourceURL, name, version, manifest: document.versions[version] });
      const existing = records.get(`${name}@${version}`);
      if (existing && existing.record.integrity === manifest.dist.integrity) files.set(route, existing.file);
      manifest.dist.tarball = route;
    }
    manifests.set(name, projected);
  }
  for (const record of documents) {
    await verifiedFile(record.path, 'sha256', record.sha256, 'hex');
    addDocument(record.name, JSON.parse(await readFile(record.path, 'utf8')));
  }
  for (const [index, record] of downloads.entries()) {
    assert.ok(typeof record.sourceURL === 'string' && !rawRoutes.has(record.sourceURL), 'Exact unique raw source URL required');
    assert.match(record.sha256, /^[a-f0-9]{64}$/);
    const route = `/downloads/${index}`;
    files.set(route, { ...await verifiedFile(record.path, 'sha256', record.sha256, 'hex'), kind: 'downloads' });
    rawRoutes.set(record.sourceURL, route);
  }
  const requests = [], counts = { manifests: 0, tarballs: 0, downloads: 0, rejected: 0 };
  let url;
  const server = createServer(async (request, response) => {
    const method = request.method, raw = request.url;
    let route;
    try { route = decodeURIComponent(raw); } catch { route = undefined; }
    const readable = method === 'GET' || method === 'HEAD';
    const name = route?.slice(1);
    let document = readable && manifests.get(name), file = readable && files.get(raw);
    try {
      if (readable && !document && !file && prepareMissing && (archiveSources.has(raw) || typeof name === 'string' && packageName.test(name))) {
        const key = archiveSources.has(raw) ? raw : `document:${name}`;
        if (!pending.has(key)) pending.set(key, (async () => {
          if (archiveSources.has(raw)) {
            const record = await prepareMissing({ kind: 'tarball', ...archiveSources.get(raw) });
            const existing = records.get(`${record.name}@${record.version}`);
            if (existing) assert.equal(existing.record.integrity, record.integrity, 'Prepared archive identity changed');
            files.set(raw, existing ? existing.file : await addPackage(record));
          } else addDocument(name, await prepareMissing({ kind: 'document', name }));
        })());
        await pending.get(key); document = manifests.get(name); file = files.get(raw);
      }
      if (!document && !file) {
        counts.rejected++; requests.push({ method, path: raw, kind: 'rejected' });
        response.writeHead(404, { 'content-type': 'application/json' }); response.end('{"error":"undeclared fixture route"}'); return;
      }
      if (document) {
        counts.manifests++; requests.push({ method, path: raw, kind: 'manifests' });
        const projected = structuredClone(document);
        for (const manifest of Object.values(projected.versions)) manifest.dist.tarball = url + manifest.dist.tarball;
        const body = JSON.stringify(projected);
        response.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
        response.end(method === 'HEAD' ? undefined : body); return;
      }
      counts[file.kind]++; requests.push({ method, path: raw, kind: file.kind });
      response.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': file.size });
      if (method === 'HEAD') { response.end(); return; }
      const stream = createReadStream(file.path);
      stream.on('error', error => response.destroy(error)); response.on('close', () => stream.destroy()); stream.pipe(response);
    } catch {
      counts.rejected++; requests.push({ method, path: raw, kind: 'rejected' });
      response.writeHead(503, { 'content-type': 'application/json' }); response.end('{"error":"fixture preparation input unavailable"}');
    }
  });
  await new Promise((yes, no) => { server.once('error', no); server.listen(0, '127.0.0.1', yes); });
  url = `http://127.0.0.1:${server.address().port}`;
  return {
    url, requests,
    counts: () => ({ ...counts }),
    assertNoRejectedRequests() { assert.equal(counts.rejected, 0, 'Unexpected fixture registry request'); },
    downloadURL(sourceURL) { assert.ok(rawRoutes.has(sourceURL), 'Undeclared raw source URL'); return url + rawRoutes.get(sourceURL); },
    async close() { server.closeIdleConnections(); await new Promise((yes, no) => server.close(error => error ? no(error) : yes())); },
  };
}
