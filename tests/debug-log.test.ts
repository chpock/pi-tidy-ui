import './fixtures/test-guard.mjs';
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { TextJournal, cleanupJournals } from "../src/debug-log.ts";

async function fixture(t: test.TestContext) {
  const root = await fs.mkdtemp(join(tmpdir(), "tidy-ui-log-test-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const identity = { session: "session-a", name: "Example", cwd: "/work/example", pi: "1.0.0", extension: "0.0.0", reason: "startup" };
  return { root, identity };
}

function observedIO() {
  const counts = { probes: 0, scans: 0, writes: 0 };
  const io = { ...fs,
    lstat: (...args: Parameters<typeof fs.lstat>) => { counts.probes++; return fs.lstat(...args); },
    readdir: (...args: Parameters<typeof fs.readdir>) => { counts.scans++; return fs.readdir(...args); },
    open: async (...args: Parameters<typeof fs.open>) => {
      const handle = await fs.open(...args), writev = handle.writev.bind(handle);
      handle.writev = <T extends readonly NodeJS.ArrayBufferView[]>(buffers: T, position?: number) => { counts.writes++; return writev(buffers, position); };
      return handle;
    },
  } as typeof fs;
  return { io, counts };
}

test("debug log: readable identity and separate runs of the same session; only text journals", async t => {
  const { root, identity } = await fixture(t);
  const first = new TextJournal(identity, { root }), second = new TextJournal(identity, { root });
  await Promise.all([first.ready, second.ready]);
  assert.equal(first.status().state, "active");
  assert.notEqual(first.status().path, second.status().path);
  first.record("DEBUG", "syntax", "Pi returned plain text; fallback result cached", { call: "w1", revision: 1 });
  await first.flush();
  const text = await fs.readFile(first.status().path, "utf8");
  assert.match(text, /Session started.*session=session-a/u);
  assert.match(text, /Workspace: \/work\/example/u);
  assert.match(text, /Extension: pi-tidy-ui 0\.0\.0; Pi 1\.0\.0/u);
  assert.match(text, /DEBUG \[syntax\] Pi returned plain text; fallback result cached.*call=w1.*revision=1/u);
  await Promise.all([first.close("shutdown"), second.close("shutdown")]);
  const overview = await fs.readFile(join(root, "sessions.log"), "utf8");
  assert.equal((overview.match(/Session started/gu) ?? []).length, 2);
  assert.equal((overview.match(/Session ended/gu) ?? []).length, 2);
  assert.match(overview, /reason=shutdown/u);
  assert.ok((await fs.readdir(root)).every(name => /\.log(?:\.1)?$/u.test(name)));
  if (process.platform !== "win32") {
    assert.equal((await fs.stat(root)).mode & 0o777, 0o700);
    assert.equal((await fs.stat(first.status().path)).mode & 0o777, 0o600);
  }
});

test("debug log: batches bursts with no ordinary size probes or scans and no idle timer", async t => {
  const { root, identity } = await fixture(t), { io, counts } = observedIO();
  const journal = new TextJournal(identity, { root, io, limits: { flushDelayMs: 60_000 } });
  await journal.ready;
  const before = { ...counts };
  for (let i = 0; i < 100; i++) journal.record("DEBUG", "cache", "Layout built", { call: `w${i}`, width: 80 });
  assert.deepEqual(counts, before);
  assert.equal(journal.status().timer, true);
  await journal.flush();
  assert.equal(counts.writes - before.writes, 1);
  assert.equal(counts.probes, before.probes);
  assert.equal(counts.scans, before.scans);
  assert.equal(journal.status().pendingBytes, 0);
  assert.equal(journal.status().timer, false);
  const settled = { ...counts };
  await journal.flush();
  assert.deepEqual(counts, settled);
  await journal.close("shutdown");
  journal.record("DEBUG", "cache", "Late old-owner result", {});
  await journal.flush();
  assert.equal(journal.status().timer, false);
});

test("debug log: UTF-8 records and rotated files stay bounded; headers repeat", async t => {
  const { root, identity } = await fixture(t);
  const journal = new TextJournal(identity, { root, limits: { fileBytes: 2048, recordBytes: 256, batchBytes: 1024 } });
  await journal.ready;
  for (let i = 0; i < 60; i++) journal.record("DEBUG", "syntax", "Color choice", { call: `w${i}`, note: "🙂".repeat(10_000) });
  await journal.flush();
  const path = journal.status().path;
  assert.ok(journal.status().rotations > 0);
  for (const name of [path, `${path}.1`]) {
    const bytes = await fs.readFile(name);
    assert.ok(bytes.byteLength <= 2048, `${bytes.byteLength} bytes`);
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    assert.match(text, /Session started.*session=session-a/u);
    assert.match(text, /\[shortened\]/u);
  }
  await journal.close("shutdown");
  assert.match(journal.status().path, /\.closed\.log$/u);
  assert.ok((await fs.stat(journal.status().path)).size <= 2048);
});

test("debug log: escapes controls and never invokes arbitrary object serialization", async t => {
  const { root, identity } = await fixture(t);
  const journal = new TextJournal({ ...identity, name: "Example\n\x1b[31m" }, { root });
  await journal.ready;
  let calls = 0;
  const opaque = { toString() { calls++; return "SECRET"; }, toJSON() { calls++; return "SECRET"; } };
  journal.record("WARN", "runtime", "Operation failed", { code: "EIO", location: "a\rb\x1b[31m", opaque } as never);
  await journal.flush();
  const text = await fs.readFile(journal.status().path, "utf8");
  assert.match(text, /Example\\n\\x1b\[31m/u);
  assert.match(text, /a\\rb\\x1b\[31m/u);
  assert.equal(calls, 0);
  assert.ok(!text.includes("SECRET"));
  assert.ok(!text.includes("\x1b"));
  await journal.close("shutdown");
});

test("debug log: slow write credits include in-flight data; losses get a readable notice", async t => {
  const { root, identity } = await fixture(t);
  let release!: () => void, entered!: () => void, hold = false;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const writing = new Promise<void>(resolve => { entered = resolve; });
  const io = { ...fs, open: async (...args: Parameters<typeof fs.open>) => {
    const handle = await fs.open(...args), writev = handle.writev.bind(handle);
    handle.writev = async <T extends readonly NodeJS.ArrayBufferView[]>(buffers: T, position?: number) => {
      if (hold) { hold = false; entered(); await gate; }
      return writev(buffers, position);
    };
    return handle;
  } } as typeof fs;
  const journal = new TextJournal(identity, { root, io, limits: { bufferBytes: 4096, batchBytes: 512, recordBytes: 256, flushDelayMs: 60_000 } });
  await journal.ready;
  hold = true;
  journal.record("DEBUG", "runtime", "First operation completed");
  const flushing = journal.flush();
  await writing;
  for (let i = 0; i < 1000; i++) journal.record("DEBUG", "cache", "Layout built", { call: `w${i}` });
  assert.ok(journal.status().pendingBytes + journal.status().inFlightBytes <= 4096);
  assert.ok(journal.status().dropped > 0);
  assert.ok(journal.status().inFlightBytes > 0);
  release();
  await flushing;
  assert.match(await fs.readFile(journal.status().path, "utf8"), /WARN +\[logging\].*diagnostic records omitted/u);
  assert.equal(journal.status().pendingBytes, 0);
  assert.equal(journal.status().inFlightBytes, 0);
  await journal.close("shutdown");
});

test("debug log: write failure disables capture, releases queue and warns once without console fallback", async t => {
  const { root, identity } = await fixture(t);
  let fail = false;
  const warnings: string[] = [];
  const io = { ...fs, open: async (...args: Parameters<typeof fs.open>) => {
    const handle = await fs.open(...args), writev = handle.writev.bind(handle);
    handle.writev = async <T extends readonly NodeJS.ArrayBufferView[]>(buffers: T, position?: number) => {
      if (fail) throw Object.assign(new Error("SECRET external data"), { code: "ENOSPC" });
      return writev(buffers, position);
    };
    return handle;
  } } as typeof fs;
  const journal = new TextJournal(identity, { root, io, warn: message => warnings.push(message) });
  await journal.ready;
  fail = true;
  journal.record("ERROR", "runtime", "Operation failed", { code: "EIO" });
  await journal.flush();
  assert.equal(journal.status().state, "failed");
  assert.equal(journal.status().pendingBytes, 0);
  assert.equal(journal.status().timer, false);
  journal.record("DEBUG", "runtime", "Cannot restart implicitly");
  await journal.flush();
  assert.equal(warnings.length, 1);
  assert.match(warnings[0]!, /pi-tidy-ui.*ENOSPC/u);
  assert.ok(!warnings[0]!.includes("SECRET"));
  await journal.close("shutdown");
});

test("debug log: common failure does not disable the healthy detailed journal", async t => {
  const { root, identity } = await fixture(t), warnings: string[] = [];
  await fs.mkdir(join(root, "sessions.log"));
  const journal = new TextJournal(identity, { root, warn: message => warnings.push(message) });
  await journal.ready;
  assert.equal(journal.status().state, "active");
  assert.equal(journal.status().commonFailed, true);
  journal.record("INFO", "runtime", "Presentation installed");
  await journal.flush();
  assert.match(await fs.readFile(journal.status().path, "utf8"), /Presentation installed/u);
  await journal.close("shutdown");
  assert.equal(warnings.length, 1);
});

async function retainedPair(root: string, id: number, pid: number, closed: boolean, modified: number) {
  const path = join(root, `20261005T120000000Z-session-${pid}-00000000-0000-4000-8000-${String(id).padStart(12, "0")}${closed ? ".closed" : ""}.log`);
  await fs.writeFile(path, "recent last record\n", { mode: 0o600 });
  await fs.writeFile(`${path}.1`, "predecessor\n", { mode: 0o600 });
  await Promise.all([fs.utimes(path, modified / 1000, modified / 1000), fs.utimes(`${path}.1`, modified / 1000, modified / 1000)]);
  return path;
}

test("debug log: retention uses last write, newest pair member and count, not filename time", async t => {
  const { root } = await fixture(t), now = Date.now();
  const old = await retainedPair(root, 1, process.pid, true, now - 8 * 86400_000);
  const recent = await retainedPair(root, 2, process.pid, true, now - 1_000);
  const predecessorFresh = await retainedPair(root, 3, process.pid, true, now - 8 * 86400_000);
  await fs.utimes(`${predecessorFresh}.1`, now / 1000, now / 1000);
  const tooMany = await retainedPair(root, 4, process.pid, true, now - 2_000);
  await cleanupJournals(root, { now, keep: 2, ageMs: 7 * 86400_000 });
  assert.equal(await fs.stat(old).then(() => true, () => false), false);
  assert.equal(await fs.stat(tooMany).then(() => true, () => false), false);
  assert.ok(await fs.stat(recent));
  assert.ok(await fs.stat(predecessorFresh));
});

test("debug log: cleanup preserves active/unknown PIDs, foreign files and links", async t => {
  const { root } = await fixture(t), now = Date.now();
  const active = await retainedPair(root, 1, process.pid, false, 1);
  const dead = await retainedPair(root, 2, 999999, false, 1);
  const unknown = await retainedPair(root, 3, 999998, false, 1);
  const foreign = join(root, "someone-elses.log");
  await fs.writeFile(foreign, "foreign\n");
  await cleanupJournals(root, { now, keep: 0, ageMs: 1, alive: pid => pid !== 999999 });
  assert.ok(await fs.stat(active));
  assert.ok(await fs.stat(unknown));
  assert.ok(await fs.stat(foreign));
  assert.equal(await fs.stat(dead).then(() => true, () => false), false);
  if (process.platform !== "win32") {
    const outside = await fs.mkdtemp(join(tmpdir(), "tidy-ui-log-outside-"));
    t.after(() => fs.rm(outside, { recursive: true, force: true }));
    const target = join(outside, "keep.log"), link = join(root, "20261005T120000000Z-session-999999-00000000-0000-4000-8000-000000000005.closed.log");
    await fs.writeFile(target, "not ours");
    await fs.symlink(target, link);
    await cleanupJournals(root, { now, keep: 0, ageMs: 1 });
    assert.equal(await fs.readFile(target, "utf8"), "not ours");
    assert.equal((await fs.lstat(link)).isSymbolicLink(), true);
  }
});

test("debug log: maintenance has no idle timer and runs only after six hours of existing work", async t => {
  const { root, identity } = await fixture(t), { io, counts } = observedIO();
  let now = Date.now();
  const journal = new TextJournal(identity, { root, io, now: () => now });
  await journal.ready;
  const scans = counts.scans;
  now += 5 * 3600_000;
  journal.record("DEBUG", "runtime", "Existing activity");
  await journal.flush();
  assert.equal(counts.scans, scans);
  now += 3600_000;
  await journal.flush();
  assert.equal(counts.scans, scans, "empty capture cannot schedule housekeeping");
  journal.record("DEBUG", "runtime", "Existing activity");
  await journal.flush();
  assert.equal(counts.scans, scans + 1);
  assert.equal(journal.status().timer, false);
  await journal.close("shutdown");
});


test("debug log: partial writev completes exactly once without corrupting UTF-8", async t => {
  const { root, identity } = await fixture(t);
  const io = { ...fs, open: async (...args: Parameters<typeof fs.open>) => {
    const handle = await fs.open(...args), writev = handle.writev.bind(handle);
    handle.writev = async <T extends readonly NodeJS.ArrayBufferView[]>(buffers: T, position?: number) => {
      const first = buffers[0]!;
      const piece = Buffer.from(first.buffer, first.byteOffset, Math.min(first.byteLength, 7));
      const result = await writev([piece], position);
      return { ...result, buffers };
    };
    return handle;
  } } as typeof fs;
  const journal = new TextJournal(identity, { root, io });
  await journal.ready;
  journal.record("INFO", "syntax", "Native colors selected", { call: "é🙂", version: 3 });
  await journal.flush();
  const bytes = await fs.readFile(journal.status().path);
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  assert.equal((text.match(/Native colors selected/gu) ?? []).length, 1);
  assert.match(text, /call=é🙂 version=3/u);
  assert.equal(journal.status().bytes, bytes.length);
  await journal.close("quit");
});

test("debug log: unsafe journal roots and common-file links never write outside the private directory", async t => {
  if (process.platform === "win32") { t.skip("POSIX symlink/mode control; Windows ACL behavior is not established"); return; }
  const { root, identity } = await fixture(t);
  const outside = join(root, "outside"); await fs.mkdir(outside, { mode: 0o700 });
  const link = join(root, "link"); await fs.symlink(outside, link);
  const warnings: string[] = [];
  const rejected = new TextJournal(identity, { root: link, warn: message => { warnings.push(message); } });
  await rejected.ready; await rejected.close("quit");
  assert.equal(rejected.status().state, "failed");
  assert.deepEqual(await fs.readdir(outside), []);
  assert.equal(warnings.length, 1);
  const trailing = new TextJournal(identity, { root: `${link}/` });
  await trailing.ready; await trailing.close("quit");
  assert.equal(trailing.status().state, "failed");
  assert.deepEqual(await fs.readdir(outside), []);
  const unsafe = join(root, "unsafe"); await fs.mkdir(unsafe, { mode: 0o755 }); await fs.chmod(unsafe, 0o755);
  const permissions = new TextJournal(identity, { root: unsafe });
  await permissions.ready; await permissions.close("quit");
  assert.equal(permissions.status().failure, "start journal: EACCES");
  assert.deepEqual(await fs.readdir(unsafe), []);
  const target = join(outside, "must-not-change"); await fs.writeFile(target, "untouched");
  await fs.symlink(target, join(root, "sessions.log"));
  const healthy = new TextJournal(identity, { root });
  await healthy.ready;
  assert.equal(healthy.status().commonFailed, true);
  assert.equal(healthy.status().state, "active");
  healthy.record("INFO", "runtime", "Detailed capture remains available"); await healthy.close("quit");
  assert.equal(await fs.readFile(target, "utf8"), "untouched");
});

test("debug log: close wait is bounded while an existing write is delayed; no late records or new timers", async t => {
  const { root, identity } = await fixture(t);
  let release!: () => void, entered!: () => void, hold = false;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const writing = new Promise<void>(resolve => { entered = resolve; });
  const io = { ...fs, open: async (...args: Parameters<typeof fs.open>) => {
    const handle = await fs.open(...args), writev = handle.writev.bind(handle);
    handle.writev = async <T extends readonly NodeJS.ArrayBufferView[]>(buffers: T, position?: number) => {
      if (hold) { hold = false; entered(); await gate; }
      return writev(buffers, position);
    };
    return handle;
  } } as typeof fs;
  const journal = new TextJournal(identity, { root, io, limits: { closeWaitMs: 5 } });
  await journal.ready;
  hold = true; journal.record("INFO", "runtime", "Pending operation");
  const draining = journal.flush(); await writing;
  await journal.close("reload");
  assert.ok(journal.status().inFlightBytes > 0, "bounded close did not wait for the delayed write");
  const before = journal.status().records;
  journal.record("INFO", "runtime", "Late completion must not enter a new session");
  assert.equal(journal.status().records, before);
  assert.equal(journal.status().timer, false);
  release(); await draining;
  // finishClose follows the fulfilled drain; wait on its real I/O, not a duration.
  const completed = new Promise<void>((resolve, reject) => {
    const deadline = Date.now() + 2000;
    const check = () => {
      if (Date.now() > deadline) { reject(new Error("close did not complete after releasing the real write")); return; }
      if (journal.status().state === "closed") resolve();
      else if (journal.status().state === "failed") reject(new Error(journal.status().failure));
      else setImmediate(check);
    };
    check();
  });
  await completed;
  assert.equal(journal.status().pendingBytes, 0);
  assert.equal(journal.status().inFlightBytes, 0);
});

test("debug log: concurrent real processes keep separate bounded detailed files; common rotation is best-effort", async t => {
  const { spawn } = await import("node:child_process");
  const { root } = await fixture(t);
  const module = new URL("../src/debug-log.ts", import.meta.url).href;
  await Promise.all(Array.from({ length: 8 }, (_, index) => new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", `
      import { TextJournal } from ${JSON.stringify(module)};
      const journal = new TextJournal({session:'child-${index}', cwd:'/example', extension:'0.0.0', pi:'1.0.0', reason:'startup'},
        {root:${JSON.stringify(root)}, limits:{commonBytes:512, recordBytes:256}});
      await journal.ready;
      if(journal.status().state!=='active') throw new Error('journal did not start');
      for(let i=0;i<20;i++) journal.record('DEBUG','runtime','Child operation completed',{sequence:i});
      await journal.close('quit');
      if(journal.status().state!=='closed') throw new Error('journal did not close');
    `], { stdio: ["ignore", "ignore", "pipe"] });
    let errors = ""; child.stderr.on("data", data => { errors += String(data); });
    child.on("error", reject);
    child.on("exit", code => { if (code === 0) resolve(); else reject(new Error(`Child ${index} exited ${code}: ${errors}`)); });
  })));
  const files = await fs.readdir(root), details = files.filter(file => file.endsWith(".closed.log"));
  assert.equal(details.length, 8);
  for (const file of details) {
    const contents = await fs.readFile(join(root, file), "utf8");
    assert.equal((contents.match(/Child operation completed/gu) ?? []).length, 20);
    assert.match(contents, /Session run ended/u);
    assert.ok(Buffer.byteLength(contents) <= 4 * 1024 * 1024);
  }
  for (const file of files.filter(file => /^sessions\.log(?:\.1)?$/u.test(file))) {
    assert.ok((await fs.stat(join(root, file))).size <= 512 + 8 * 2 * 256, "concurrency may overshoot, not grow without a bounded append");
  }
});


test("debug log review F1: a record arriving between drain and pump settlement is not stranded", async t => {
  const { root, identity } = await fixture(t);
  const journal = new TextJournal(identity, { root, limits: { flushDelayMs: 60_000 } });
  await journal.ready;
  const pending = journal.flush();
  queueMicrotask(() => journal.record("INFO", "runtime", "Accepted at settlement boundary"));
  await pending;
  assert.equal(journal.status().pendingBytes, 0);
  assert.equal(journal.status().timer, false);
  assert.match(await fs.readFile(journal.status().path, "utf8"), /Accepted at settlement boundary/u);
  await journal.close("quit");
});

test("debug log review F1: close arriving at pump settlement writes its end record before releasing the file", async t => {
  const { root, identity } = await fixture(t);
  const journal = new TextJournal(identity, { root, limits: { flushDelayMs: 60_000 } });
  await journal.ready;
  const pending = journal.flush();
  let close!: Promise<void>;
  queueMicrotask(() => { close = journal.close("switch"); });
  await pending; await close;
  assert.equal(journal.status().state, "closed");
  assert.equal(journal.status().pendingBytes, 0);
  assert.equal(journal.status().timer, false);
  assert.match(await fs.readFile(journal.status().path, "utf8"), /Session run ended.*reason=switch/u);
});

test("debug log review F2: reaching the byte threshold flushes despite the previously armed delay", async t => {
  const { root, identity } = await fixture(t);
  let observed!: () => void, active = false;
  const written = new Promise<void>(resolve => { observed = resolve; });
  const io = { ...fs, open: async (...args: Parameters<typeof fs.open>) => {
    const handle = await fs.open(...args), writev = handle.writev.bind(handle);
    handle.writev = async <T extends readonly NodeJS.ArrayBufferView[]>(buffers: T, position?: number) => {
      const result = await writev(buffers, position);
      if (active) observed();
      return result;
    };
    return handle;
  } } as typeof fs;
  const journal = new TextJournal(identity, { root, io, limits: { flushDelayMs: 60_000, batchBytes: 512 } });
  await journal.ready;
  active = true;
  journal.record("INFO", "runtime", "One small record arms a delay");
  assert.equal(journal.status().timer, true);
  journal.record("INFO", "runtime", "A following record crosses the byte threshold", { metadata: "a".repeat(600) });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([written, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error("no threshold-triggered real write")), 2000);
    })]);
  } finally { clearTimeout(timer); await journal.close("quit"); }
  assert.equal(journal.status().pendingBytes, 0);
  assert.equal(journal.status().timer, false);
});

for (const close of [false, true]) test(`debug log review F4: ${close ? 'close' : 'flush'} before readiness leaves no idle timer`, async t => {
  const { root, identity } = await fixture(t);
  const journal = new TextJournal(identity, { root, limits: { flushDelayMs: 60_000 } });
  journal.record("INFO", "runtime", "Queued before initialization");
  await (close ? journal.close("quit") : journal.flush());
  assert.equal(journal.status().pendingBytes, 0);
  assert.equal(journal.status().inFlightBytes, 0);
  assert.equal(journal.status().timer, false);
  if (!close) await journal.close("quit");
});

test("debug log capture off/on keeps run identity and files without idle writes", async t => {
  const { root, identity } = await fixture(t), { io, counts } = observedIO();
  const journal = new TextJournal(identity, { root, io });
  await journal.ready;
  const run = journal.status().run, path = journal.status().path;
  journal.setEnabled(false); await journal.flush();
  const before = { ...counts }, records = journal.status().records;
  for (let i = 0; i < 100; i++) journal.record("INFO", "runtime", "Disabled capture must omit this");
  await journal.flush();
  assert.deepEqual(counts, before);
  assert.equal(journal.status().records, records);
  assert.equal(journal.status().timer, false);
  journal.setEnabled(true);
  journal.record("INFO", "runtime", "Capture is available again");
  await journal.flush();
  assert.equal(journal.status().run, run); assert.equal(journal.status().path, path);
  const output = await fs.readFile(path, "utf8");
  assert.match(output, /Diagnostic capture disabled/u);
  assert.match(output, /Diagnostic capture resumed/u);
  assert.ok(!output.includes("Disabled capture must omit this"));
  await journal.close("quit");
});


test("debug log review: the smallest accepted buffer can write an omission notice without spinning", async t => {
  const { root } = await fixture(t);
  const { execFile } = await import("node:child_process");
  const module = new URL("../src/debug-log.ts", import.meta.url).href;
  await new Promise<void>((resolve, reject) => {
    execFile(process.execPath, ["--input-type=module", "-e", `
      import assert from 'node:assert/strict';
      import { TextJournal } from ${JSON.stringify(module)};
      const identity = {session:'tiny-buffer', cwd:'/example', extension:'0.0.0', pi:'1.0.0', reason:'startup'};
      const root = ${JSON.stringify(root)};
      const now = () => 1800000000000;
      const probe = new TextJournal(identity, {root, now}); await probe.ready;
      const headerBytes = probe.status().bytes; await probe.close('quit');
      const journal = new TextJournal(identity, {root, now, limits:{bufferBytes:headerBytes+64}});
      await journal.ready; assert.equal(journal.status().state, 'active');
      journal.record('INFO', 'runtime', 'A'.repeat(1000));
      journal.record('INFO', 'runtime', 'B'.repeat(1000));
      assert.equal(journal.status().dropped, 1);
      await journal.flush();
      assert.equal(journal.status().records, 2);
      assert.equal(journal.status().pendingBytes, 0);
      assert.equal(journal.status().inFlightBytes, 0);
      await journal.close('quit'); assert.equal(journal.status().state, 'closed');
    `], { timeout: 2000, maxBuffer: 16 * 1024 }, error => { if (error) reject(error); else resolve(); });
  });
});

test("debug log review: POSIX trailing backslash names select their exact directory", async t => {
  if (process.platform === "win32") { t.skip("Backslash is a separator on Windows"); return; }
  const { root, identity } = await fixture(t);
  const exact = join(root, "private-root\\");
  await fs.mkdir(exact, { mode: 0o700 });
  const journal = new TextJournal(identity, { root: exact });
  t.after(() => journal.close("quit"));
  await journal.ready; assert.equal(journal.status().state, "active");
  assert.equal(dirname(journal.status().path), await fs.realpath(exact));
  await journal.close("quit");
  assert.deepEqual(await fs.readdir(root), ["private-root\\"]);
  assert.ok((await fs.readdir(exact)).some(name => name.endsWith(".closed.log")));
});
