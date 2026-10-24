import '../../fixtures/test-guard.mjs';
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs/promises";
import nativeFs from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { ExtensionSettings, SETTINGS_FILE_MAX_BYTES, type SyntaxTheme, type SettingsLoadResult } from "../../../src/settings.ts";

const pi: SyntaxTheme = { kind: "pi" };
const theme = (id: string): SyntaxTheme => ({ kind: "occipital", id });

async function fixture(t: test.TestContext) {
  const root = await fs.mkdtemp(join(tmpdir(), "tidy-settings-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = new ExtensionSettings({ agentDir: root });
  const file = join(root, "extensions", "pi-tidy-ui", "config.json");
  async function seed(contents: string) {
    await fs.mkdir(dirname(file), { recursive: true });
    await fs.writeFile(file, contents);
  }
  return { root, store, file, seed };
}

function safeFailure(result: { ok: boolean; issue?: { code: string; message: string } }, code: string) {
  assert.equal(result.ok, false);
  assert.equal(result.issue?.code, code);
  assert.ok(result.issue!.message.length <= 120);
  assert.doesNotMatch(result.issue!.message, /SECRET|EACCES|EIO|EPERM|ENOENT|tidy-settings-|\n|\x1b/);
}

async function noTemporaryFiles(file: string) {
  assert.deepEqual(await fs.readdir(dirname(file)), ["config.json"]);
}

test("settings: missing file and field use Pi without writes; explicit file seam", async (t) => {
  const { root, store, file, seed } = await fixture(t);
  assert.equal(store.file, file);
  assert.deepEqual(await store.load(), { ok: true, syntaxTheme: pi });
  assert.deepEqual(await fs.readdir(root), []);
  const original = '{ "future": {"enabled": false} }';
  await seed(original);
  assert.deepEqual(await new ExtensionSettings({ file }).load(), { ok: true, syntaxTheme: pi });
  assert.equal(await fs.readFile(file, "utf8"), original);
});

test("settings: writes two-space pretty JSON with a final newline", async (t) => {
  const { store, file } = await fixture(t);
  assert.deepEqual(await store.update({ syntaxTheme: pi, terminalColorsEnabled: false }), { ok: true });
  assert.equal(await fs.readFile(file, "utf8"), `{
  "syntaxTheme": {
    "kind": "pi"
  },
  "terminalColorsEnabled": false
}
`);
  assert.deepEqual(await new ExtensionSettings({ file }).load(), {
    ok: true, syntaxTheme: pi, terminalColorsEnabled: false,
  });
  await noTemporaryFiles(file);
});

test("settings: round trips, opaque IDs and no extra persisted preferences", async (t) => {
  const { store, file } = await fixture(t);
  for (const choice of [theme("catalogue:dark"), theme("../opaque/🧠"), theme("é".repeat(32)), pi]) {
    assert.deepEqual(await store.update({ syntaxTheme: choice }), { ok: true });
    assert.deepEqual(await new ExtensionSettings({ file }).load(), { ok: true, syntaxTheme: choice });
    assert.deepEqual(JSON.parse(await fs.readFile(file, "utf8")), { syntaxTheme: choice });
    await noTemporaryFiles(file);
  }
});

test("settings: reread each patch and preserve nested future/prototype-named own keys", async (t) => {
  const { store, file, seed } = await fixture(t);
  const future = JSON.parse('{"__proto__":{"polluted":true},"constructor":{"prototype":{"polluted":true}},"toString":null,"hasOwnProperty":3,"future":{"nested":[1,"x",null]}}');
  await seed(JSON.stringify(future));
  assert.deepEqual(await store.update({ syntaxTheme: theme("first") }), { ok: true });
  assert.deepEqual(JSON.parse(await fs.readFile(file, "utf8")), { ...future, syntaxTheme: theme("first") });
  future.future.nested.push("external latest");
  await seed(JSON.stringify(future));
  assert.deepEqual(await store.update({ syntaxTheme: pi }), { ok: true });
  assert.deepEqual(JSON.parse(await fs.readFile(file, "utf8")), { ...future, syntaxTheme: pi });
  assert.equal(({} as { polluted?: boolean }).polluted, undefined);
});

// ES2023 project typings do not yet declare the supported native JSON APIs.
const nativeJSON = JSON as typeof JSON & {
  rawJSON(source: string): unknown;
  isRawJSON(value: unknown): boolean;
};

test("settings: actual native JSON APIs preserve source tokens and identify only genuine wrappers", () => {
  const tokens: string[] = [];
  const original = '{"future":[1e400,9007199254740993,0.12345678901234567890123456789,-0]}';
  const parsed = JSON.parse(original, (_key: string, value: unknown, context?: { source?: string }) => {
    if (typeof value !== "number") return value;
    assert.equal(typeof context?.source, "string");
    tokens.push(context!.source!);
    const raw = nativeJSON.rawJSON(context!.source!);
    assert.equal(nativeJSON.isRawJSON(raw), true);
    return raw;
  });
  assert.deepEqual(tokens, ["1e400", "9007199254740993", "0.12345678901234567890123456789", "-0"]);
  assert.equal(JSON.stringify(parsed), original);
  assert.equal(nativeJSON.isRawJSON({ rawJSON: "1e400" }), false);
});

for (const token of ["1e400", "-1e400", "9007199254740993", "-9007199254740993",
  "0.12345678901234567890123456789", "1.00000000000000000001", "1e-400", "-0", "-0.000e+20"]) {
  test(`settings: preserve unrelated numeric token ${token} through real-filesystem patches`, async (t) => {
    const { store, file, seed } = await fixture(t);
    await seed(`{"future":${token}}`);
    assert.deepEqual(await store.update({ syntaxTheme: pi }), { ok: true });
    assert.equal(await fs.readFile(file, "utf8"), `{\n  "future": ${token},\n  "syntaxTheme": {\n    "kind": "pi"\n  }\n}\n`);
    const fresh = new ExtensionSettings({ file });
    assert.deepEqual(await fresh.load(), { ok: true, syntaxTheme: pi });
    assert.deepEqual(await fresh.update({ syntaxTheme: theme("next") }), { ok: true });
    assert.equal(await fs.readFile(file, "utf8"), `{\n  "future": ${token},\n  "syntaxTheme": {\n    "kind": "occipital",\n    "id": "next"\n  }\n}\n`);
    await noTemporaryFiles(file);
  });
}

test("settings: preserve nested future and prototype-named numeric tokens without confusing rawJSON data", async (t) => {
  const { store, file, seed } = await fixture(t);
  const original = '{"future":{"array":[1e400,9007199254740993,{"fine":0.12345678901234567890123456789,"zero":-0}]},"__proto__":{"n":-1e400},"constructor":{"prototype":{"n":-9007199254740993}},"toString":1e-400,"hasOwnProperty":-0.000e+20,"rawJSON":{"rawJSON":"not a native wrapper","number":9007199254740995}}';
  await seed(original);
  assert.deepEqual(await store.update({ syntaxTheme: pi }), { ok: true });
  assert.equal(await fs.readFile(file, "utf8"), `{
  "future": {
    "array": [
      1e400,
      9007199254740993,
      {
        "fine": 0.12345678901234567890123456789,
        "zero": -0
      }
    ]
  },
  "__proto__": {
    "n": -1e400
  },
  "constructor": {
    "prototype": {
      "n": -9007199254740993
    }
  },
  "toString": 1e-400,
  "hasOwnProperty": -0.000e+20,
  "rawJSON": {
    "rawJSON": "not a native wrapper",
    "number": 9007199254740995
  },
  "syntaxTheme": {
    "kind": "pi"
  }
}
`);
  assert.deepEqual(await new ExtensionSettings({ file }).load(), { ok: true, syntaxTheme: pi });
  assert.equal(({} as { n?: unknown }).n, undefined);
  await noTemporaryFiles(file);
});

for (const failure of ["rawJSON missing", "isRawJSON missing", "source context missing", "rawJSON throws", "fake raw wrapper"] as const) {
  test(`settings: ${failure} refuses unsafe numeric rewrites and retains exact old bytes`, async (t) => {
    const { store, file, seed } = await fixture(t);
    const original = '{"future":{"SECRET":[1e400,9007199254740993,0.1234567890123456789,-0]}}';
    await seed(original);
    if (failure === "rawJSON missing" || failure === "isRawJSON missing") {
      const key = failure === "rawJSON missing" ? "rawJSON" : "isRawJSON";
      const descriptor = Object.getOwnPropertyDescriptor(JSON, key)!;
      Object.defineProperty(JSON, key, { ...descriptor, value: undefined });
      t.after(() => Object.defineProperty(JSON, key, descriptor));
    } else if (failure === "source context missing") {
      const realParse = JSON.parse;
      t.mock.method(JSON, "parse", (text: string, reviver?: (key: string, value: unknown) => unknown) =>
        realParse(text, reviver ? function (key, value) { return reviver.call(this, key, value); } : undefined));
    } else {
      t.mock.method(nativeJSON, "rawJSON", failure === "rawJSON throws" ?
        () => { throw new Error("SECRET native API failure"); } : (source: string) => ({ rawJSON: source }));
    }
    const loaded = await store.load();
    safeFailure(loaded, "numeric-preservation-unavailable");
    assert.deepEqual(loaded.syntaxTheme, pi);
    safeFailure(await store.update({ syntaxTheme: pi }), "numeric-preservation-unavailable");
    assert.equal(await fs.readFile(file, "utf8"), original);
    await noTemporaryFiles(file);
  });
}

const invalidFiles: [string, string, string][] = [
  ["JSON", '{"SECRET":', "invalid-json"],
  ["null root", "null", "invalid-root"],
  ["array root", "[]", "invalid-root"],
  ["string root", '"SECRET"', "invalid-root"],
  ["number root", "2", "invalid-root"],
  ["overflow number root", "1e400", "invalid-root"],
  ["negative zero root", "-0", "invalid-root"],
  ["numeric theme", '{"syntaxTheme":1e400}', "invalid-theme"],
  ["numeric kind", '{"syntaxTheme":{"kind":9007199254740993}}', "invalid-theme"],
  ["overflow catalogue ID", '{"syntaxTheme":{"kind":"occipital","id":1e400}}', "invalid-theme"],
  ["null theme", '{"syntaxTheme":null}', "invalid-theme"],
  ["string theme", '{"syntaxTheme":"pi"}', "invalid-theme"],
  ["array theme", '{"syntaxTheme":[]}', "invalid-theme"],
  ["missing kind", '{"syntaxTheme":{}}', "invalid-theme"],
  ["unknown kind", '{"syntaxTheme":{"kind":"SECRET"}}', "invalid-theme"],
  ["Pi extra key", '{"syntaxTheme":{"kind":"pi","id":"SECRET"}}', "invalid-theme"],
  ["catalogue missing ID", '{"syntaxTheme":{"kind":"occipital"}}', "invalid-theme"],
  ["catalogue number ID", '{"syntaxTheme":{"kind":"occipital","id":5}}', "invalid-theme"],
  ["catalogue empty ID", '{"syntaxTheme":{"kind":"occipital","id":""}}', "invalid-theme"],
  ["catalogue extra key", '{"syntaxTheme":{"kind":"occipital","id":"x","extra":true}}', "invalid-theme"],
  ["ID exceeds 64 UTF-8 bytes", JSON.stringify({ syntaxTheme: theme("é".repeat(33)) }), "invalid-theme"],
  ["ID lone surrogate", '{"syntaxTheme":{"kind":"occipital","id":"\\ud800"}}', "invalid-theme"],
];
for (const [label, contents, code] of invalidFiles) {
  test(`settings: invalid ${label} is safe, defaults without rewriting, and refuses patches`, async (t) => {
    const { store, file, seed } = await fixture(t);
    await seed(contents);
    const loaded = await store.load();
    safeFailure(loaded, code);
    assert.deepEqual(loaded.syntaxTheme, pi);
    safeFailure(await store.update({ syntaxTheme: theme("new") }), code);
    assert.equal(await fs.readFile(file, "utf8"), contents);
    await noTemporaryFiles(file);
  });
}

test("settings: byte-bounded reads/writes and exact size boundary", async (t) => {
  const { store, file, seed } = await fixture(t);
  const exact = JSON.stringify({ future: "x".repeat(SETTINGS_FILE_MAX_BYTES - 13) });
  assert.equal(Buffer.byteLength(exact), SETTINGS_FILE_MAX_BYTES);
  await seed(exact);
  assert.deepEqual(await store.load(), { ok: true, syntaxTheme: pi });
  safeFailure(await store.update({ syntaxTheme: pi }), "too-large");
  assert.equal(await fs.readFile(file, "utf8"), exact);
  await seed(exact + " ");
  safeFailure(await store.load(), "too-large");
  safeFailure(await store.update({ syntaxTheme: pi }), "too-large");
  assert.equal(await fs.readFile(file, "utf8"), exact + " ");
  await noTemporaryFiles(file);
});

test("settings: serialized size limit includes pretty-print whitespace and the final newline", async (t) => {
  const { store, file, seed } = await fixture(t);
  const prefix = '{\n  "future": "', suffix = '",\n  "syntaxTheme": {\n    "kind": "pi"\n  }\n}\n';
  for (const extra of [0, 1]) {
    const value = 'x'.repeat(SETTINGS_FILE_MAX_BYTES - Buffer.byteLength(prefix + suffix) + extra);
    const original = JSON.stringify({ future: value });
    await seed(original);
    assert.ok(Buffer.byteLength(original) < SETTINGS_FILE_MAX_BYTES, 'the input itself fits');
    assert.ok(Buffer.byteLength(JSON.stringify({ future: value, syntaxTheme: pi })) < SETTINGS_FILE_MAX_BYTES, 'compact output would fit');
    const result = await store.update({ syntaxTheme: pi });
    if (extra === 0) {
      assert.deepEqual(result, { ok: true });
      const contents = await fs.readFile(file, 'utf8');
      assert.equal(Buffer.byteLength(contents), SETTINGS_FILE_MAX_BYTES);
      assert.equal(contents, prefix + value + suffix);
    } else {
      safeFailure(result, 'too-large');
      assert.equal(await fs.readFile(file, 'utf8'), original, 'oversized formatted output preserves the previous file');
    }
    await noTemporaryFiles(file);
  }
});

test("settings: invalid UTF-8 is not silently repaired", async (t) => {
  const { store, file, seed } = await fixture(t);
  await seed("{}");
  const bytes = Buffer.from([0x7b, 0x22, 0x78, 0x22, 0x3a, 0x22, 0xff, 0x22, 0x7d]);
  await fs.writeFile(file, bytes);
  safeFailure(await store.load(), "invalid-json");
  safeFailure(await store.update({ syntaxTheme: pi }), "invalid-json");
  assert.deepEqual(await fs.readFile(file), bytes);
});

test("settings: unreadable paths and OS errors do not escape or become absence", async (t) => {
  const { store, file, seed } = await fixture(t);
  await seed('{"syntaxTheme":{"kind":"pi"}}');
  const realOpen = fs.open;
  t.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
    if (args[0] === file) throw Object.assign(new Error(`EACCES SECRET ${file}`), { code: "EACCES" });
    return realOpen(...args);
  });
  safeFailure(await store.load(), "read-failed");
  safeFailure(await store.update({ syntaxTheme: theme("new") }), "read-failed");
  t.mock.restoreAll();
  assert.deepEqual(JSON.parse(await fs.readFile(file, "utf8")), { syntaxTheme: pi });
  await fs.rm(file);
  await fs.mkdir(file);
  safeFailure(await store.load(), "read-failed");
  safeFailure(await store.update({ syntaxTheme: pi }), "read-failed");
  assert.ok((await fs.stat(file)).isDirectory());
});

test("settings: invalid update shape never writes", async (t) => {
  const { root, store } = await fixture(t);
  const patches: unknown[] = [null, {}, { syntaxTheme: null }, { syntaxTheme: theme("x".repeat(65)) },
    { syntaxTheme: pi, enabled: true }, { syntaxTheme: { kind: "pi", extra: true } }];
  for (const patch of patches) safeFailure(await store.update(patch as { syntaxTheme: SyntaxTheme }), "invalid-patch");
  assert.deepEqual(await fs.readdir(root), []);
});

for (const failure of ["mkdir", "open", "partial-write", "rename"] as const) {
  test(`settings: failed ${failure} retains old complete file and cleans temporary files`, async (t) => {
    const { store, file, seed } = await fixture(t);
    const old = '{"future":true,"syntaxTheme":{"kind":"occipital","id":"old"}}';
    await seed(old);
    const fail = () => { throw Object.assign(new Error(`EIO SECRET ${file}`), { code: "EIO" }); };
    if (failure === "mkdir") t.mock.method(fs, "mkdir", fail);
    if (failure === "rename") t.mock.method(fs, "rename", fail);
    if (failure === "open" || failure === "partial-write") {
      const realOpen = fs.open;
      t.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
        if (args[1] === "wx" && failure === "open") return fail();
        const handle = await realOpen(...args);
        if (args[1] === "wx") {
          const realWrite = handle.writeFile.bind(handle);
          t.mock.method(handle, "writeFile", async () => { await realWrite('{"partial":'); fail(); });
        }
        return handle;
      });
    }
    safeFailure(await store.update({ syntaxTheme: theme("new") }), "write-failed");
    assert.equal(await fs.readFile(file, "utf8"), old);
    await noTemporaryFiles(file);
    t.mock.restoreAll();
    assert.deepEqual(await store.update({ syntaxTheme: theme("recovered") }), { ok: true });
    assert.deepEqual(await store.load(), { ok: true, syntaxTheme: theme("recovered") });
  });
}

function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}

test("settings: same-client updates serialize publication and snapshot queued choices", async (t) => {
  const { store, file, seed } = await fixture(t);
  await seed(JSON.stringify({ syntaxTheme: pi }));
  const reached = gate();
  const resume = gate();
  const realRename = fs.rename;
  let publications = 0;
  t.mock.method(fs, "rename", async (...args: Parameters<typeof fs.rename>) => {
    publications++;
    if (publications === 1) { reached.release(); await resume.promise; }
    return realRename(...args);
  });
  const first = store.update({ syntaxTheme: theme("first") });
  await reached.promise;
  const mutable = { kind: "occipital" as const, id: "second" };
  const second = store.update({ syntaxTheme: mutable });
  mutable.id = "mutated";
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(publications, 1);
  assert.deepEqual(await store.load(), { ok: true, syntaxTheme: pi });
  resume.release();
  assert.deepEqual(await Promise.all([first, second]), [{ ok: true }, { ok: true }]);
  assert.equal(publications, 2);
  assert.deepEqual(await store.load(), { ok: true, syntaxTheme: theme("second") });
  await noTemporaryFiles(file);
});

test("settings: independent clients use unique complete temporary files; last actual publication wins", async (t) => {
  const { store, file, seed } = await fixture(t);
  await seed(JSON.stringify({ future: [1, 2], syntaxTheme: pi }));
  const peer = new ExtensionSettings({ file });
  const firstReached = gate();
  const publishFirst = gate();
  const realRename = fs.rename;
  const temporaryPaths: string[] = [];
  const published: string[] = [];
  t.mock.method(fs, "rename", async (...args: Parameters<typeof fs.rename>) => {
    const temporary = String(args[0]);
    temporaryPaths.push(temporary);
    assert.equal(dirname(temporary), dirname(file));
    const candidate = JSON.parse(await fs.readFile(temporary, "utf8"));
    assert.deepEqual(candidate.future, [1, 2]);
    if (candidate.syntaxTheme.id === "first") { firstReached.release(); await publishFirst.promise; }
    await realRename(...args);
    published.push(candidate.syntaxTheme.id);
    assert.deepEqual(JSON.parse(await fs.readFile(file, "utf8")), candidate);
  });
  const first = store.update({ syntaxTheme: theme("first") });
  await firstReached.promise;
  assert.deepEqual(await peer.update({ syntaxTheme: theme("second") }), { ok: true });
  assert.deepEqual(await store.load(), { ok: true, syntaxTheme: theme("second") });
  publishFirst.release();
  assert.deepEqual(await first, { ok: true });
  assert.deepEqual(published, ["second", "first"]);
  assert.equal(new Set(temporaryPaths).size, 2);
  assert.deepEqual(await peer.load(), { ok: true, syntaxTheme: theme("first") });
  await noTemporaryFiles(file);
});

test("settings: independent processes publish complete files in actual rename order", { timeout: 30_000 }, async (t) => {
  const { file, seed, store } = await fixture(t);
  await seed(JSON.stringify({ future: { retained: true }, syntaxTheme: pi }));
  const script = `
    import fs from 'node:fs/promises';
    import { once } from 'node:events';
    import { ExtensionSettings } from ${JSON.stringify(new URL("../../../src/settings.ts", import.meta.url).href)};
    const realRename = fs.rename;
    fs.rename = async (...args) => {
      process.send({prepared: JSON.parse(await fs.readFile(args[0], 'utf8'))});
      await once(process, 'message');
      await realRename(...args);
    };
    const result = await new ExtensionSettings({file: process.env.TEST_SETTINGS_FILE})
      .update({syntaxTheme: {kind:'occipital', id:process.env.TEST_SETTINGS_ID}});
    process.send({result});
    process.disconnect();
  `;
  const start = (id: string) => {
    const child = spawn(process.execPath, ["--input-type=module", "--eval", script], {
      env: { ...process.env, TEST_SETTINGS_FILE: file, TEST_SETTINGS_ID: id },
      stdio: ["ignore", "ignore", "pipe", "ipc"],
    });
    t.after(() => { if (child.exitCode === null) child.kill(); });
    return child;
  };
  const first = start("process-first");
  const [preparedFirst] = await once(first, "message");
  assert.deepEqual(preparedFirst, { prepared: { future: { retained: true }, syntaxTheme: theme("process-first") } });
  const second = start("process-second");
  const [preparedSecond] = await once(second, "message");
  assert.deepEqual(preparedSecond, { prepared: { future: { retained: true }, syntaxTheme: theme("process-second") } });
  assert.notEqual(first.pid, second.pid);
  assert.deepEqual(await store.load(), { ok: true, syntaxTheme: pi });
  const secondResult = once(second, "message");
  const secondExit = once(second, "exit");
  second.send("publish");
  assert.deepEqual((await secondResult)[0], { result: { ok: true } });
  assert.deepEqual(await secondExit, [0, null]);
  assert.deepEqual(await store.load(), { ok: true, syntaxTheme: theme("process-second") });
  const firstResult = once(first, "message");
  const firstExit = once(first, "exit");
  first.send("publish");
  assert.deepEqual((await firstResult)[0], { result: { ok: true } });
  assert.deepEqual(await firstExit, [0, null]);
  assert.deepEqual(JSON.parse(await fs.readFile(file, "utf8")), { future: { retained: true }, syntaxTheme: theme("process-first") });
  await noTemporaryFiles(file);
});

for (const mode of ["default", "absolute", "tilde"] as const) {
  test(`settings: actual public Pi API ${mode} root, save and fresh-process load stay isolated`, async (t) => {
    const { root } = await fixture(t);
    const home = join(root, "home");
    await fs.mkdir(home);
    const defaultFile = join(home, ".pi", "agent", "extensions", "pi-tidy-ui", "config.json");
    const expectedRoot = mode === "default" ? join(home, ".pi", "agent") :
      mode === "absolute" ? join(root, "absolute-agent") : join(home, "tilde-agent");
    const expectedFile = join(expectedRoot, "extensions", "pi-tidy-ui", "config.json");
    if (mode !== "default") {
      await fs.mkdir(dirname(defaultFile), { recursive: true });
      await fs.writeFile(defaultFile, "SECRET default must not be read or changed");
    }
    const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, USERPROFILE: home };
    delete env.PI_CODING_AGENT_DIR;
    if (mode !== "default") env.PI_CODING_AGENT_DIR = mode === "absolute" ? expectedRoot : "~/tilde-agent";
    const run = (save: boolean) => {
      const script = `
        import { getAgentDir } from '@earendil-works/pi-coding-agent';
        import { ExtensionSettings } from ${JSON.stringify(new URL("../../../src/settings.ts", import.meta.url).href)};
        const store = new ExtensionSettings();
        const before = await store.load();
        const saved = ${save} ? await store.update({syntaxTheme:{kind:'occipital',id:'process-theme'}}) : null;
        console.log(JSON.stringify({root:getAgentDir(), file:store.file, before, saved}));
      `;
      const child = spawnSync(process.execPath, ["--input-type=module", "--eval", script], { env, encoding: "utf8", timeout: 30_000 });
      assert.equal(child.status, 0, child.stderr);
      return JSON.parse(child.stdout);
    };
    const first = run(true);
    assert.equal(first.root, expectedRoot);
    assert.equal(first.file, expectedFile);
    assert.deepEqual(first.before, { ok: true, syntaxTheme: pi });
    assert.deepEqual(first.saved, { ok: true });
    const fresh = run(false);
    assert.deepEqual(fresh.before, { ok: true, syntaxTheme: theme("process-theme") });
    assert.deepEqual(JSON.parse(await fs.readFile(expectedFile, "utf8")), { syntaxTheme: theme("process-theme") });
    if (mode !== "default") assert.equal(await fs.readFile(defaultFile, "utf8"), "SECRET default must not be read or changed");
  });
}

test("settings cancellation: pre-aborted update performs no reads or writes", async (t) => {
  const { root, store } = await fixture(t), abort = new AbortController();
  abort.abort(new Error('SECRET stale owner'));
  const realOpen = fs.open, realMkdir = fs.mkdir; let opens = 0, mkdirs = 0;
  t.mock.method(fs, 'open', (...args: Parameters<typeof fs.open>) => { opens++; return realOpen(...args); });
  t.mock.method(fs, 'mkdir', (...args: Parameters<typeof fs.mkdir>) => { mkdirs++; return realMkdir(...args); });
  safeFailure(await store.update({ syntaxTheme: theme('obsolete') }, { signal: abort.signal }), 'cancelled');
  assert.equal(opens, 0); assert.equal(mkdirs, 0); assert.deepEqual(await fs.readdir(root), []);
});

test("settings cancellation: queued obsolete choice never rereads or publishes after the valid write", async (t) => {
  const { store, file, seed } = await fixture(t); await seed('{"future":1e400}');
  const reached = gate(), resume = gate(), abort = new AbortController();
  const realRename = fs.rename, realOpen = fs.open; let reads = 0, publications = 0;
  t.mock.method(fs, 'open', (...args: Parameters<typeof fs.open>) => { if (args[0] === file && args[1] === 'r') reads++; return realOpen(...args); });
  t.mock.method(fs, 'rename', async (...args: Parameters<typeof fs.rename>) => { publications++; reached.release(); await resume.promise; return realRename(...args); });
  const first = store.update({ syntaxTheme: theme('current') }); await reached.promise;
  const second = store.update({ syntaxTheme: theme('obsolete') }, { signal: abort.signal }); abort.abort();
  resume.release();
  assert.deepEqual(await first, { ok: true }); safeFailure(await second, 'cancelled');
  assert.equal(reads, 1); assert.equal(publications, 1);
  assert.equal(await fs.readFile(file, 'utf8'), '{\n  "future": 1e400,\n  "syntaxTheme": {\n    "kind": "occipital",\n    "id": "current"\n  }\n}\n');
  await noTemporaryFiles(file);
});

for (const stage of ['read', 'write', 'close'] as const) test(`settings cancellation: abort during ${stage} prevents config publication and cleans only owned temporary files`, async (t) => {
  const { store, file, seed } = await fixture(t), original = '{"future":9007199254740993,"syntaxTheme":{"kind":"pi"}}';
  await seed(original);
  const reached = gate(), resume = gate(), abort = new AbortController(), realOpen = fs.open, realRename = fs.rename;
  let publications = 0, paused = false;
  t.mock.method(fs, 'rename', (...args: Parameters<typeof fs.rename>) => { publications++; return realRename(...args); });
  t.mock.method(fs, 'open', async (...args: Parameters<typeof fs.open>) => {
    const handle = await realOpen(...args);
    if (!paused && stage === 'read' && args[0] === file && args[1] === 'r') {
      const read = handle.read.bind(handle); paused = true;
      t.mock.method(handle, 'read', async (...readArgs: Parameters<typeof handle.read>) => {
        reached.release(); await resume.promise; return read(...readArgs);
      });
    } else if (!paused && stage !== 'read' && args[1] === 'wx') {
      paused = true;
      if (stage === 'write') {
        const write = handle.writeFile.bind(handle);
        t.mock.method(handle, 'writeFile', async (...writeArgs: Parameters<typeof handle.writeFile>) => {
          await write(...writeArgs); reached.release(); await resume.promise;
        });
      } else {
        const close = handle.close.bind(handle);
        t.mock.method(handle, 'close', async () => { await close(); reached.release(); await resume.promise; });
      }
    }
    return handle;
  });
  const save = store.update({ syntaxTheme: theme('obsolete') }, { signal: abort.signal });
  await reached.promise; abort.abort(new Error('SECRET retired owner')); resume.release();
  safeFailure(await save, 'cancelled'); assert.equal(publications, 0);
  assert.equal(await fs.readFile(file, 'utf8'), original); await noTemporaryFiles(file);
  t.mock.restoreAll();
  assert.deepEqual(await store.update({ syntaxTheme: theme('new owner') }), { ok: true });
  assert.deepEqual(await store.load(), { ok: true, syntaxTheme: theme('new owner') });
});

test("settings cancellation: a rename already requested by a live owner is the commit boundary, not retroactively undone", async (t) => {
  const { store, file, seed } = await fixture(t); await seed('{}');
  const reached = gate(), resume = gate(), abort = new AbortController(), realRename = fs.rename;
  let publications = 0;
  t.mock.method(fs, 'rename', async (...args: Parameters<typeof fs.rename>) => {
    publications++; reached.release(); await resume.promise; return realRename(...args);
  });
  const save = store.update({ syntaxTheme: theme('committed') }, { signal: abort.signal });
  await reached.promise; abort.abort(); resume.release();
  assert.deepEqual(await save, { ok: true }); assert.equal(publications, 1);
  assert.deepEqual(await store.load(), { ok: true, syntaxTheme: theme('committed') }); await noTemporaryFiles(file);
});

const switchKeys = ['terminalColorsEnabled', 'nativeHighlightingEnabled'] as const;

test('settings: shared switches persist together with theme and future fields', async t => {
  const { store, file, seed } = await fixture(t);
  await seed('{"future":{"keep":true},"syntaxTheme":{"kind":"occipital","id":"saved"}}');
  const switches = Object.fromEntries(switchKeys.map(key => [key, false]));
  assert.deepEqual(await store.update(switches), { ok: true });
  assert.deepEqual(await new ExtensionSettings({ file }).load(), { ok: true, syntaxTheme: theme('saved'), ...switches });
  await store.update({ terminalColorsEnabled: true });
  await store.update({ syntaxTheme: pi });
  assert.deepEqual(await new ExtensionSettings({ file }).load(), { ok: true, syntaxTheme: pi, ...switches, terminalColorsEnabled: true });
  assert.deepEqual(JSON.parse(await fs.readFile(file, 'utf8')).future, { keep: true });
  await noTemporaryFiles(file);
});

for (const key of switchKeys) test(`settings: ${key} rejects nonboolean file and patch values without rewriting`, async t => {
  const { store, file, seed } = await fixture(t);
  for (const value of [null, 0, 'false', [], {}]) {
    const original = JSON.stringify({ [key]: value }); await seed(original);
    safeFailure(await store.load(), 'invalid-switch');
    assert.equal((await store.update({ syntaxTheme: pi })).ok, false);
    assert.equal(await fs.readFile(file, 'utf8'), original);
  }
  await seed('{}');
  safeFailure(await store.update({ [key]: 'false' } as any), 'invalid-patch');
  assert.equal(await fs.readFile(file, 'utf8'), '{}');
});

test('settings: serialized mixed switch and theme patches preserve one another', async t => {
  const { store, file } = await fixture(t);
  const outcomes = await Promise.all([store.update({ nativeHighlightingEnabled: true }), store.update({ syntaxTheme: theme('mixed') }),
    store.update({ terminalColorsEnabled: false }), store.update({ nativeHighlightingEnabled: false })]);
  assert.ok(outcomes.every(result => result.ok));
  assert.deepEqual(await new ExtensionSettings({ file }).load(), { ok: true, syntaxTheme: theme('mixed'),
    terminalColorsEnabled: false, nativeHighlightingEnabled: false });
});

// Local switches must never be restored from, or published into, shared settings.
test('settings policy: legacy process-local flags are ignored and removed by the next explicit save', async t => {
  const { store, file, seed } = await fixture(t);
  await seed('{"appearanceEnabled":false,"loggingEnabled":"obsolete","terminalColorsEnabled":false,"future":true}');
  assert.deepEqual(await store.load(), { ok: true, syntaxTheme: pi, terminalColorsEnabled: false });
  assert.deepEqual(await store.update({ syntaxTheme: theme('chosen') }), { ok: true });
  assert.deepEqual(JSON.parse(await fs.readFile(file, 'utf8')), { terminalColorsEnabled: false, future: true, syntaxTheme: theme('chosen') });
});

for (const key of ['appearanceEnabled', 'loggingEnabled']) test(`settings policy: ${key} cannot enter the persistence queue`, async t => {
  const { store, root } = await fixture(t);
  safeFailure(await store.update({ [key]: false } as any), 'invalid-patch');
  assert.deepEqual(await fs.readdir(root), []);
});

function watchSettings(store: ExtensionSettings, changed: (value: Awaited<ReturnType<ExtensionSettings['load']>>) => void): () => void {
  const watch = Reflect.get(store, 'watch');
  assert.equal(typeof watch, 'function', 'settings must expose event-driven subscription');
  return watch.call(store, changed);
}
async function turns(count = 12) { for (let i = 0; i < count; i++) await new Promise<void>(resolve => setImmediate(resolve)); }

test('settings watch: atomic peer saves apply repeatedly without rewriting or idle filesystem work', { timeout: 10000 }, async t => {
  const { store, file, seed } = await fixture(t); await seed('{}'); await store.load();
  const changes: SettingsLoadResult[] = [];
  let resolveChange!: () => void;
  const changed = () => new Promise<void>(resolve => { resolveChange = resolve; });
  const stop = watchSettings(store, value => { changes.push(value); resolveChange?.(); }); t.after(stop);
  const realStat = fs.stat, realOpen = fs.open; let checks = 0, reads = 0, writes = 0;
  t.mock.method(fs, 'stat', (...args: Parameters<typeof fs.stat>) => { checks++; return realStat(...args); });
  t.mock.method(fs, 'open', (...args: Parameters<typeof fs.open>) => {
    if (args[0] === file && args[1] === 'r') reads++;
    if (args[1] === 'wx') writes++;
    return realOpen(...args);
  });
  await turns(); const idle = [checks, reads, writes]; await turns(100);
  assert.deepEqual([checks, reads, writes], idle, 'an idle subscriber performs no periodic stat/read/write');
  await fs.writeFile(join(dirname(file), 'unrelated.tmp'), 'ignored'); await turns();
  assert.deepEqual([checks, reads, writes], idle, 'unrelated directory traffic is ignored before stat');
  const peer = new ExtensionSettings({ file });
  for (const id of ['A', 'B', 'C']) {
    const notification = changed(); await peer.update({ syntaxTheme: theme(id) }); await notification;
    assert.deepEqual(changes.at(-1), { ok: true, syntaxTheme: theme(id) });
  }
  assert.equal(writes, 3, 'subscribers never write settings back');
  const frozen = changes.length; stop(); await peer.update({ syntaxTheme: pi }); await turns();
  assert.equal(changes.length, frozen, 'disposed subscriptions cannot publish');
});

test('settings watch: first save is observed even when the configuration directory did not exist', { timeout: 10000 }, async t => {
  const events: Record<string, unknown>[] = []; let completed = false, omitted = 0;
  const started = performance.now();
  const record = (event: Record<string, unknown>) => {
    if (events.length < 256) events.push({ ms: Math.round(performance.now() - started), ...event }); else omitted++;
  };
  t.after(() => { if (!completed) t.diagnostic(JSON.stringify({ settingsWatch: events, omitted })); });
  const { store, file, root } = await fixture(t); await store.load();
  const realWatch = nativeFs.watch, realStat = fs.stat;
  const role = (path: unknown) => path === root ? 'root' : path === dirname(file) ? 'configuration' : path === dirname(dirname(file)) ? 'parent' : 'other';
  const code = (error: unknown) => ['ENOENT','ENOTDIR','EACCES','EPERM'].includes((error as NodeJS.ErrnoException).code ?? '') ? (error as NodeJS.ErrnoException).code : 'other';
  t.mock.method(nativeFs, 'watch', (path: string, options: unknown, callback: (...args: any[]) => void) => {
    const target = role(path); record({ operation: 'subscribe', target });
    try {
      const watcher = Reflect.apply(realWatch, nativeFs, [path, options, (event: string, name: string | null) => {
        record({ operation: 'event', target, event, name: name === null ? 'none' : ['extensions','pi-tidy-ui','config.json'].includes(String(name)) ? String(name) : 'other' });
        callback(event, name);
      }]);
      record({ operation: 'subscribed', target });
      watcher.on('error', (error: Error) => record({ operation: 'watch-error', target, code: code(error) }));
      return watcher;
    } catch (error) { record({ operation: 'subscribe-failed', target, code: code(error) }); throw error; }
  });
  t.mock.method(fs, 'stat', async (...args: Parameters<typeof fs.stat>) => {
    try { const stat = await realStat(...args); if (args[0] === file) record({ operation: 'stat', outcome: 'present' }); return stat; }
    catch (error) { if (args[0] === file) record({ operation: 'stat', outcome: code(error) }); throw error; }
  });
  let resolve!: (value: SettingsLoadResult) => void;
  const changed = new Promise<SettingsLoadResult>(done => { resolve = done; });
  const stop = watchSettings(store, value => { record({ operation: 'notification', ok: value.ok }); resolve(value); }); t.after(stop);
  assert.deepEqual(await fs.readdir(root), [], 'watching must not create config directories or files');
  const saved = await new ExtensionSettings({ file }).update({ syntaxTheme: theme('first') });
  record({ operation: 'save-completed', ok: saved.ok }); assert.deepEqual(saved, { ok: true });
  assert.deepEqual(await changed, { ok: true, syntaxTheme: theme('first') }); completed = true;
});

test('settings watch: creating a directory between the missing-child check and ancestor subscription cannot lose the first save', { timeout: 10000 }, async t => {
  let completed = false, gapCreated = false, rootWatching = false, notifications = 0;
  const attempts: { target: string; outcome: string }[] = [];
  t.after(() => { if (!completed) t.diagnostic(JSON.stringify({ gapCreated, rootWatching, notifications, attempts })); });
  const { store, file, root } = await fixture(t); await store.load();
  const directory = dirname(file), parent = dirname(directory), realWatch = nativeFs.watch, realStat = fs.stat;
  let missing!: () => void, notify!: (value: SettingsLoadResult) => void;
  const observedMissing = new Promise<void>(resolve => { missing = resolve; });
  const changed = new Promise<SettingsLoadResult>(resolve => { notify = resolve; });
  t.mock.method(nativeFs, 'watch', (path: string, ...args: any[]) => {
    const target = path === directory ? 'configuration' : path === parent ? 'parent' : path === root ? 'root' : 'other';
    try {
      const watcher = Reflect.apply(realWatch, nativeFs, [path, ...args]);
      attempts.push({ target, outcome: 'subscribed' });
      if (path === root) rootWatching = true;
      return watcher;
    } catch (error) {
      attempts.push({ target, outcome: (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'error' });
      if (rootWatching && !gapCreated && path === directory && (error as NodeJS.ErrnoException).code === 'ENOENT') {
        nativeFs.mkdirSync(directory); gapCreated = true;
      }
      throw error;
    }
  });
  t.mock.method(fs, 'stat', async (...args: Parameters<typeof fs.stat>) => {
    try { return await realStat(...args); }
    catch (error) {
      if (gapCreated && args[0] === file && (error as NodeJS.ErrnoException).code === 'ENOENT') missing();
      throw error;
    }
  });
  const stop = watchSettings(store, value => { notifications++; notify(value); }); t.after(stop);
  await fs.mkdir(parent); await observedMissing;
  assert.equal(gapCreated, true, 'the real directory is created inside the failed-watch/ancestor-watch window');
  assert.deepEqual(await new ExtensionSettings({ file }).update({ syntaxTheme: theme('first') }), { ok: true });
  assert.deepEqual(await changed, { ok: true, syntaxTheme: theme('first') });
  completed = true;
});

test('settings policy: process-local values survive module reload but not a new process', async t => {
  const original = await import('../../../src/settings.ts');
  const get = Reflect.get(original, 'processPreferences'); assert.equal(typeof get, 'function');
  const state = get(); const before = { ...state }; t.after(() => Object.assign(state, before));
  state.appearanceEnabled = false; state.loggingEnabled = false;
  const reloaded = await import(new URL('../../../src/settings.ts?reload-policy', import.meta.url).href);
  assert.deepEqual(Reflect.get(reloaded, 'processPreferences')(), { appearanceEnabled: false, loggingEnabled: false });
  const script = `import { processPreferences } from ${JSON.stringify(new URL('../../../src/settings.ts', import.meta.url).href)}; console.log(JSON.stringify(processPreferences()));`;
  const next = spawnSync(process.execPath, ['--input-type=module', '--eval', script], { env: { ...process.env }, encoding: 'utf8' });
  assert.equal(next.status, 0, next.stderr);
  assert.deepEqual(JSON.parse(next.stdout), { appearanceEnabled: true, loggingEnabled: true });
});
