import "./fixtures/test-guard.mjs";
import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, renameSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, parse, sep } from "node:path";
import xterm from "@xterm/headless";
import { visibleWidth } from "@earendil-works/pi-tui";
import { awaitFixture } from "./fixtures/await-fixture.ts";
import { renderEditorStatus, directoryStatus } from "../src/editor-status.ts";
import { InteractiveMode } from "../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/interactive-mode.js";
import { initTheme, theme as nativeTheme } from "../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js";
import { stripVTControlCharacters } from "node:util";
import { setAppearance } from "./helpers/menu-driver.ts";
import { Container, CustomEditor, Text, editorSetup, fixtureSyntaxOptions, plain, tidyUi, type ExtensionAPI, type ExtensionContext } from "./fixtures/sdk-contract-support.ts";

test("editor directory abbreviates the native home only at a path boundary before fitting", () => {
  const previous = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  const home = join(tmpdir(), "tidy-ui-home-界"), theme = { fg: (_role: string, value: string) => value };
  const setHome = (value: string) => { process.env.HOME = value; process.env.USERPROFILE = value; };
  const render = (cwd: string, width = 120) => renderEditorStatus(width, theme,
    { model: "M", provider: "P", thinking: "off", idle: false, cwd, branch: "main" });
  try {
    setHome(home);
    for (const [cwd, expected] of [[home, "~"], [home + sep, "~"], [join(home, "project"), "~" + sep + "project"],
      [join(home, "parent", "界é"), "~" + sep + "parent" + sep + "界é"],
      [home + "-other" + sep + "project", home + "-other" + sep + "project"], [home + "2", home + "2"]]) {
      const row = plain(render(cwd!)[0]!);
      assert.ok(row.endsWith(expected + ":main  "), JSON.stringify({ cwd, expected, row }));
      assert.equal(visibleWidth(row), 120);
      for (const width of [7, 24, 60]) assert.ok(render(cwd!, width).every(line => visibleWidth(line) === width));
      assert.equal(plain(render(cwd!)[0]!), row, "resize starts from the original directory");
    }
    const calls: [string, string][] = [], info = { model: "M", provider: "P", thinking: "off", idle: false,
      cwd: join(home, "project"), branch: "main" }, before = structuredClone(info);
    renderEditorStatus(120, { fg: (role, value) => { calls.push([role, value]); return value; } }, info);
    for (const expected of [["dim", "~" + sep], ["mdLinkUrl", "project"], ["muted", ":"], ["text", "main"]])
      assert.ok(calls.some(call => call[0] === expected[0] && call[1] === expected[1]), JSON.stringify(expected));
    assert.deepEqual(info, before, "real cwd and branch remain unchanged");
    setHome(home + sep);
    assert.ok(plain(render(home)[0]!).endsWith("~:main  "), "non-root trailing home separators are ignored");
    setHome(home + "-other");
    assert.ok(plain(render(home)[0]!).endsWith(home + ":main  "), "home is read live, not retained as presentation state");
    const root = parse(home).root; setHome(root);
    assert.ok(plain(render(root)[0]!).endsWith("~:main  "), "home may be the filesystem root");
    assert.ok(plain(render(join(root, "project"))[0]!).endsWith("~" + sep + "project:main  "));
    assert.doesNotMatch(plain(render("")[0]!), /:main/u, "missing cwd stays absent even with a root home");
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
});

test("editor directory is right-aligned with one shared inner padding cell", () => {
  const info = { model: "M", provider: "raw-id", thinking: "off", idle: false,
    cwd: "/tidy-ui-directory/work/project", branch: "feature/input-status" };
  const row = plain(renderEditorStatus(100, { fg: (_role, text) => text }, info)[0]!);
  assert.equal(visibleWidth(row), 100);
  assert.ok(row.endsWith(info.cwd + ":" + info.branch + "  "), "one painted padding plus one exterior margin");
  assert.ok(row.startsWith(" ┃ M (raw-id) • off"));
  assert.match(row, /off {2,}\/tidy-ui-directory\//u);
});

test("editor directory colors keep last path element distinct from parents and branch", () => {
  const calls: [string, string][] = [];
  const info = { model: "M", provider: "P", thinking: "high", idle: true, cwd: "/tidy-ui-directory/project", branch: "main" };
  renderEditorStatus(100, { fg: (role, value) => { calls.push([role, value]); return value; } }, info);
  for (const expected of [["dim", "/tidy-ui-directory/"], ["mdLinkUrl", "project"], ["muted", ":"], ["text", "main"]])
    assert.ok(calls.some(call => call[0] === expected[0] && call[1] === expected[1]), JSON.stringify(expected));
});

test("editor directory retains its last name before a long branch and recovers on resize", () => {
  const info = { model: "long model name", provider: "raw-provider", thinking: "high", idle: false,
    cwd: "/home/kot/work/important", branch: "feature/something-extremely-long" };
  const theme = { fg: (_role: string, value: string) => value };
  const wide = plain(renderEditorStatus(120, theme, info)[0]!);
  const narrow = plain(renderEditorStatus(32, theme, info)[0]!);
  assert.ok(narrow.includes("important"), "whole last directory outranks branch and parent path");
  assert.ok(!narrow.includes(info.branch)); assert.ok(narrow.includes("…"));
  assert.equal(plain(renderEditorStatus(120, theme, info)[0]!), wide);
});

test("Git branch source validates real repository kinds without environment redirection", async () => {
  const { GitBranchSource } = await import("../src/git-branch.ts");
  const base = mkdtempSync(join(tmpdir(), "tidy-ui-git-"));
  const git = (cwd: string, ...args: string[]) => {
    const result = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr); return result.stdout.trim();
  };
  const sources: InstanceType<typeof GitBranchSource>[] = [];
  try {
    const plainDir = join(base, "plain"), fake = join(base, "fake"), repo = join(base, "repo"), bare = join(base, "bare");
    for (const cwd of [plainDir, fake, repo, bare]) mkdirSync(cwd);
    mkdirSync(join(fake, ".git"));
    git(repo, "init", "-b", "unborn"); git(bare, "init", "--bare", "-b", "bare-main");
    const nested = join(repo, "nested"); mkdirSync(nested);
    for (const [cwd, expected] of [[plainDir, undefined], [fake, undefined], [repo, "unborn"], [nested, "unborn"], [bare, "bare-main"]] as const) {
      const source = new GitBranchSource(() => {}); sources.push(source);
      source.setDirectory(cwd); await awaitFixture(source.settled()); assert.equal(source.branch(cwd), expected);
    }
    const poisoned = new GitBranchSource(() => {}, { env: { ...process.env, GIT_DIR: join(bare, "."), GIT_WORK_TREE: bare } });
    sources.push(poisoned); poisoned.setDirectory(plainDir); await awaitFixture(poisoned.settled()); assert.equal(poisoned.branch(plainDir), undefined);
    poisoned.setDirectory(repo); await awaitFixture(poisoned.settled()); assert.equal(poisoned.branch(repo), "unborn");
    git(repo, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "--allow-empty", "-m", "initial");
    git(repo, "checkout", "--detach"); poisoned.refresh(true); await awaitFixture(poisoned.settled()); assert.equal(poisoned.branch(repo), undefined);
    const worktree = join(base, "linked"); git(repo, "worktree", "add", "-b", "linked-name", worktree);
    poisoned.setDirectory(worktree); await awaitFixture(poisoned.settled()); assert.equal(poisoned.branch(worktree), "linked-name");
  } finally { for (const source of sources) source.dispose(); rmSync(base, { recursive: true, force: true }); }
});

test("Git branch source observes atomic HEAD changes with zero warm-frame queries", async () => {
  const { GitBranchSource, gitDiagnostics } = await import("../src/git-branch.ts");
  const cwd = mkdtempSync(join(tmpdir(), "tidy-ui-git-watch-"));
  let resolve: (() => void) | undefined;
  const source = new GitBranchSource(() => resolve?.());
  try {
    assert.equal(spawnSync("git", ["-C", cwd, "init", "-b", "first"]).status, 0);
    source.setDirectory(cwd); await awaitFixture(source.settled()); assert.equal(source.branch(cwd), "first");
    const before = gitDiagnostics();
    for (let n = 0; n < 100; n++) { source.setDirectory(cwd); source.branch(cwd); }
    await awaitFixture(source.settled()); assert.equal(gitDiagnostics().queries, before.queries);
    const changed = new Promise<void>(done => { resolve = done; });
    assert.equal(spawnSync("git", ["-C", cwd, "symbolic-ref", "HEAD", "refs/heads/second"]).status, 0);
    await awaitFixture(changed);
    await awaitFixture(source.settled()); assert.equal(source.branch(cwd), "second");
    assert.ok(gitDiagnostics().queries > before.queries);
    source.dispose(); assert.equal(source.branch(cwd), undefined);
  } finally { source.dispose(); rmSync(cwd, { recursive: true, force: true }); }
});

test("directory reduction stages are ordered and column/grapheme safe", () => {
  const theme = { fg: (_role: string, value: string) => value };
  const path = "/home/kot/work/project", branch = "feature/input-status";
  for (const [width, expected] of [[43, path + ":" + branch], [40, "/home/ko…rk/project:" + branch],
    [36, "/home/…/project:" + branch], [21, "/home/…/project:fe…us"], [20, "…/project:fe…us"],
    [14, "…/project:fe…s"], [12, "…/project:f…"], [11, "…/project"], [8, "project"], [6, "proje…"], [2, "p…"], [1, ""]] as const)
    assert.equal(directoryStatus(path, branch, width, theme), expected, `stage width ${width}`);
  for (const cwd of ["/", "C:\\", "\\\\server\\share\\", "C:\\Users\\kot\\project", "/project", "project",
    "/home/界界/é👨‍👩‍👧‍👦界", "/home/kot/trailing/", "/tmp/\x1b[31mname\n"]) {
    for (let width = 0; width < 100; width++) {
      const text = directoryStatus(cwd, "alpha界界界", width, theme);
      assert.ok(visibleWidth(text) <= width, JSON.stringify({ cwd, width, text }));
      assert.notEqual(text, "…"); assert.ok(!text.endsWith(":")); assert.ok(!text.includes("……"));
      assert.ok(!text.includes("\x1b") && !text.includes("\n"));
    }
  }
  assert.equal(directoryStatus("/home/kot/trailing/", undefined, 100, theme), "/home/kot/trailing");
  assert.equal(directoryStatus("/", "main", 100, theme), "/:main");
  assert.equal(directoryStatus("C:\\", undefined, 100, theme), "C:\\");
  assert.equal(directoryStatus("~\\", undefined, 100, theme), "~");
  const calls: [string, string][] = [];
  assert.equal(directoryStatus("~\\parent\\project", "main", 100, { fg: (role, value) => { calls.push([role, value]); return value; } }), "~\\parent\\project:main");
  assert.deepEqual(calls, [["dim", "~\\parent\\"], ["mdLinkUrl", "project"], ["muted", ":"], ["text", "main"]]);
  assert.equal(directoryStatus("\\\\server\\share\\", undefined, 100, theme), "\\\\server\\share\\");
});

test("directory column quotas preserve Idle and release missing-block allocation", () => {
  const theme = { fg: (_role: string, value: string) => value };
  const info = { model: "m".repeat(80), provider: "p".repeat(80), thinking: "high", idle: true,
    cwd: "/home/kot/work/important", branch: "b".repeat(80) };
  for (let width = 7; width < 130; width++) {
    const row = plain(renderEditorStatus(width, theme, info)[0]!);
    assert.equal(visibleWidth(row), width);
    if (width >= 9) assert.ok(row.includes("Idle"));
    assert.equal(plain(renderEditorStatus(width, theme, info)[0]!), row, "deterministic resize fitting");
  }
  const plainInfo = { ...info, cwd: "/x", branch: undefined, idle: false };
  const row = plain(renderEditorStatus(100, theme, plainInfo)[0]!);
  assert.ok(row.includes("m".repeat(80)), "short right block releases quota back to left");
});

test("Git branch source ignores late cancelled replies and releases jobs/watches", async () => {
  const { GitBranchSource, gitDiagnostics } = await import("../src/git-branch.ts");
  let release: ((value: { ok: boolean; output: string }) => void) | undefined;
  let started: (() => void) | undefined;
  const waiting = new Promise<void>(done => { started = done; });
  const before = gitDiagnostics();
  const source = new GitBranchSource(() => {}, { execute: async (cwd, args) => {
    if (args[1] === "--local-env-vars") return { ok: true, output: "GIT_DIR\n" };
    if (args[0] !== "symbolic-ref") return { ok: false, output: "" };
    if (cwd === "/tidy-ui-old-not-present") { started?.(); return new Promise(done => { release = done; }); }
    return { ok: true, output: "refs/heads/fresh\n" };
  } });
  source.setDirectory("/tidy-ui-old-not-present"); await waiting;
  source.setDirectory("/tidy-ui-new-not-present");
  release!({ ok: true, output: "refs/heads/stale\n" }); await awaitFixture(source.settled());
  assert.equal(source.branch("/tidy-ui-old-not-present"), undefined);
  assert.equal(source.branch("/tidy-ui-new-not-present"), "fresh");
  source.dispose(); await awaitFixture(source.settled());
  assert.equal(gitDiagnostics().activeJobs, before.activeJobs); assert.equal(gitDiagnostics().watchers, before.watchers);
});

test("Git branch source recovers repository creation and supports available reftable watches", async t => {
  const { GitBranchSource } = await import("../src/git-branch.ts");
  const cwd = mkdtempSync(join(tmpdir(), "tidy-ui-git-new-"));
  let listener: (() => void) | undefined;
  const source = new GitBranchSource(() => listener?.());
  const change = async (action: () => void) => {
    let timer: ReturnType<typeof setTimeout>;
    const done = new Promise<void>((resolve, reject) => {
      listener = resolve; timer = setTimeout(() => reject(new Error("repository watch did not refresh")), 3000);
    });
    try { action(); await done; await awaitFixture(source.settled()); } finally { clearTimeout(timer!); listener = undefined; }
  };
  try {
    source.setDirectory(cwd); await awaitFixture(source.settled()); assert.equal(source.branch(cwd), undefined);
    await change(() => { assert.equal(spawnSync("git", ["-C", cwd, "init", "-b", "created"]).status, 0); });
    assert.equal(source.branch(cwd), "created");
    source.dispose(); await awaitFixture(source.settled()); rmSync(join(cwd, ".git"), { recursive: true });
    const reftable = spawnSync("git", ["-C", cwd, "init", "--ref-format=reftable", "-b", "table-first"]);
    if (reftable.status !== 0) { t.diagnostic("Git reftable is unavailable; repository creation control passed"); return; }
    source.setDirectory(cwd); await awaitFixture(source.settled()); assert.equal(source.branch(cwd), "table-first");
    await change(() => { assert.equal(spawnSync("git", ["-C", cwd, "symbolic-ref", "HEAD", "refs/heads/table-next"]).status, 0); });
    assert.equal(source.branch(cwd), "table-next");
  } finally { source.dispose(); await awaitFixture(source.settled()); rmSync(cwd, { recursive: true, force: true }); }
});

test("Git rediscovery rearms watches after same-path metadata directory replacement", async () => {
  const { GitBranchSource } = await import("../src/git-branch.ts");
  const base = mkdtempSync(join(tmpdir(), "tidy-ui-git-replaced-")), cwd = join(base, "current"), other = join(base, "other");
  mkdirSync(cwd); mkdirSync(other);
  const git = (path: string, ...args: string[]) => assert.equal(spawnSync("git", ["-C", path, ...args]).status, 0);
  let listener: (() => void) | undefined;
  const source = new GitBranchSource(() => listener?.());
  const change = async (expected: string, action: () => void) => {
    let timer: ReturnType<typeof setTimeout>;
    const changed = new Promise<void>((done, fail) => {
      listener = () => { if (source.branch(cwd) === expected) done(); };
      timer = setTimeout(() => fail(new Error(`watch did not publish ${expected}; actual ${source.branch(cwd)}`)), 1500);
    });
    try { action(); await changed; await awaitFixture(source.settled()); } finally { clearTimeout(timer!); listener = undefined; }
  };
  try {
    git(cwd, "init", "-b", "first"); git(other, "init", "-b", "second");
    source.setDirectory(cwd); await awaitFixture(source.settled()); assert.equal(source.branch(cwd), "first");
    await change("second", () => {
      renameSync(join(cwd, ".git"), join(base, "moved-away")); renameSync(join(other, ".git"), join(cwd, ".git"));
    });
    await change("third", () => git(cwd, "symbolic-ref", "HEAD", "refs/heads/third"));
    assert.equal(source.branch(cwd), "third");
  } finally { source.dispose(); await awaitFixture(source.settled()); rmSync(base, { recursive: true, force: true }); }
});

test("Git failures omit branch without blocking cwd or retaining resources", async () => {
  const { GitBranchSource, gitDiagnostics } = await import("../src/git-branch.ts");
  const cwd = mkdtempSync(join(tmpdir(), "tidy-ui-git-error-"));
  const records: { explanation: string; fields?: import('../src/diagnostics.ts').DiagnosticFields }[] = [];
  const before = gitDiagnostics(), source = new GitBranchSource(() => {}, { env: { ...process.env, PATH: "/git-not-present" },
    diagnostic: (_level, _area, explanation, fields) => records.push({ explanation, fields }) });
  try {
    source.setDirectory(cwd); await awaitFixture(source.settled()); assert.equal(source.branch(cwd), undefined);
    const current = gitDiagnostics(); assert.equal(current.spawned, before.spawned, "missing binary started zero processes");
    assert.equal(records.find(record => record.explanation.startsWith('Git query did not succeed'))?.fields?.code, 'ENOENT');
    for (let n = 0; n < 50; n++) source.setDirectory(cwd);
    await awaitFixture(source.settled()); assert.equal(gitDiagnostics().queries, current.queries, "no retry polling on errors");
  } finally { source.dispose(); await awaitFixture(source.settled()); rmSync(cwd, { recursive: true, force: true }); }
  assert.equal(gitDiagnostics().watchers, before.watchers); assert.equal(gitDiagnostics().activeJobs, before.activeJobs);
});

test("Git rediscovery reads HEAD after installing current metadata watches", async () => {
  const { GitBranchSource } = await import("../src/git-branch.ts");
  const cwd = mkdtempSync(join(tmpdir(), "tidy-ui-git-rearm-race-"));
  assert.equal(spawnSync("git", ["-C", cwd, "init", "-b", "before-rearm"]).status, 0);
  let armed = false, mutations = 0;
  const source = new GitBranchSource(() => {}, { execute: async (path, args, env) => {
    const result = spawnSync("git", ["-C", path, ...args], { env, encoding: "utf8" });
    if (armed && args.includes("--git-common-dir")) {
      armed = false; mutations++;
      assert.equal(spawnSync("git", ["-C", cwd, "symbolic-ref", "HEAD", "refs/heads/changed-during-rearm"]).status, 0);
    }
    return { ok: result.status === 0, output: result.stdout, code: result.status ?? undefined };
  } });
  try {
    source.setDirectory(cwd); await awaitFixture(source.settled()); assert.equal(source.branch(cwd), "before-rearm");
    armed = true; source.refresh(true); await awaitFixture(source.settled());
    assert.equal(mutations, 1, "one controlled HEAD mutation before metadata-query completion");
    assert.equal(source.branch(cwd), "changed-during-rearm", "publish post-installation HEAD, not stale pre-rearm snapshot");
  } finally { source.dispose(); await awaitFixture(source.settled()); rmSync(cwd, { recursive: true, force: true }); }
});

test("Git repository environment isolation removes case-variant redirect keys", async () => {
  const { GitBranchSource } = await import("../src/git-branch.ts");
  const source = new GitBranchSource(() => {}, { env: { Path: "/git", git_dir: "elsewhere", Git_Work_Tree: "wrong" },
    execute: async (_cwd, args, env) => {
      if (args.includes("--local-env-vars")) return { ok: true, output: "GIT_DIR\nGIT_WORK_TREE\n" };
      assert.ok(!Object.keys(env).some(key => ["GIT_DIR", "GIT_WORK_TREE"].includes(key.toUpperCase())), "Windows environment keys are case-insensitive");
      return { ok: args[0] === "symbolic-ref", output: args[0] === "symbolic-ref" ? "refs/heads/isolated\n" : "" };
    } });
  try {
    source.setDirectory("/tidy-ui-env-not-present"); await awaitFixture(source.settled());
    assert.equal(source.branch("/tidy-ui-env-not-present"), "isolated");
  } finally { source.dispose(); await awaitFixture(source.settled()); }
});

// Footer integration starts with real SDK mounting/public UI and real session records.
// The deterministic context/auth fixtures never emulate the native footer renderer.
const footerForeignEditor: NonNullable<ReturnType<ExtensionContext["ui"]["getEditorComponent"]>> =
  (value, theme, keys) => new CustomEditor(value, theme, keys);

async function footerSetup(foreignEditor = false, selectorAtStartup = false) {
  const { SessionManager } = await import("@earendil-works/pi-coding-agent");
  const { FooterComponent } = await import("../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/components/footer.js");
  initTheme("dark");
  const manager = SessionManager.inMemory("/footer-probe");
  const model = { id: "FOOTER_MODEL", name: "Footer Model", provider: "footer-provider", contextWindow: 272000 };
  let context: { tokens: number | null; percent: number | null; contextWindow: number } | undefined = { tokens: 104500, percent: 104500 / 272000 * 100, contextWindow: 272000 };
  let scans = 0, contextReads = 0, nameReads = 0, authReads = 0, auto = true, subscription = true;
  const getName = manager.getSessionName.bind(manager);
  manager.getSessionName = () => { nameReads++; return getName(); };
  const entries = manager.getEntries.bind(manager);
  manager.getEntries = () => { scans++; return entries(); };
  const statuses = new Map<string, string>([["magic-context", "mc: 104.5K (51%) · idle"]]);
  const data = { getGitBranch: () => "FOOTER_BRANCH", getAvailableProviderCount: () => 2,
    getExtensionStatuses: () => statuses, onBranchChange: () => () => {} };
  const { root, editor, keybindings } = editorSetup(); root.clear();
  Object.assign(root, { setFocus() {} });
  const input = new Container(); input.addChild(editor);
  const readContext = () => { contextReads++; return context; };
  const session = { sessionManager: manager, model, state: { model, thinkingLevel: "off" },
    modelRuntime: { isUsingSubscription: () => subscription }, getContextUsage: readContext };
  const native = new FooterComponent(session as never, data);
  const footer = new Container(); footer.addChild(native);
  const above = new Container(), below = new Container();
  const host = Object.assign(Object.create(InteractiveMode.prototype), { ui: root, footerContainer: footer,
    footer: native, footerDataProvider: data, customFooter: undefined,
    defaultEditor: editor, editor, editorContainer: input, statusContainer: new Container(), keybindings,
    widgetContainerAbove: above, widgetContainerBelow: below,
    extensionWidgetsAbove: new Map(), extensionWidgetsBelow: new Map() });
  for (const child of [new Container(), new Container(), host.statusContainer, above, input, below, footer]) root.addChild(child);
  const handlers = new Map<string, Function[]>();
  let command: Function;
  const pi = { on(name: string, fn: Function) { handlers.set(name, [...(handlers.get(name) ?? []), fn]); return () => {}; },
    registerFlag() {}, getFlag() {}, getThinkingLevel: () => "off", getSettings: () => ({ compaction: { enabled: auto } }),
    registerCommand(name: string, options: { handler: Function }) { if (name === "tidy-ui") command = options.handler; } };
  const ctx = { mode: "tui", hasUI: true, cwd: "/footer-probe", ui: { ...host.createExtensionUIContext(), notify() {} }, model, sessionManager: manager,
    modelRegistry: { isUsingOAuth: () => { authReads++; return subscription; }, getProvider: () => { authReads++; return { auth: { oauth: { isSubscription: true } } }; } },
    getContextUsage: readContext, isIdle: () => true };
  const emit = (name: string, event: unknown = {}) => Promise.all((handlers.get(name) ?? []).map(fn => fn(event, ctx)));
  const append = (input = 11000000, output = 1500000, cacheRead = 243000000, cacheWrite = 0, cost = 61.761) => manager.appendMessage({
    role: "assistant", content: [{ type: "text", text: "FOOTER_USAGE" }], api: "openai-responses", provider: model.provider,
    model: model.id, timestamp: 1, stopReason: "stop", usage: { input, output, cacheRead, cacheWrite, totalTokens: input + output + cacheRead + cacheWrite,
      cost: { input: cost, output: 0, cacheRead: 0, cacheWrite: 0, total: cost } } });
  if (foreignEditor) ctx.ui.setEditorComponent(footerForeignEditor);
  if (selectorAtStartup) { input.clear(); input.addChild(new Text("NATIVE_RELOAD_BOX", 0, 0)); }
  append(); tidyUi(pi as unknown as ExtensionAPI, { logging: false, settings: fixtureSyntaxOptions().settings, syntax: fixtureSyntaxOptions }); await emit('session_start');
  return { root, host, footer, native, ctx, manager, statuses, append, emit, editor, input,
    render: (width = 140) => footer.children[0]!.render(width), counts: () => ({ scans, contextReads }), authReads: () => authReads,
    nameReads: () => nameReads,
    context(value: typeof context) { context = value; }, auto(value: boolean) { auto = value; }, subscription(value: boolean) { subscription = value; },
    control: (action: string) => setAppearance(command! as any, ctx as unknown as ExtensionContext, action === 'on'), close: () => emit("session_shutdown") };
}

test("footer uses structured native usage with requested ordering and no cwd/model", async () => {
  const f = await footerSetup();
  try {
    const rows = f.render().map(stripVTControlCharacters);
    assert.equal(rows.length, 1);
    assert.match(rows[0]!, /^\[·········▁\] CH95\.7% • 105k\/272k \(38\.4%\)/u);
    assert.doesNotMatch(rows[0]!, /↑|↓|R243|W\d|\$|\(sub\)|\(auto\)/u);
    assert.equal(f.authReads(), 0, "hidden cost never reads authentication");
    assert.ok(rows[0]!.endsWith("mc: 104.5K (51%) · idle"));
    assert.ok(!rows.join("\n").includes("FOOTER_MODEL")); assert.ok(!rows.join("\n").includes("FOOTER_BRANCH"));
    assert.ok(!rows.join("\n").includes("/footer-probe"));
  } finally { f.close(); }
});

test("footer moves whole statuses before truncation and right-aligns overflow", async () => {
  const f = await footerSetup();
  try {
    f.statuses.clear(); f.statuses.set("b", "SECOND_STATUS"); f.statuses.set("a", "FIRST_STATUS");
    const rows = f.render(60).map(stripVTControlCharacters);
    assert.ok(rows[0]!.trimEnd().endsWith("FIRST_STATUS"));
    assert.equal(rows[1], " ".repeat(60 - 13) + "SECOND_STATUS");
    for (const row of rows) assert.doesNotMatch(row, /^\s*•|•\s*$/u, "no dangling separator at a status row break");
    f.statuses.clear(); f.statuses.set("x", "LONG_STATUS_" + "界é".repeat(40));
    const narrow = f.render(24).map(stripVTControlCharacters);
    const status = narrow.find(row => row.includes("LONG_STATUS_"))!;
    assert.ok(status.endsWith("…")); assert.ok(visibleWidth(status) <= 24);
    assert.equal(narrow.filter(row => row.includes("LONG_STATUS_")).length, 1);
    assert.equal(narrow.length, 2, "one truncated statistics row plus one whole producer status row");
    assert.ok(narrow[0]!.startsWith("[·········▁] CH95.7%") && narrow[0]!.endsWith("…"));
    assert.ok(!narrow[0]!.includes("105k"), "tail clipping preserves cache information before context");
  } finally { f.close(); }
});

test("footer refreshes nullable context window flags and native cache writes", async () => {
  const f = await footerSetup();
  try {
    f.context({ tokens: 1500000, contextWindow: 2000000, percent: 75 }); f.emit("model_select");
    assert.ok(f.render().map(stripVTControlCharacters).join(" ").includes("1.50M/2.00M (75.0%)"));
    f.context({ tokens: null, contextWindow: 272000, percent: null }); f.emit("session_compact");
    f.auto(false); f.subscription(false); f.append(5, 6, 0, 12, 0);
    const rows = f.render().map(stripVTControlCharacters).join(" ");
    assert.ok(rows.includes("?/272k")); assert.ok(!rows.includes("(0.0%)")); assert.ok(!rows.includes("(auto)")); assert.ok(!rows.includes("(sub)"));
    assert.ok(rows.includes("(auto off)")); assert.ok(rows.includes("CH0.0%")); assert.ok(!rows.includes("W12"));
  } finally { f.close(); }
});

test("footer warm frames avoid session scans and context reads across status width theme invalidations", async () => {
  const f = await footerSetup();
  try {
    const first = f.render(); const before = f.counts();
    for (let i = 0; i < 32; i++) assert.equal(f.render(), first, "latest unchanged layout rows are reused");
    f.statuses.set("extra", "EXTRA"); f.render(60); f.host.customFooter.invalidate(); f.render(60);
    assert.deepEqual(f.counts(), before);
    f.append(1, 2, 3, 4, 0); f.render(60);
    assert.deepEqual(f.counts(), { scans: before.scans + 1, contextReads: before.contextReads + 1 });
    const leaf = f.manager.getLeafId()!; f.append(1, 2, 3, 4, 0); f.manager.branch(leaf); f.emit("session_tree");
    const rows = f.render().map(stripVTControlCharacters).join(" ");
    assert.ok(rows.includes("[·······▁▅▅] CH37.5%"), "branch-back retains reports from abandoned raw history");
  } finally { f.close(); }
});

test("footer session title follows native resume fallback through first message rename clear and raw branches", async () => {
  const { footerDiagnostics } = await import("../src/footer.ts");
  const f = await footerSetup();
  try {
    f.statuses.clear();
    const title = () => f.render().map(stripVTControlCharacters).join(" ");
    assert.ok(title().endsWith(" • (no messages)"));
    f.manager.appendMessage({ role: "user", content: [{ type: "image", data: "", mimeType: "image/png" }], timestamp: 1 });
    await f.emit("message_end"); assert.ok(title().endsWith(" • (no messages)"));
    f.manager.appendMessage({ role: "user", content: [{ type: "text", text: "First" }, { type: "image", data: "", mimeType: "image/png" }, { type: "text", text: "session message" }], timestamp: 2 });
    await f.emit("message_end"); assert.ok(title().endsWith(" • First session message"));
    const first = f.manager.getLeafId()!, found = footerDiagnostics();
    f.manager.appendMessage({ role: "user", content: "A later message is not the title", timestamp: 3 });
    await f.emit("message_end"); assert.ok(title().endsWith(" • First session message"));
    assert.equal(footerDiagnostics().titleLookups, found.titleLookups, "first raw text is stable under later appends");
    assert.equal(footerDiagnostics().titleEntries, found.titleEntries);
    const before = f.counts(), names = f.nameReads();
    f.manager.appendSessionInfo("Explicit title"); await f.emit("session_info_changed", { name: "Explicit title" });
    assert.ok(title().endsWith(" • Explicit title"));
    f.manager.appendSessionInfo(""); await f.emit("session_info_changed", { name: undefined });
    assert.ok(title().endsWith(" • First session message"));
    assert.deepEqual(f.counts(), before, "rename/clear uses cached fallback without rereading history/context");
    assert.equal(f.nameReads(), names + 2);
    const row = f.render(); for (let i = 0; i < 20; i++) assert.equal(f.render(), row);
    f.render(80); f.statuses.set("extra", "EXTRA"); f.render(140); f.statuses.clear();
    assert.deepEqual(f.counts(), before); assert.equal(f.nameReads(), names + 2);
    assert.equal(footerDiagnostics().titleLookups, found.titleLookups);
    assert.equal(footerDiagnostics().titleEntries, found.titleEntries);
    f.manager.resetLeaf(); await f.emit("session_tree");
    assert.ok(title().endsWith(" • First session message"), "resume uses first raw user text even outside current branch");
    f.manager.createBranchedSession(first); await f.emit("session_start", { reason: "fork" });
    assert.ok(title().endsWith(" • First session message"), "fork uses its retained file entries");
    await f.control("off"); await f.control("on"); assert.ok(title().endsWith(" • First session message"));
    await f.emit("session_start", { reason: "reload" }); assert.ok(title().endsWith(" • First session message"));
    f.manager.newSession(); await f.emit("session_start", { reason: "new" }); assert.ok(title().endsWith(" • (no messages)"));
  } finally { f.close(); }
});

test("footer session names refresh independently of usage and retain warm layouts", async () => {
  const { footerDiagnostics } = await import("../src/footer.ts");
  const f = await footerSetup();
  try {
    const baseline = f.render(), before = f.counts();
    for (const name of ["SESSION_TITLE", "X", "", "Another session"]) {
      const nameReads = f.nameReads();
      f.manager.appendSessionInfo(name); f.emit("session_info_changed", { name: name || undefined });
      const updated = f.render();
      assert.equal(f.nameReads(), nameReads + 1, "one saved-name lookup at a metadata boundary");
      if (name) assert.ok(updated.map(stripVTControlCharacters).join(" ").includes(" • " + name));
      else assert.deepEqual(updated.map(stripVTControlCharacters), baseline.map(stripVTControlCharacters));
      assert.deepEqual(f.counts(), before, "rename/clear is not a usage or context invalidation");
      const warm = footerDiagnostics();
      for (let i = 0; i < 20; i++) assert.equal(f.render(), updated);
      f.statuses.set("extra", "EXTRA"); f.render(100); f.render(140); f.statuses.delete("extra");
      assert.equal(footerDiagnostics().aggregations, warm.aggregations);
      assert.equal(f.nameReads(), nameReads + 1, "warm/resize/status changes never search the name again");
    }
    f.manager.appendSessionInfo("Pending title one"); f.emit("session_info_changed", { name: "Pending title one" });
    f.manager.appendSessionInfo("Pending title two"); f.emit("session_info_changed", { name: "Pending title two" });
    assert.ok(f.render().map(stripVTControlCharacters).join(" ").includes("Pending title two"));
    assert.deepEqual(f.counts(), before, "consecutive metadata-only appends do not rescan history");
    f.append(1, 2, 3, 4, 0); f.manager.appendSessionInfo("After real usage"); f.emit("session_info_changed", { name: "After real usage" });
    f.render(); assert.deepEqual(f.counts(), { scans: before.scans + 1, contextReads: before.contextReads + 1 }, "name must not hide an intervening usage append");
    f.manager.appendSessionInfo(""); f.emit("session_info_changed", { name: undefined });
    f.render(); f.statuses.delete("extra");
    assert.ok(!f.render().map(stripVTControlCharacters).join(" ").includes("After real usage"));
    assert.notEqual(f.render(), baseline);
  } finally { f.close(); }
});

test("footer session name late older events cannot overwrite the current saved name", async () => {
  const f = await footerSetup();
  try {
    f.render(); const before = f.counts();
    f.manager.appendSessionInfo("Older title"); f.manager.appendSessionInfo("Current title");
    f.emit("session_info_changed", { name: "Current title" });
    assert.ok(f.render().map(stripVTControlCharacters).join(" ").includes("Current title"));
    f.emit("session_info_changed", { name: "Older title" });
    const row = f.render().map(stripVTControlCharacters).join(" ");
    assert.ok(row.includes("Current title"), "concurrent async dispatch may deliver an older notification last");
    assert.ok(!row.includes("Older title")); assert.deepEqual(f.counts(), before);
    await f.control("off"); f.manager.newSession(); await f.emit("session_start", { reason: "new" });
    f.emit("session_info_changed", { name: "Older title" }); await f.control("on");
    assert.ok(!f.render().map(stripVTControlCharacters).join(" ").includes("Older title"), "delayed notification must not rename a replacement session");
  } finally { f.close(); }
});

test("footer session name requests a fresh owned frame after delayed event delivery", async () => {
  const f = await footerSetup();
  try {
    const baseline = f.render(), before = f.counts();
    f.manager.appendSessionInfo("Delayed title");
    assert.equal(f.render(), baseline, "native repaint can run before an earlier async event handler releases");
    const requests = f.root.requests;
    f.emit("session_info_changed", { name: "Delayed title" });
    assert.equal(f.root.requests, requests + 1, "name delivery requests its own frame even after native repaint");
    assert.ok(f.render().map(stripVTControlCharacters).join(" ").includes("Delayed title"));
    assert.deepEqual(f.counts(), before);
    const updated = f.render();
    f.emit("session_info_changed", { name: "Delayed title" });
    assert.equal(f.render(), updated, "duplicate metadata notice preserves the unchanged layout");
    await f.control("off"); const off = f.root.requests;
    f.manager.appendSessionInfo("Off title"); f.emit("session_info_changed", { name: "Off title" });
    assert.equal(f.root.requests, off, "released footer does not request a frame");
  } finally { f.close(); }
});

test("footer session name restores through off-on reload and new-session boundaries", async () => {
  const f = await footerSetup();
  try {
    f.manager.appendSessionInfo("Saved session title"); f.emit("session_info_changed", { name: "Saved session title" });
    const named = f.render().map(stripVTControlCharacters);
    await f.control("off"); await f.emit("session_start", { reason: "reload" });
    assert.equal(f.footer.children[0], f.native, "reload preserves the saved appearance-off preference");
    await f.control("on"); assert.deepEqual(f.render().map(stripVTControlCharacters), named);
    await f.emit("session_start", { reason: "reload" }); assert.deepEqual(f.render().map(stripVTControlCharacters), named);
    f.manager.newSession(); await f.emit("session_start", { reason: "new" });
    assert.ok(!f.render().map(stripVTControlCharacters).join(" ").includes("Saved session title"));
    f.manager.appendSessionInfo("Restored session title"); await f.emit("session_start", { reason: "resume" });
    assert.ok(f.render().map(stripVTControlCharacters).join(" ").includes("Restored session title"));
    const forkLeaf = f.manager.getLeafId()!;
    f.manager.appendSessionInfo("Later parent title"); f.emit("session_info_changed", { name: "Later parent title" });
    assert.ok(f.render().map(stripVTControlCharacters).join(" ").includes("Later parent title"));
    f.manager.createBranchedSession(forkLeaf); await f.emit("session_start", { reason: "fork" });
    const forked = f.render().map(stripVTControlCharacters).join(" ");
    assert.ok(forked.includes("Restored session title")); assert.ok(!forked.includes("Later parent title"));
  } finally { f.close(); }
});

test("footer owns public slot until disposed and never erases a later foreign footer", async () => {
  const f = await footerSetup();
  try {
    assert.notEqual(f.footer.children[0], f.native);
    await f.control("off"); assert.equal(f.footer.children[0], f.native);
    await f.control("on"); assert.notEqual(f.footer.children[0], f.native);
    const foreign = { render: () => ["FOREIGN_FOOTER"], invalidate() {} };
    f.ctx.ui.setFooter(() => foreign); await f.control("off");
    assert.equal(f.footer.children[0], foreign); f.close(); assert.equal(f.footer.children[0], foreign);
  } finally { f.close(); }
});

test("footer context precision normalizes k and M carries with magnitude-dependent trailing zeros", async () => {
  const { contextTokens } = await import("../src/footer.ts");
  for (const [count, expected] of [[0, "0k"], [104500, "105k"], [999499, "999k"], [999500, "1.00M"],
    [1000000, "1.00M"], [1200000, "1.20M"], [1500000, "1.50M"], [9996000, "10.0M"],
    [10000000, "10.0M"], [12400000, "12.4M"], [99960000, "100M"], [100000000, "100M"], [123000000, "123M"], [1234000000, "1234M"]] as const) {
    assert.equal(contextTokens(count), expected, String(count));
  }
});

test("footer cumulative accounting matches actual native SDK including side tool summaries and abandoned history", async () => {
  const f = await footerSetup();
  const { footerUsage } = await import("../src/footer.ts");
  try {
    const usage = { input: 7, output: 8, cacheRead: 9, cacheWrite: 10, totalTokens: 34,
      cost: { input: 0.5, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.5 } };
    f.manager.appendUsage("cache_warm", "probe", "probe", usage);
    f.manager.appendMessage({ role: "toolResult", toolCallId: "side", toolName: "side", content: [{ type: "text", text: "SIDE" }], isError: false, timestamp: 1, usage });
    f.manager.appendCompaction("summary", f.manager.getLeafId(), 100, undefined, true, usage);
    f.manager.branchWithSummary(null, "abandoned branch", undefined, true, usage);
    const total = footerUsage(f.manager.getEntries());
    const native = (f.native as any).getSessionStats(); // Actual SDK private accounting oracle, test-only.
    assert.deepEqual({ input: total.input, output: total.output, cacheRead: total.cacheRead, cacheWrite: total.cacheWrite, cost: total.cost }, native.usageTotals);
    assert.equal(total.cacheHitRate, native.latestCacheHitRate);
  } finally { f.close(); }
});

test("footer physical glyph colors CH displayed thresholds and raw native context warning thresholds", async () => {
  const { renderFooter } = await import("../src/footer.ts");
  const terminal = new xterm.Terminal({ cols: 180, rows: 4, allowProposedApi: true });
  const write = async (row: string) => { terminal.reset(); await new Promise<void>(resolve => terminal.write(row, resolve)); };
  const fg = (x: number) => { const c = terminal.buffer.active.getLine(0)!.getCell(x)!; return [c.getFgColorMode(), c.getFgColor()]; };
  try {
    for (const theme of ["dark", "light"]) {
      initTheme(theme);
      const refs: Record<string, number[]> = {};
      for (const role of ["text", "muted", "dim", "success", "warning", "error"] as const) { await write(nativeTheme.fg(role, "X")); refs[role] = fg(0); }
      for (const [rate, chColor] of [[79.94, "error"], [79.96, "warning"], [80, "warning"], [94.94, "warning"], [94.96, "success"], [95, "success"], [100, "success"], [0, "error"]] as const) {
        for (const [percent, percentColor] of [[70, "muted"], [70.01, "warning"], [90, "warning"], [90.01, "error"], [105, "error"]] as const) {
          const data = { usage: { input: 11e6, output: 1.5e6, cacheRead: 243e6, cacheWrite: 12, cost: 61.761, cacheHitRate: rate, cacheHitHistory: [rate] },
            context: { tokens: 104500, contextWindow: 272000, percent }, auto: true, subscription: true };
          const row = renderFooter(180, data, [], nativeTheme)[0]!;
          const text = stripVTControlCharacters(row); await write(row);
          const expect = (value: string, role: string) => { const start = text.indexOf(value); assert.ok(start >= 0, value); for (let i = start; i < start + value.length; i++) assert.deepEqual(fg(i), refs[role], `${theme} ${value} ${i}`); };
          expect("105k", "text"); expect("272k", "muted"); expect("·".repeat(9), "muted");
          for (const value of ["/", "(", ")", "[", "]", " • "]) expect(value, "dim");
          const glyph = [..."▁▂▃▄▅▆▇█"][Math.round(7 * (1 - Number(rate.toFixed(1)) / 100))]!;
          expect(glyph, chColor);
          const ch = text.indexOf("CH"); for (let i = ch; i < ch + ("CH" + rate.toFixed(1) + "%").length; i++) assert.deepEqual(fg(i), refs[chColor]);
          const p = text.indexOf("(" + percent.toFixed(1) + "%)");
          for (let i = p + 1; i < p + 1 + (percent.toFixed(1) + "%").length; i++) assert.deepEqual(fg(i), refs[percentColor]);
        }
      }
    }
  } finally { terminal.dispose(); initTheme("dark"); }
});

test("footer preserves producer ANSI isolates attributes and links and never splits whole statuses", async () => {
  const { renderFooter } = await import("../src/footer.ts"); initTheme("dark");
  const data = { usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, cacheHitHistory: [] }, auto: false, subscription: false };
  const terminal = new xterm.Terminal({ cols: 80, rows: 3, allowProposedApi: true });
  try {
    const producer = "\x1b[1;3;4;7;41;32mFIRST";
    const rows = renderFooter(80, data, [["a", producer], ["b", "NEXT"]], nativeTheme);
    assert.ok(rows[0]!.includes(producer));
    await new Promise<void>(resolve => terminal.write(rows[0]!, resolve));
    const text = stripVTControlCharacters(rows[0]!); const y = terminal.buffer.active.getLine(0)!;
    const first = text.indexOf("FIRST"), separator = text.indexOf("•", first + "FIRST".length);
    assert.equal(y.getCell(first)!.getBgColor(), 1);
    assert.ok(separator > first, "test the producer separator, not the earlier statistics bullet");
    await new Promise<void>(resolve => terminal.write("\r\n" + nativeTheme.fg("dim", "•"), resolve));
    const reference = terminal.buffer.active.getLine(1)!.getCell(0)!;
    const cell = y.getCell(separator)!;
    assert.equal(cell.getFgColorMode(), reference.getFgColorMode()); assert.equal(cell.getFgColor(), reference.getFgColor());
    for (const x of [separator, text.indexOf("NEXT", separator)]) {
      const cell = y.getCell(x)!; assert.ok(cell.isBgDefault());
      assert.ok(!cell.isBold() && !cell.isItalic() && !cell.isUnderline() && !cell.isInverse(), "producer attributes do not escape its boundary");
    }
    const status = "LINK\x1b]8;;https://example.test\x1b\\label";
    const links = renderFooter(80, data, [["a", status], ["b", "NEXT"]], nativeTheme);
    assert.ok(links[0]!.includes(status + "\x1b]8;;\x1b\\\x1b[0m"));
    const clean = renderFooter(80, data, [["a", "  \x1b[31m\x1b[0m  "], ["b", "LINE\nWITH\tTAB"], ["c", "LAST"]], nativeTheme);
    assert.ok(stripVTControlCharacters(clean[0]!).endsWith("LINE WITH TAB • LAST"));
    for (const width of [0, 1, 2, 3, 4, 5, 6, 24, 60, 100]) for (const row of renderFooter(width, data, [["a", "界é".repeat(60)]], nativeTheme)) assert.ok(visibleWidth(row) <= width);
  } finally { terminal.dispose(); }
});

test("footer missing context and unknown reports retain dots instead of invented zero", async () => {
  const f = await footerSetup();
  try {
    f.context(undefined); f.emit("session_compact");
    f.ctx.modelRegistry.getProvider = () => ({ auth: { oauth: { isSubscription: false } } });
    f.append(0, 0, 0, 0, 0);
    let text = f.render().map(stripVTControlCharacters).join(" ");
    assert.ok(!text.includes("272k")); assert.ok(!text.includes("(auto)"));
    assert.ok(text.includes("[········▁·] CH—")); assert.ok(!text.includes("(sub)"));
    f.append(10, 0, 0, 0, 0); text = f.render().map(stripVTControlCharacters).join(" ");
    assert.ok(text.includes("[·······▁·█] CH0.0%"), "real zero is a full error bar even without cache-read totals");
  } finally { f.close(); }
});

test("footer cache history retains ten distinct model reports even at the same percentage", async () => {
  const { SessionManager } = await import("@earendil-works/pi-coding-agent");
  const { footerUsage, renderFooter } = await import("../src/footer.ts");
  const manager = SessionManager.inMemory("/footer-history");
  const usage = { input: 900, output: 5, cacheRead: 100, cacheWrite: 0, totalTokens: 1005,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
  for (let i = 0; i < 20; i++) manager.appendMessage({ role: "assistant", content: [{ type: "text", text: "SAME_CH_" + i }],
    api: "openai-responses", provider: "probe", model: "probe", timestamp: i, stopReason: "toolUse", usage });
  const result = footerUsage(manager.getEntries());
  assert.deepEqual(result.cacheHitHistory, Array(10).fill(10));
  assert.equal(result.cacheHitRate, 10);
  const data = { usage: result, auto: true, subscription: false };
  assert.equal(stripVTControlCharacters(renderFooter(100, data, [], nativeTheme)[0]!), "[▇▇▇▇▇▇▇▇▇▇] CH10.0%");
  assert.equal(manager.getEntries().filter(e => e.type === "message").length, 20);
  for (let i = 0; i < 8; i++) assert.deepEqual(footerUsage(manager.getEntries()).cacheHitHistory, result.cacheHitHistory);
});

test("footer history orders evicts validates and counts reported errors without mixing side usage", async () => {
  const { SessionManager } = await import("@earendil-works/pi-coding-agent");
  const { footerUsage } = await import("../src/footer.ts");
  const manager = SessionManager.inMemory("/footer-history");
  const usage = (rate: number) => ({ input: 100 - rate, output: 0, cacheRead: rate, cacheWrite: 0, totalTokens: 100,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } });
  for (let i = 0; i < 12; i++) manager.appendMessage({ role: "assistant", content: [], api: "openai-responses", provider: "probe",
    model: "probe", timestamp: i, stopReason: i === 11 ? "error" : "stop", usage: usage(i * 5) });
  let reports = footerUsage(manager.getEntries()); assert.deepEqual(reports.cacheHitHistory, [10, 15, 20, 25, 30, 35, 40, 45, 50, 55].map(rate => rate / 100 * 100));
  manager.appendUsage("cache_warm", "probe", "probe", usage(100));
  manager.appendMessage({ role: "toolResult", toolCallId: "side", toolName: "side", content: [], timestamp: 15, isError: false, usage: usage(100) });
  manager.appendCompaction("summary", manager.getLeafId(), 100, undefined, true, usage(100));
  assert.deepEqual(footerUsage(manager.getEntries()).cacheHitHistory, reports.cacheHitHistory);
  for (const invalid of [usage(NaN), usage(-1), { ...usage(0), input: 0 }, { ...usage(0), input: Infinity }]) {
    manager.appendMessage({ role: "assistant", content: [], api: "openai-responses", provider: "probe", model: "probe",
      timestamp: 16, stopReason: "aborted", usage: invalid });
    reports = footerUsage(manager.getEntries()); assert.equal(reports.cacheHitHistory.at(-1), undefined); assert.equal(reports.cacheHitRate, undefined);
  }
  manager.appendMessage({ role: "assistant", content: [], api: "openai-responses", provider: "probe", model: "probe", timestamp: 17,
    stopReason: "stop", usage: { ...usage(50), input: 25, cacheWrite: 25 } });
  assert.equal(footerUsage(manager.getEntries()).cacheHitRate, 50, "cache writes belong to the prompt denominator");
  assert.equal(footerUsage(manager.getEntries()).cacheHitHistory.length, 10);
});

test("footer fields are source flags defaulting false with retained independent native formatting", async () => {
  const { FOOTER_FIELDS, renderFooter } = await import("../src/footer.ts");
  assert.deepEqual(FOOTER_FIELDS, { tokenTotals: false, cacheTotals: false, cost: false });
  const data = { usage: { input: 11e6, output: 1.5e6, cacheRead: 243e6, cacheWrite: 12, cost: 61.761,
    cacheHitRate: 95, cacheHitHistory: [95] }, auto: true, subscription: true };
  for (const tokenTotals of [false, true]) for (const cacheTotals of [false, true]) for (const cost of [false, true]) {
    const row = stripVTControlCharacters(renderFooter(200, data, [], nativeTheme, { tokenTotals, cacheTotals, cost })[0]!);
    assert.equal(row.includes("↑11M ↓1.5M"), tokenTotals);
    assert.equal(row.includes("R243M W12"), cacheTotals);
    assert.equal(row.includes("$61.761 (sub)"), cost);
    assert.ok(row.includes("[·········▁] CH95.0%"), "CH never depends on cumulative field flags");
  }
});

test("footer cost flag retains native OAuth subscription rules without hidden auth reads", async () => {
  const { FOOTER_FIELDS } = await import("../src/footer.ts");
  FOOTER_FIELDS.cost = true;
  let f: Awaited<ReturnType<typeof footerSetup>> | undefined;
  try {
    f = await footerSetup(); assert.ok(f.render().map(stripVTControlCharacters).join(" ").includes("$61.761 (sub)")); assert.ok(f.authReads() > 0);
    f.ctx.modelRegistry.getProvider = () => ({ auth: { oauth: { isSubscription: false } } });
    assert.ok(!f.render().map(stripVTControlCharacters).join(" ").includes("(sub)"), "OAuth alone is not subscription");
    f.ctx.model.provider = "kimi-coding"; f.subscription(false);
    assert.ok(f.render().map(stripVTControlCharacters).join(" ").includes("(sub)"), "native Kimi exception remains available behind flag");
  } finally { f?.close(); FOOTER_FIELDS.cost = false; }
});

test("footer empty cold unknown and auto-off states are distinct and fit exactly one statistics row", async () => {
  const { footerUsage, renderFooter } = await import("../src/footer.ts");
  const empty = { usage: footerUsage([]), context: { tokens: 104000, contextWindow: 272000, percent: 38.1 }, auto: true, subscription: false };
  const text = stripVTControlCharacters(renderFooter(100, empty, [], nativeTheme)[0]!);
  assert.equal(text, "[··········] CH— • 104k/272k (38.1%)");
  const disabled = { ...empty, auto: false };
  assert.equal(stripVTControlCharacters(renderFooter(100, disabled, [], nativeTheme)[0]!), "[··········] CH— • 104k/272k (38.1%) (auto off)");
  const unknown = { ...disabled, context: { tokens: null, contextWindow: 272000, percent: null } };
  assert.equal(stripVTControlCharacters(renderFooter(100, unknown, [], nativeTheme)[0]!), "[··········] CH— • ?/272k (auto off)");
  assert.equal(stripVTControlCharacters(renderFooter(100, { ...empty, context: undefined }, [], nativeTheme)[0]!), "[··········] CH—");
  assert.equal(stripVTControlCharacters(renderFooter(100, { ...disabled, context: undefined }, [], nativeTheme)[0]!), "[··········] CH— • (auto off)");
  const sample = { ...empty, context: { tokens: 130000, contextWindow: 272000, percent: 47.9 },
    usage: { ...empty.usage, cacheHitRate: 98.2, cacheHitHistory: Array(10).fill(98.2) } };
  assert.equal(stripVTControlCharacters(renderFooter(100, sample, [], nativeTheme)[0]!), "[▁▁▁▁▁▁▁▁▁▁] CH98.2% • 130k/272k (47.9%)");
  for (const width of [0, 1, 2, 3, 6, 11, 12, 20, 24, visibleWidth(text) - 1, visibleWidth(text), 100]) {
    const rows = renderFooter(width, empty, [], nativeTheme);
    assert.equal(rows.length, width ? 1 : 0, "statistics never wrap internally");
    if (!width) continue;
    assert.ok(visibleWidth(rows[0]!) <= width);
    assert.equal(stripVTControlCharacters(rows[0]!).endsWith("…"), width < visibleWidth(text));
    assert.deepEqual(empty.usage.cacheHitHistory, [], "clipping must not change saved numeric reports");
  }
});

test("footer auto-off annotation unknown marks and bracket colors remain semantic in both themes", async () => {
  const { footerUsage, renderFooter } = await import("../src/footer.ts");
  const terminal = new xterm.Terminal({ cols: 120, rows: 2, allowProposedApi: true });
  const write = async (row: string) => { terminal.reset(); await new Promise<void>(resolve => terminal.write(row, resolve)); };
  try {
    for (const theme of ["dark", "light"]) {
      initTheme(theme);
      const refs: Record<string, number> = {};
      for (const role of ["dim", "muted", "warning"] as const) { await write(nativeTheme.fg(role, "X")); refs[role] = terminal.buffer.active.getLine(0)!.getCell(0)!.getFgColor(); }
      const row = renderFooter(120, { usage: footerUsage([]), auto: false, subscription: false }, [], nativeTheme)[0]!;
      await write(row); const text = stripVTControlCharacters(row);
      for (const [value, role] of [["(", "dim"], [")", "dim"], ["auto off", "warning"], ["[", "dim"], ["]", "dim"], ["·".repeat(10), "muted"], ["CH—", "muted"], [" • ", "dim"]]) {
        const x = text.indexOf(value!); assert.ok(x >= 0);
        for (let i = x; i < x + value!.length; i++) assert.equal(terminal.buffer.active.getLine(0)!.getCell(i)!.getFgColor(), refs[role!]);
      }
    }
  } finally { terminal.dispose(); initTheme("dark"); }
});

test("footer report updates reconstruct across off-on without counting streaming or warm renders", async () => {
  const f = await footerSetup();
  try {
    const first = f.render(), leaf = f.manager.getLeafEntry();
    assert.ok(leaf?.type === 'message' && leaf.message.role === 'assistant');
    const message = leaf.message;
    f.emit("message_update", { type: 'message_update', message,
      assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'FOOTER_USAGE', partial: message } });
    assert.equal(f.render(), first);
    const before = f.counts();
    for (let i = 0; i < 20; i++) { f.append(900, 10, 100, 0, 0); f.emit("message_end"); f.render(); }
    let row = f.render().map(stripVTControlCharacters).join(" "); assert.ok(row.includes("[▇▇▇▇▇▇▇▇▇▇] CH10.0%"));
    assert.deepEqual(f.counts(), { scans: before.scans + 20, contextReads: before.contextReads + 20 });
    const hot = f.counts(); for (let i = 0; i < 20; i++) f.render(); assert.deepEqual(f.counts(), hot);
    await f.control("off"); await f.control("on");
    assert.equal(f.render().map(stripVTControlCharacters).join(" "), row, "history is derived from saved reports, not render timing");
  } finally { f.close(); }
});

test("footer stays native when the editor is foreign from startup including explicit on", async () => {
  const f = await footerSetup(true);
  try {
    assert.equal(f.footer.children[0], f.native);
    f.root.render(100); await Promise.resolve();
    await f.control("on"); assert.equal(f.footer.children[0], f.native);
    await f.control("off"); assert.equal(f.footer.children[0], f.native);
  } finally { f.close(); }
});

test("footer restores native after late editor takeover and on only installs with eligible editor", async () => {
  const f = await footerSetup();
  try {
    const first = f.footer.children[0]; assert.notEqual(first, f.native);
    f.ctx.ui.setEditorComponent(footerForeignEditor);
    f.root.render(100); await Promise.resolve();
    assert.equal(f.footer.children[0], f.native, "same-name public factory disables our footer too");
    await f.control("on"); assert.equal(f.footer.children[0], f.native);
    f.ctx.ui.setEditorComponent(undefined); f.root.render(100); await Promise.resolve();
    assert.equal(f.footer.children[0], f.native, "returning input never automatically reclaims a possibly foreign footer");
    await f.control("on");
    assert.notEqual(f.footer.children[0], f.native); assert.notEqual(f.footer.children[0], first);
    f.input.clear(); f.input.addChild({ render: () => ["NATIVE_SELECTOR"], invalidate() {} });
    f.root.render(100); await Promise.resolve();
    assert.notEqual(f.footer.children[0], f.native, "temporary native selector is not editor-feature disablement");
    f.input.clear(); f.input.addChild(f.editor);
  } finally { f.close(); }
});

test("footer editor loss preserves later foreign footer and overridden stock editor guard", async () => {
  const f = await footerSetup();
  try {
    const foreign = { render: () => ["FOREIGN_FOOTER"], invalidate() {} };
    f.ctx.ui.setFooter(() => foreign);
    f.ctx.ui.setEditorComponent(footerForeignEditor);
    f.root.render(100); await Promise.resolve();
    await f.control("on"); assert.equal(f.footer.children[0], foreign, "disabled input cannot reclaim a foreign footer");
    f.ctx.ui.setEditorComponent(undefined); await f.control("on");
    assert.notEqual(f.footer.children[0], foreign);
    Object.defineProperty(f.editor, "render", { configurable: true, value: () => ["FOREIGN_INSTANCE_RENDER"] });
    f.root.render(100); await Promise.resolve();
    assert.equal(f.footer.children[0], f.native, "method ownership guard and footer share eligibility");
    await f.control("on"); assert.equal(f.footer.children[0], f.native);
  } finally { Reflect.deleteProperty(f.editor, "render"); f.close(); }
});

test("footer deferred startup handles native reload box without stealing a later footer", async () => {
  for (const replacement of [false, true]) {
    const f = await footerSetup(false, true);
    try {
      assert.equal(f.footer.children[0], f.native);
      const foreign = { render: () => ["LATER_STARTUP_FOOTER"], invalidate() {} };
      if (replacement) f.ctx.ui.setFooter(() => foreign);
      f.input.clear(); f.input.addChild(f.editor);
      f.root.render(100); await Promise.resolve();
      if (replacement) assert.equal(f.footer.children[0], foreign, "delayed initial install verifies the exact previous footer owner");
      else assert.notEqual(f.footer.children[0], f.native, "default input returning after session_start finishes initial installation");
    } finally { f.close(); }
  }
});

test('Git diagnostics: expected absent reftable is quiet while refresh and watch rebinding remain intact', async () => {
  const { GitBranchSource, gitDiagnostics } = await import('../src/git-branch.ts');
  const before = gitDiagnostics();
  const cwd = mkdtempSync(join(tmpdir(), 'tidy-ui-git-diagnostics-')), records: { explanation: string; fields: unknown }[] = [];
  const source = new GitBranchSource(() => {}, { diagnostic: (_level, _area, explanation, fields) => records.push({ explanation, fields }) });
  try {
    assert.equal(spawnSync('git', ['-C', cwd, 'init', '-b', 'first']).status, 0);
    source.setDirectory(cwd); await awaitFixture(source.settled());
    for (let i = 0; i < 3; i++) { source.refresh(true); await awaitFixture(source.settled()); }
    assert.equal(records.filter(record => record.explanation.includes('watch unavailable')).length, 0);
    assert.equal(records.filter(record => record.explanation === 'Asynchronous Git refresh started').length, 4);
    assert.equal(gitDiagnostics().discoveries, before.discoveries + 4);
    assert.equal(gitDiagnostics().watchers, before.watchers + 2); assert.equal(source.branch(cwd), 'first');
  } finally { source.dispose(); rmSync(cwd, { recursive: true, force: true }); }
});
