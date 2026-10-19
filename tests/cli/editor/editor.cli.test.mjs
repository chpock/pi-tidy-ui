import '../../fixtures/test-guard.mjs';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { editorPaint } from '../../fixtures/editor-paint.ts';
import { PiTerminal, extension, fixtures, artifacts, plain, lines, byName, toolLines, assertFits } from '../../fixtures/terminal-harness.mjs';
import { closeTerminals, runCleanupSteps } from '../../fixtures/terminal-cleanup.mjs';
import { referenceCell, sgrAt, traffic, persisted, compactContent, summaryText, summaryExpected } from '../../fixtures/main-cli-support.mjs';

test('main editor user-card styling preserves real draft input, cursor, menus and lifecycle', {}, async () => {
  const terminals = [];
  const observe = async (terminal, name, action = 'snapshot') => {
    writeFileSync(join(terminal.output, 'editor-request.json'), JSON.stringify({ name, action }));
    terminal.send('\x1b\x04');
    if (action === 'on' || action === 'off') await terminal.appearance(action === 'on', { alreadyOpen: true });
    const dump = await terminal.waitForProgress(() => {
      terminal.health();
      try { return JSON.parse(readFileSync(join(terminal.output, `${name}.json`), 'utf8')); }
      catch (error) { if (error.code === 'ENOENT' || error instanceof SyntaxError) return false; throw error; }
    }, `editor ${name}`);
    await terminal.settle(); terminal.session = dump.session;
    assert.deepEqual(dump.after, dump.before, 'observation/style changes never transfer or rewrite the native draft');
    assert.equal(dump.exactStockPrototype, true); assert.equal(dump.sharedEditorPrototype, true);
    assert.equal(dump.inputMethodUnchanged, true);
    return terminal.captureScreen(name, dump);
  };
  const check = async (dump, needle) => {
    assert.ok(dump.rows.every(row => !row.includes('\0')), 'projection sentinels never reach the terminal');
    assert.ok(dump.rows.some(row => plain(row).includes('┃')), 'actual stock editor is framed');
    assert.ok(dump.rows.every(row => !plain(row).includes('─')), 'no native horizontal borders');
    const y = dump.screen.findIndex(row => row.includes(needle));
    assert.ok(y >= 0, `${needle} is physically painted`);
    const cells = dump.cells[y], border = cells.findIndex(cell => cell.text === '┃');
    assert.equal(border, 1, 'editor shares the user-card exterior margin');
    assert.equal(cells[2].text, ' ', 'one internal left pad');
    const background = await referenceCell(dump.styles.background), stripe = await referenceCell(dump.styles.border);
    for (let x = 2; x < dump.width - 1; x++) {
      assert.equal(cells[x].bgMode, background.bgMode); assert.equal(cells[x].bg, background.bg);
    }
    assert.equal(cells[1].fg, stripe.fg); assert.equal(cells[1].bgMode, 0);
    assert.equal(cells[0].bgMode, 0); assert.equal(cells.at(-1).bgMode, 0);
    const painted = editorPaint(dump.rows);
    const matching = painted.findIndex(row => plain(row).includes(needle));
    assert.equal(dump.rows.filter(row => row.includes('\x1b_pi:c')).length, 1, 'native hardware-cursor marker is retained');
    assert.equal(dump.screen[y].trimEnd(), plain(painted[matching]), 'physical row equals actual component paint (cursor marker is zero-column metadata)');
    await assertFits(dump.rows, dump.width);
  };
  try {
    for (const mode of ['fullscreen', 'regular']) {
      const terminal = new PiTerminal(`editor-${mode}`, { mode, agentSettings: { editorPaddingX: 1 }, extensions: [join(fixtures, 'editor-driver.ts')] });
      terminals.push(terminal); await terminal.ready();
      const draft = 'EDITOR_FIRST\n  EDITOR_SECOND 界é\n> literal';
      terminal.send('\x1b[200~' + draft + '\x1b[201~'); await terminal.settle();
      let dump = await observe(terminal, 'draft'); await check(dump, 'EDITOR_FIRST');
      assert.equal(dump.after.expanded, draft);
      const identity = dump.identity;
      dump = await observe(terminal, 'off', 'off'); assert.equal(dump.identity, identity);
      assert.ok(dump.rows.some(row => plain(row).includes('─')));
      dump = await observe(terminal, 'on', 'on'); assert.equal(dump.identity, identity); await check(dump, 'EDITOR_FIRST');
      dump = await observe(terminal, 'light', 'light'); await check(dump, 'EDITOR_FIRST');
      dump = await observe(terminal, 'dark', 'dark'); await check(dump, 'EDITOR_FIRST');
      for (const width of [60, 24, 100]) {
        await terminal.resize(width); dump = await observe(terminal, `width-${width}`);
        assert.equal(dump.after.expanded, draft); await check(dump, 'EDITOR_FIRST');
      }
      if (mode === 'fullscreen') {
        const y = dump.screen.findIndex(row => row.includes('EDITOR_FIRST'));
        await sgrAt(terminal, 3, y); dump = await observe(terminal, 'click-start');
        assert.deepEqual(dump.after.cursor, { line: 0, col: 0 });
        terminal.send('Z'); await terminal.settle(); dump = await observe(terminal, 'insert-after-click');
        assert.equal(dump.after.expanded, 'Z' + draft);
        terminal.send('\x1f'); await terminal.settle();
      }
      terminal.send('\x1f'); await terminal.settle(); // Undo the original multiline paste.
      dump = await observe(terminal, 'undo-paste'); assert.equal(dump.after.expanded, '');
      const paste = 'LONG_EDITOR_PASTE_界é_'.repeat(100);
      terminal.send('\x1b[200~' + paste + '\x1b[201~'); await terminal.settle();
      dump = await observe(terminal, 'large-paste'); assert.match(dump.after.text, /\[paste #/u);
      assert.equal(dump.after.expanded, paste);
      for (const action of ['off', 'on']) {
        dump = await observe(terminal, `large-${action}`, action);
        assert.equal(dump.identity, identity); assert.equal(dump.after.expanded, paste);
      }
      terminal.send('\x1f'); await terminal.settle();
      terminal.send('/tidy-ui-d'); await terminal.settle(); dump = await observe(terminal, 'menu');
      assert.equal(dump.menu, true); assert.equal(dump.after.text, '/tidy-ui-d');
      const menu = dump.screen.findIndex(row => row.includes('tidy-ui-dump') && !row.includes('/tidy-ui-d'));
      assert.ok(menu >= 0, 'native command menu remains visible below the panel');
      assert.equal(dump.cells[menu].some(cell => cell.text === '┃'), false, 'autocomplete is not framed as editor text');
      terminal.send('\t'); await terminal.settle(); dump = await observe(terminal, 'completed');
      assert.match(dump.after.text, /^\/tidy-ui-dump/u);
      await terminal.clearDraft();
      await terminal.command('/reload'); await terminal.event('start', 2);
      terminal.send('EDITOR_RELOAD'); await terminal.settle(); dump = await observe(terminal, 'reload');
      await check(dump, 'EDITOR_RELOAD');
      await terminal.clearDraft();
      const fullWidth = dump.width;
      const full = 'EDITOR_FULL_' + 'x'.repeat(fullWidth - 5 - 'EDITOR_FULL_'.length);
      terminal.send(full); await terminal.settle(); dump = await observe(terminal, 'full-line');
      await check(dump, 'EDITOR_FULL_');
      const fullY = dump.screen.findIndex(row => row.includes('EDITOR_FULL_'));
      assert.equal(dump.cells[fullY][fullWidth - 2].inverse, true, 'end cursor consumes internal right padding only');
      assert.equal(dump.cells[fullY][fullWidth - 1].inverse, false, 'exterior margin is never inverted');
      for (const cell of dump.cells[fullY + 1]) assert.equal(cell.inverse, false, 'bottom padding is never inverted');
      await terminal.clearDraft();
      await terminal.run('user-card'); const final = await terminal.capture('editor-transcript');
      assert.equal(final.tools.length, 2); assert.equal(final.tools[0].name, 'bash');
      const user = final.branch.filter(entry => entry.type === 'message' && entry.message.role === 'user').at(-1);
      assert.deepEqual(user.message.content, [{ type: 'text', text: 'run user-card' }]);
    }
  } finally { await closeTerminals(terminals); }
});

test('belowEditor metadata and separate native status preserve physical half-block paint, menus and active lifecycle', {}, async () => {
  const terminals = [];
  const observe = async (terminal, name, action = 'snapshot') => {
    writeFileSync(join(terminal.output, 'editor-request.json'), JSON.stringify({ name, action }));
    terminal.send('\x1b\x04');
    if (action === 'on' || action === 'off') await terminal.appearance(action === 'on', { alreadyOpen: true });
    const dump = await terminal.waitForProgress(() => {
      terminal.health();
      try { return JSON.parse(readFileSync(join(terminal.output, `${name}.json`), 'utf8')); }
      catch (error) { if (error.code === 'ENOENT' || error instanceof SyntaxError) return false; throw error; }
    }, `belowEditor ${name}`);
    await terminal.settle(); terminal.session = dump.session;
    assert.deepEqual(dump.after, dump.before, 'status actions never rewrite drafts');
    return terminal.captureScreen(name, dump);
  };
  const nativeActivity = (dump, inputY) => {
    assert.equal(dump.embedWorkingStatus, false, 'Pi selects its native separate status container');
    assert.equal(dump.embeddedStatusPresent, false);
    assert.match(dump.nativeStatusRows.map(plain).join('\n'), /Working A─B ───/u, 'native component owns literal message output');
    assert.ok(!dump.rows.map(plain).join('\n').includes('Working'));
    assert.ok(!dump.statusRows.map(plain).join('\n').includes('Working'));
    const matches = dump.screen.map((row, index) => row.includes('Working A─B ───') ? index : -1).filter(index => index >= 0);
    assert.equal(matches.length, 1, 'one physical native status, no duplicate in input or metadata');
    assert.ok(matches[0] < inputY, 'native status physically precedes the input');
    return matches[0];
  };
  const hidden = (dump) => {
    assert.equal(dump.menu, true, 'native public getter confirms an open autocomplete menu');
    assert.deepEqual(dump.statusRows, [], 'both belowEditor rows disappear during autocomplete');
    assert.ok(!dump.screen.some(row => row.includes('╹▀')), 'half-block edge is physically absent');
    const inputY = dump.screen.findIndex(row => row.includes('/tidy-ui-d'));
    assert.ok(inputY >= 1);
    if (dump.statusPresent) nativeActivity(dump, inputY - 1);
    else assert.ok(!dump.screen.some(row => row.includes('Working A─B ───')));
    const nativeRows = editorPaint(dump.rows).map(plain);
    assert.deepEqual(dump.screen.slice(inputY - 1, inputY - 1 + nativeRows.length).map(row => row.trimEnd()), nativeRows,
      'native editor and menu occupy their unchanged contiguous rows');
    assert.deepEqual(dump.screen.slice(inputY - 1 + nativeRows.length, inputY - 1 + nativeRows.length + dump.footerRows.length).map(row => row.trimEnd()),
      dump.footerRows.map(plain), 'footer directly follows native menu with no reserved widget rows');
  };
  const check = async (dump, active = false) => {
    assert.equal(dump.menu, false, 'two widget rows return only after the menu closes');
    assert.equal(dump.statusRows.length, 2); await assertFits(dump.statusRows, dump.width);
    const edgeY = dump.screen.findIndex(row => row.includes('╹▀'));
    assert.ok(edgeY > 0, 'both widget rows physically precede the existing footer');
    const y = edgeY - 1, cells = dump.cells[y], edge = dump.cells[edgeY];
    assert.equal(cells[1].text, '┃'); assert.equal(edge[1].text, '╹');
    const panel = await referenceCell(dump.styles.background), bottom = await referenceCell(dump.styles.bottom);
    for (let x = 2; x < dump.width - 1; x++) {
      assert.equal(cells[x].bgMode, panel.bgMode); assert.equal(cells[x].bg, panel.bg);
      assert.equal(edge[x].text, '▀'); assert.equal(edge[x].fgMode, bottom.fgMode); assert.equal(edge[x].fg, bottom.fg);
      assert.equal(edge[x].bgMode, 0, 'bottom half remains terminal-default, not userMessageBg');
    }
    for (const line of [cells, edge]) for (const x of [0, 1, dump.width - 1]) assert.equal(line[x].bgMode, 0);
    if (dump.width === 100) {
      assert.ok(dump.screen[y].includes(dump.modelName), 'model.name, not its id');
       const shown = /\(([^)]+)\)/u.exec(dump.screen[y]);
       assert.ok(shown && dump.provider.startsWith(shown[1].replace(/…$/u, '')), 'literal provider ID prefix with balanced parentheses');
      assert.ok(dump.screen[y].includes(` • ${dump.thinking}`));
    }
    assert.equal(dump.screen[y].includes('Idle'), !active && dump.idle);
    const foreground = async (start, length, style, label) => {
      const reference = await referenceCell(style);
      for (let x = start; x < start + length; x++) {
        assert.equal(cells[x].fgMode, reference.fgMode, `${label}: physical foreground mode`);
        assert.equal(cells[x].fg, reference.fg, `${label}: physical foreground color`);
      }
    };
    const text = dump.screen[y];
    if (dump.width === 100) {
      await foreground(text.indexOf(dump.modelName), dump.modelName.length, dump.styles.model, 'model mdHeading');
      const shown = /\(([^)]+)\)/u.exec(text), providerX = shown.index;
      await foreground(providerX, 1, dump.styles.separator, 'opening parenthesis dim');
      await foreground(providerX + 1, shown[1].length, dump.styles.provider, 'provider muted including ellipsis');
      await foreground(providerX + 1 + shown[1].length, 1, dump.styles.separator, 'closing parenthesis dim');
      await foreground(text.indexOf(` • ${dump.thinking}`) + 3, dump.thinking.length, dump.styles.thinking, 'native thinking role');
    }
    for (let x = 0; x < text.length; x++) if (text[x] === '•') await foreground(x, 1, dump.styles.separator, 'bullet dim');
    assert.ok(!text.includes('Working'), 'working activity never enters belowEditor metadata');
    if (text.includes('Idle')) await foreground(text.indexOf('Idle'), 4, dump.styles.idle, 'Idle muted');
    assert.equal(dump.footerOwner, 'FooterView', 'recognized stock editor keeps its pi-tidy-ui footer through metadata/autocomplete and reload');
    assert.ok(dump.footerRows.length > 0);
    assert.deepEqual(dump.screen.slice(edgeY + 1, edgeY + 1 + dump.footerRows.length).map(row => row.trimEnd()), dump.footerRows.map(plain),
      'actual managed footer rows physically follow the widget at every width');
    return active && dump.statusPresent ? nativeActivity(dump, y - dump.rows.length) : y;
  };
  try {
    for (const mode of ['fullscreen', 'regular']) {
      const terminal = new PiTerminal(`editor-status-${mode}`, { mode, agentSettings: { editorPaddingX: 1 }, extensions: [join(fixtures, 'editor-driver.ts')] });
      terminals.push(terminal); await terminal.ready();
      let dump = await observe(terminal, 'idle'); await check(dump);
      assert.equal(dump.modelName, 'Offline terminal fixture'); assert.equal(dump.provider, 'tidy-ui-offline');
      terminal.send('/tidy-ui-d'); await terminal.settle(); dump = await observe(terminal, 'menu');
      hidden(dump);
      const menu = dump.screen.findIndex(row => row.includes('tidy-ui-dump') && !row.includes('/tidy-ui-d'));
      assert.ok(menu >= 0, 'native autocomplete remains physically visible without widget rows');
      if (mode === 'fullscreen') {
        await sgrAt(terminal, 5, menu); dump = await observe(terminal, 'menu-click');
        assert.match(dump.after.text, /^\/tidy-ui-dump/u);
      } else { terminal.send('\t'); await terminal.settle(); }
      await terminal.clearDraft(); dump = await observe(terminal, 'menu-closed'); await check(dump);
      for (const action of ['light', 'dark']) { dump = await observe(terminal, action, action); await check(dump); }
      for (const width of [24, 60, 100]) { await terminal.resize(width); dump = await observe(terminal, `width-${width}`); await check(dump); }
      dump = await observe(terminal, 'thinking', 'thinking-off'); assert.equal(dump.thinking, 'off'); await check(dump);
      terminal.send('run pending\r'); await terminal.event('provider_gate');
      dump = await observe(terminal, 'working-message', 'working-message'); let workY = await check(dump, true);
      assert.ok(dump.screen[workY].includes('Working A─B ───'), 'literal frame-like message glyphs survive');
      assert.ok(!dump.rows.map(plain).join('\n').includes('Working'), 'status is absent from input rows');
      const identity = dump.statusIdentity; assert.ok(identity);
      terminal.send('/tidy-ui-d'); await terminal.settle(); dump = await observe(terminal, 'busy-menu'); hidden(dump);
      assert.equal(dump.statusIdentity, identity, 'autocomplete hiding retains the same native indicator');
      dump = await observe(terminal, 'busy-menu-off', 'off'); assert.equal(dump.statusIdentity, identity);
      dump = await observe(terminal, 'busy-menu-on', 'on'); hidden(dump); assert.equal(dump.statusIdentity, identity);
      terminal.send('\x1b'); await terminal.settle(); dump = await observe(terminal, 'busy-menu-escape');
      await check(dump, true); assert.equal(dump.after.text, '/tidy-ui-d', 'Escape closes the menu without rewriting the draft');
      assert.equal(dump.statusIdentity, identity, 'same Working reappears after Escape');
      terminal.send('\x15'); await terminal.settle(); dump = await observe(terminal, 'busy-draft-cleared'); await check(dump, true);
      assert.equal(dump.after.text, '', 'native line deletion clears only the draft, not the running request');
      const phases = new Set();
      for (let i = 0; i < 3; i++) {
        await terminal.observeAnimation();
        dump = await observe(terminal, `phase-${i}`); workY = await check(dump, true);
        phases.add(dump.screen[workY].trim().slice(0, 1));
        assert.equal(dump.statusIdentity, identity, 'the existing host-owned object is preserved');
      }
      assert.ok(phases.size >= 2, 'native animation moves on the physical screen');
      dump = await observe(terminal, 'active-off', 'off'); assert.deepEqual(dump.statusRows, []);
      assert.equal(dump.statusIdentity, identity); assert.ok(dump.rows.map(plain).join('\n').includes('Working A─B ───'));
      dump = await observe(terminal, 'active-on', 'on'); await check(dump, true); assert.equal(dump.statusIdentity, identity);
      dump = await observe(terminal, 'busy-hidden', 'working-hide');
      workY = await check(dump, true); assert.equal(dump.idle, false);
      assert.ok(!dump.screen[workY].includes('Working')); assert.ok(!dump.screen[workY].includes('Idle'));
      dump = await observe(terminal, 'busy-shown', 'working-show'); await check(dump, true);
      writeFileSync(join(terminal.output, 'provider-go'), 'go'); await terminal.event('tool_gate');
      writeFileSync(join(terminal.output, 'tool-go'), 'go'); await terminal.event('agent_end');
      dump = await observe(terminal, 'complete'); await check(dump); assert.equal(dump.statusIdentity, undefined);
      const complete = await terminal.capture('status-traffic'); assert.equal(complete.tools.length, 2);
      await terminal.command('/reload'); await terminal.event('start', 2);
      dump = await observe(terminal, 'reload'); await check(dump);
      const native = new PiTerminal(`editor-status-native-${mode}`, { mode, workspace: terminal.work });
      terminals.push(native); await native.ready(); native.send('run pending\r'); await native.event('provider_gate');
      writeFileSync(join(native.output, 'provider-go'), 'go'); await native.event('tool_gate');
      writeFileSync(join(native.output, 'tool-go'), 'go'); await native.event('agent_end');
      await native.capture('native-complete'); assert.deepEqual(traffic(terminal, 2), traffic(native, 2), 'native model calls/results unchanged');
      const heightControls = [];
      for (const height of [16, 6]) {
        await terminal.resize(100, height); await native.resize(100, height);
        const projected = await observe(terminal, `height-${height}`), stock = await native.capture(`height-${height}`);
        assert.equal(projected.rows.length, stock.editor.lines.length, 'height pressure does not add editor-local rows');
        assert.equal(projected.rows.filter(row => row.includes('\x1b_pi:c')).length, 1, 'native cursor marker retained under height pressure');
        assert.equal(projected.after.text, '', 'height pressure never changes the native draft');
        if (height === 16) await check(projected);
        heightControls.push({ height, nativeEditorRows: stock.editor.lines.length, projectedEditorRows: projected.rows.length,
          physicalStatusVisible: projected.screen.some(row => row.includes('Idle')), physicalHalfBlockVisible: projected.screen.some(row => row.includes('╹▀')) });
      }
      writeFileSync(join(terminal.output, 'height-controls.json'), JSON.stringify(heightControls, null, 2));
      await terminal.resize(100); dump = await observe(terminal, 'height-restored'); await check(dump);
      assert.deepEqual(traffic(terminal, 2), traffic(native, 2), 'height controls add no calls/results/model contexts');
      const replay = new PiTerminal(`editor-status-replay-${mode}`, { mode, session: terminal.session, workspace: terminal.work, agentSettings: { editorPaddingX: 1 },
        extensions: [join(fixtures, 'editor-driver.ts')] });
      terminals.push(replay); await replay.ready(); const replayDump = await observe(replay, 'replay'); await check(replayDump);
      const replayTraffic = await replay.capture('replay-traffic');
      assert.deepEqual(replayTraffic.branch, complete.branch, 'presentation adds no persisted/model content');
    }
  } finally { await closeTerminals(terminals); }
});

test('belowEditor clipping leaves activity in Pi separate container without changing native Working ownership', {}, async () => {
  const terminal = new PiTerminal('editor-status-height-four', { mode: 'fullscreen', agentSettings: { editorPaddingX: 1 },
    extraEnv: { TIDY_UI_TEST_MENU_GEOMETRY: '1' }, extensions: [join(fixtures, 'editor-driver.ts')] });
  const observe = async (name, action) => {
    writeFileSync(join(terminal.output, 'editor-request.json'), JSON.stringify({ name, action })); terminal.send('\x1b\x04');
    if (action === 'on' || action === 'off') await terminal.appearance(action === 'on', { alreadyOpen: true });
    const dump = await terminal.waitForProgress(() => {
      terminal.health();
      try { return JSON.parse(readFileSync(join(terminal.output, `${name}.json`), 'utf8')); }
      catch (error) { if (error.code === 'ENOENT' || error instanceof SyntaxError) return false; throw error; }
    }, `four-row ${name}`);
    await terminal.settle(); terminal.session = dump.session;
    assert.deepEqual(dump.after, dump.before);
    return terminal.captureScreen(name, dump);
  };
  try {
    await terminal.ready(); terminal.send('run pending\r'); await terminal.event('provider_gate');
    await terminal.resize(100, 4);
    const native = await observe('native-four', 'off');
    assert.ok(native.screen.some(row => row.includes('Working')), 'same active host indicator is visible in native editor at four rows');
    const projected = await observe('tidy-ui-four', 'on');
    assert.equal(projected.statusIdentity, native.statusIdentity, 'no status replacement or restart');
    writeFileSync(join(terminal.output, 'height-counter.json'), JSON.stringify({ height: 4,
      nativeStatusVisible: native.screen.some(row => row.includes('Working')),
      tidyUiStatusVisible: projected.screen.some(row => row.includes('Working')),
      sameNativeIndicator: projected.statusIdentity === native.statusIdentity }, null, 2));
    assert.equal(projected.embedWorkingStatus, false);
    assert.equal(projected.embeddedStatusPresent, false);
    assert.ok(projected.nativeStatusRows.some(row => plain(row).includes('Working')), 'native activity remains in its own container');
    assert.ok(!projected.statusRows.some(row => plain(row).includes('Working')), 'widget clipping is not activity projection');
    assert.equal(projected.statusRows.length, 2, 'component still supplies both rows; native parent allocation clips them');
    assert.equal(projected.tidyUiRenderOverride, true, 'height pressure does not disable pi-tidy-ui or introduce a height heuristic');
    assert.equal(projected.statusPresent, true, 'clipping never clears the native indicator');
    await terminal.resize(100, 80);
    const restored = await observe('height-restored');
    assert.equal(restored.statusIdentity, native.statusIdentity, 'resize recovery keeps the original native object');
    assert.ok(restored.screen.some(row => row.includes('Working')), 'status returns through normal native rendering when space returns');
  } finally { await closeTerminals([terminal]); }
});

test('editor padding settings move the complete input panel live in both terminal modes', {}, async () => {
  const terminals = [];
  const observe = async (terminal, name) => {
    writeFileSync(join(terminal.output, 'editor-request.json'), JSON.stringify({ name }));
    terminal.send('\x1b\x04');
    const dump = await terminal.waitForProgress(() => {
      terminal.health();
      try { return JSON.parse(readFileSync(join(terminal.output, `${name}.json`), 'utf8')); }
      catch (error) { if (error.code === 'ENOENT' || error instanceof SyntaxError) return false; throw error; }
    }, `padding ${name}`);
    await terminal.settle(); terminal.session = dump.session;
    assert.deepEqual(dump.after, dump.before, 'padding observation preserves native draft/cursor');
    return terminal.captureScreen(name, dump);
  };
  try {
    for (const mode of ['fullscreen', 'regular']) {
      const terminal = new PiTerminal(`editor-padding-${mode}`, { mode, extensions: [join(fixtures, 'editor-driver.ts')] });
      terminals.push(terminal); await terminal.ready();
      const initial = await observe(terminal, 'initial'); assert.equal(initial.padding, 0, 'native default tested without overrides');
      const identity = initial.identity;
      for (const [cycle, padding] of [0, 1, 2, 3, 0].entries()) {
        if (cycle > 0) {
          await terminal.command('/settings'); terminal.send('Editor padding'); await terminal.settle();
          terminal.send('\r'); await terminal.settle();
          assert.ok(terminal.screen().some(row => new RegExp(`^\\s*→ Editor padding\\s+${padding}\\s*$`, 'u').test(row)), 'native settings cycles selected value');
          terminal.send('\x1b'); await terminal.settle();
          const persisted = JSON.parse(readFileSync(join(terminal.agent, 'settings.json'), 'utf8'));
          assert.equal(persisted.editorPaddingX, padding, 'native setting persisted without pi-tidy-ui writing settings');
        }
        for (const width of [24, 100]) {
          await terminal.resize(width);
          const content = 'PAD_TEXT_' + 'x'.repeat(width - 2 * padding - 3 - 'PAD_TEXT_'.length);
          terminal.send(content); await terminal.settle();
          const dump = await observe(terminal, `padding-${padding}-${width}-${terminals.length}-${cycle}`);
          assert.equal(dump.padding, padding); assert.equal(dump.identity, identity);
          assert.equal(dump.after.text, content); assert.equal(dump.statusRows.length, 2);
          const y = dump.screen.findIndex(row => row.includes('PAD_TEXT_'));
          const edgeY = dump.screen.findIndex(row => row.includes('╹▀'));
          assert.ok(y > 0 && edgeY > y);
          const background = await referenceCell(dump.styles.background), stripe = await referenceCell(dump.styles.border), bottom = await referenceCell(dump.styles.bottom);
          for (const line of [dump.cells[y], dump.cells[edgeY - 1]]) {
            assert.equal(line[padding].text, '┃'); assert.equal(line[padding].fg, stripe.fg);
            assert.equal(line[padding].bgMode, 0); assert.equal(line[padding + 1].text, ' ');
            for (let x = padding + 1; x < width - padding; x++) {
              assert.equal(line[x].bgMode, background.bgMode); assert.equal(line[x].bg, background.bg);
            }
          }
          assert.equal(dump.cells[y][width - padding - 1].inverse, true, 'end cursor occupies fixed internal right gap');
          for (const line of [dump.cells[y], dump.cells[edgeY - 1], dump.cells[edgeY]]) {
            for (let x = 0; x < width; x++) if (x < padding || x >= width - padding) {
              assert.equal(line[x].text, ' '); assert.equal(line[x].bgMode, 0); assert.equal(line[x].inverse, false);
            }
          }
          assert.equal(dump.cells[edgeY][padding].text, '╹');
          for (let x = padding + 1; x < width - padding; x++) {
            const cell = dump.cells[edgeY][x]; assert.equal(cell.text, '▀'); assert.equal(cell.bgMode, 0);
            assert.equal(cell.fgMode, bottom.fgMode); assert.equal(cell.fg, bottom.fg);
          }
          await assertFits([...dump.rows, ...dump.statusRows], width);
          if (mode === 'fullscreen') {
            await sgrAt(terminal, padding + 2, y);
            const click = await observe(terminal, `click-${padding}-${width}-${cycle}`);
            assert.deepEqual(click.after.cursor, { line: 0, col: 0 }); assert.equal(click.after.text, content);
          }
          await terminal.clearDraft();
        }
        terminal.send('/tidy-ui-d'); await terminal.settle();
        const menu = await observe(terminal, `menu-${padding}-${cycle}`);
        assert.equal(menu.menu, true); assert.deepEqual(menu.statusRows, []);
        const menuRow = menu.rows.find(row => plain(row).includes('tidy-ui-dump'));
        assert.ok(menuRow); assert.equal(plain(menuRow).search(/\S/u), padding + 2, 'native menu follows input text origin');
        assert.ok(!menu.screen.some(row => row.includes('╹▀')), 'edge remains hidden during autocomplete');
        terminal.send('\x1b'); await terminal.settle(); await terminal.clearDraft();
      }
      assert.equal(terminal.events().filter(event => event.type === 'start').length, 1, 'all geometry changes happen without reload');
      assert.equal(terminal.events().filter(event => event.type === 'tool_call' || event.type === 'context').length, 0, 'settings/drafts never become model traffic');
    }
  } finally { await closeTerminals(terminals); }
});

test('aboveEditor widget separator stays immediately before input and follows zero height in real native layouts', {}, async () => {
  const terminals = [];
  const observe = async (terminal, name, action = 'snapshot') => {
    writeFileSync(join(terminal.output, 'editor-request.json'), JSON.stringify({ name, action }));
    terminal.send('\x1b\x04');
    if (action === 'on' || action === 'off') await terminal.appearance(action === 'on', { alreadyOpen: true });
    const dump = await terminal.waitForProgress(() => {
      terminal.health();
      try { return JSON.parse(readFileSync(join(terminal.output, `${name}.json`), 'utf8')); }
      catch (error) { if (error.code === 'ENOENT' || error instanceof SyntaxError) return false; throw error; }
    }, `widget gap ${name}`);
    await terminal.settle(); terminal.session = dump.session;
    assert.deepEqual(dump.after, dump.before, 'widget controls preserve the actual draft and native cursor');
    assert.equal(dump.exactStockPrototype, true); assert.equal(dump.inputMethodUnchanged, true);
    assert.equal(dump.widgetCallsAfterEditor, dump.widgetCallsBeforeEditor, 'editor spacing never rerenders the foreign widget');
    return terminal.captureScreen(name, dump);
  };
  const change = async (terminal, name, action) => {
    // The action requests an ordinary native frame; inspect after that frame, not
    // an action-time manual editor render before its upper sibling has rendered.
    await observe(terminal, `${name}-action`, action);
    return observe(terminal, name);
  };
  const gap = async (dump, lastWidget, needle = 'WIDGET_INPUT_') => {
    assert.equal(dump.rows[0], '', 'SDK layout guard must activate: silently dropping the feature is a failing compatibility test');
    assert.ok(plain(dump.rows[1]).includes('┃'));
    const widgetY = dump.screen.findIndex(row => row.includes(lastWidget));
    const textY = dump.screen.findIndex(row => row.includes(needle));
    assert.ok(widgetY >= 0 && textY >= 0);
    assert.equal(textY, widgetY + 3, 'last widget, exterior empty row, existing panel padding, then input text');
    assert.equal(dump.cells[widgetY + 2][dump.padding].text, '┃', 'inside panel padding remains intact');
    for (const cell of dump.cells[widgetY + 1]) {
      assert.equal(cell.text.trim(), ''); assert.equal(cell.fgMode, 0); assert.equal(cell.bgMode, 0);
      assert.equal(cell.inverse, false); assert.equal(!!cell.bold, false);
    }
    const marker = dump.rows.find(row => row.includes('\x1b_pi:c\x07'));
    assert.ok(marker); assert.equal(dump.rows.filter(row => row.includes('\x1b_pi:c\x07')).length, 1);
    await assertFits([...dump.rows, ...dump.statusRows], dump.width);
  };
  const noGap = dump => {
    assert.notEqual(dump.rows[0], '', 'no additional editor-local empty row');
    assert.ok(plain(dump.rows[0]).includes('┃'));
    assert.ok(!dump.screen.some(row => /UPPER_WIDGET_A|LAST_UPPER_WIDGET_B/u.test(row)));
  };
  try {
    for (const mode of ['fullscreen', 'regular']) {
      const terminal = new PiTerminal(`editor-widget-gap-${mode}`, { mode, agentSettings: { editorPaddingX: 1 }, extensions: [join(fixtures, 'editor-driver.ts')] });
      terminals.push(terminal); await terminal.ready();
      const draft = 'WIDGET_INPUT_界é\n  SECOND_WIDGET_LINE';
      terminal.send('\x1b[200~' + draft + '\x1b[201~'); await terminal.settle();
      const baseline = await observe(terminal, 'absent'); noGap(baseline);
      const identity = baseline.identity;
      let dump = await change(terminal, 'lower-only', 'widget-lower'); noGap(dump);
      assert.equal(dump.rows.length, baseline.rows.length); assert.equal(dump.statusRows.length, 2);
      assert.ok(dump.screen.some(row => row.includes('LOWER_ONLY_WIDGET')));
      dump = await change(terminal, 'lower-removed', 'widget-lower-remove'); noGap(dump);
      dump = await change(terminal, 'registered-zero', 'widget-zero'); noGap(dump);
      assert.equal(dump.upperRegistered, true); assert.deepEqual(dump.upperRows, []);
      dump = await change(terminal, 'visible', 'widget-visible'); await gap(dump, 'UPPER_WIDGET_A');
      assert.equal(dump.rows.length, baseline.rows.length + 1); assert.equal(dump.identity, identity);
      assert.equal(dump.after.expanded, draft); assert.ok(dump.widgetCallsBeforeEditor > 0);
      dump = await change(terminal, 'later-widget', 'widget-extra'); await gap(dump, 'LAST_UPPER_WIDGET_B');
      assert.equal(dump.rows.length, baseline.rows.length + 1, 'one gap for the whole group, not one per widget');
      dump = await change(terminal, 'one-zero', 'widget-zero'); await gap(dump, 'LAST_UPPER_WIDGET_B');
      dump = await change(terminal, 'all-zero', 'widget-extra-remove'); noGap(dump);
      assert.equal(dump.rows.length, baseline.rows.length);
      dump = await change(terminal, 'removed', 'widget-remove'); noGap(dump);
      dump = await change(terminal, 'visible-again', 'widget-visible'); await gap(dump, 'UPPER_WIDGET_A');
      for (const action of ['light', 'dark']) { dump = await observe(terminal, action, action); await gap(dump, 'UPPER_WIDGET_A'); }
      for (const width of [24, 60, 100]) { await terminal.resize(width); dump = await observe(terminal, `width-${width}`); await gap(dump, 'UPPER_WIDGET_A'); }
      if (mode === 'fullscreen') {
        const widgetY = dump.screen.findIndex(row => row.includes('UPPER_WIDGET_A'));
        const cursor = dump.after.cursor;
        await sgrAt(terminal, 3, widgetY + 1); dump = await observe(terminal, 'gap-click');
        assert.deepEqual(dump.after.cursor, cursor, 'blank separator is not an input target');
        const textY = dump.screen.findIndex(row => row.includes('WIDGET_INPUT_'));
        await sgrAt(terminal, 3, textY); dump = await observe(terminal, 'input-click');
        assert.deepEqual(dump.after.cursor, { line: 0, col: 0 }, 'native y mapping compensates for the external prefix');
      }
      dump = await observe(terminal, 'off', 'off'); assert.notEqual(dump.rows[0], '');
      assert.ok(dump.rows.some(row => plain(row).includes('─')));
      dump = await observe(terminal, 'on', 'on'); await gap(dump, 'UPPER_WIDGET_A'); assert.equal(dump.identity, identity);
      await terminal.clearDraft(); terminal.send('/tidy-ui-d'); await terminal.settle();
      dump = await observe(terminal, 'menu'); assert.equal(dump.rows[0], ''); assert.deepEqual(dump.statusRows, []);
      const menuY = dump.screen.findIndex(row => row.includes('tidy-ui-dump') && !row.includes('/tidy-ui-d'));
      assert.ok(menuY >= 0);
      if (mode === 'fullscreen') { await sgrAt(terminal, 3, menuY); dump = await observe(terminal, 'menu-click'); assert.match(dump.after.text, /^\/tidy-ui-dump/u); }
      else { terminal.send('\t'); await terminal.settle(); }
      await terminal.clearDraft();
      assert.equal(terminal.events().filter(event => ['call', 'result', 'model_context'].includes(event.type)).length, 0, 'draft and widgets produce no model/tool traffic');
      await terminal.run('user-card'); const live = await terminal.capture('live-traffic');
      assert.equal(live.tools.length, 2); const bytes = readFileSync(live.session);
      const native = new PiTerminal(`editor-widget-gap-native-${mode}`, { mode, workspace: terminal.work, agentSettings: { editorPaddingX: 1 } });
      terminals.push(native); await native.ready(); await native.run('user-card'); await native.capture('native-traffic');
      assert.deepEqual(traffic(terminal, 2), traffic(native, 2), 'same two real calls/results and three provider contexts remain exact');
      const opposite = mode === 'fullscreen' ? 'regular' : 'fullscreen';
      await terminal.command('/settings'); terminal.send('TUI mode'); await terminal.settle();
      assert.ok(terminal.screen().some(row => new RegExp(`^\\s*→ TUI mode\\s+${mode}\\s*$`, 'u').test(row)));
      terminal.send('\r'); await terminal.settle(); terminal.send('\x1b'); await terminal.settle();
      assert.equal(terminal.term.buffer.active.type, opposite === 'fullscreen' ? 'alternate' : 'normal');
      terminal.send('WIDGET_INPUT_MODE'); await terminal.settle(); dump = await observe(terminal, 'mode-replaced');
      await gap(dump, 'UPPER_WIDGET_A'); assert.equal(dump.identity, identity);
      await terminal.clearDraft();
      await terminal.command('/reload'); await terminal.event('start', 2);
      terminal.send('WIDGET_INPUT_RELOAD'); await terminal.settle(); dump = await observe(terminal, 'reload-absent'); noGap(dump);
      dump = await change(terminal, 'reload-visible', 'widget-visible'); await gap(dump, 'UPPER_WIDGET_A');
      await terminal.clearDraft();
      assert.deepEqual(readFileSync(live.session), bytes, 'widgets and renderer/reload controls never rewrite stored traffic');
      assert.deepEqual(traffic(terminal, 2), traffic(native, 2));
      const replay = new PiTerminal(`editor-widget-gap-replay-${mode}`, { mode, session: live.session, workspace: terminal.work,
        agentSettings: { editorPaddingX: 1 }, extensions: [join(fixtures, 'editor-driver.ts')] });
      terminals.push(replay); await replay.ready();
      dump = await observe(replay, 'replay-absent'); noGap(dump);
      replay.send('WIDGET_INPUT_REPLAY'); await replay.settle(); dump = await change(replay, 'replay-visible', 'widget-visible'); await gap(dump, 'UPPER_WIDGET_A');
      await replay.clearDraft();
      const replayDump = await replay.capture('replay-traffic');
      assert.deepEqual(replayDump.branch, live.branch); assert.deepEqual(readFileSync(live.session), bytes);
      assert.equal(replay.events().filter(event => ['call', 'result', 'model_context'].includes(event.type)).length, 0, 'replay executes no new tools or model requests');
      writeFileSync(join(terminal.output, 'widget-gap-controls.json'), JSON.stringify({ mode, toolCalls: 2, toolResults: 2, providerContexts: 3,
        absent: baseline.rows.length, withUpperWidget: baseline.rows.length + 1, sameDraftEditor: identity, replayExecuted: 0 }, null, 2));
    }
  } finally { await closeTerminals(terminals); }
});

test('foreign editor extension retains native input, widgets, mouse and replay in both load orders', { timeout: 240000 }, async () => {
  const terminals = [], coverage = [], workspace = mkdtempSync(join(tmpdir(), 'tidy-ui-foreign-work-'));
  const ownerExtension = join(fixtures, 'foreign-editor.ts');
  const observe = async (terminal, name, action = 'snapshot') => {
    writeFileSync(join(terminal.output, 'foreign-request.json'), JSON.stringify({ name, action }));
    terminal.send('\x1b\x04');
    const dump = await terminal.waitForProgress(() => {
      terminal.health();
      try { return JSON.parse(readFileSync(join(terminal.output, `${name}.json`), 'utf8')); }
      catch (error) { if (error.code === 'ENOENT' || error instanceof SyntaxError) return false; throw error; }
    }, `foreign editor ${name}`);
    await terminal.settle(); terminal.session = dump.session;
    assert.deepEqual(dump.after, dump.before, 'observation, themes and empty-draft takeover do not exchange draft data');
    const buffer = terminal.term.buffer.active;
    return terminal.captureScreen(name, { ...dump, hardware: { x: buffer.cursorX, y: buffer.baseY + buffer.cursorY - buffer.viewportY } });
  };
  const region = dump => {
    assert.equal(dump.factoryOwned, true, 'actual public editor factory, not a mocked nativeEditor option');
    assert.deepEqual(dump.aboveRows, ['', 'FOREIGN_UPPER_ROW']);
    assert.deepEqual(dump.belowRows, ['FOREIGN_LOWER_ROW'], 'no pi-tidy-ui metadata/edge rows, even with its widget registered');
    assert.equal(dump.padding, 2, 'foreign geometry is not converted to pi-tidy-ui exterior margins');
    assert.equal(dump.git.watchers, 0, 'foreign editor releases pi-tidy-ui Git watches');
    assert.equal(dump.git.activeJobs, 0, 'foreign editor starts no pi-tidy-ui Git work');
    if (dump.custom) assert.equal(dump.ownerMethods, true, 'foreign render, input and mouse methods retain ownership');
    assert.doesNotMatch(dump.rows.map(plain).join('\n'), /┃|╹|▀/u, 'no panel, half-block edge or injected decoration');
    assert.notEqual(dump.rows[0], '', 'no pi-tidy-ui upper-widget separator');
    const top = dump.screen.findIndex(row => row === 'FOREIGN_UPPER_ROW');
    assert.ok(top >= 0, 'real upper widget is painted');
    const rows = editorPaint(dump.rows).map(plain);
    const physical = dump.screen.slice(top + 1, top + 1 + rows.length).map(plain);
    if (!dump.idle && dump.embedWorkingStatus) {
      // Native clock ticks between the packet and the physical-screen sample.
      // Only its single top-border frame glyph is explicitly variable.
      const frame = row => row.replace(/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/u, '<native-frame>');
      rows[0] = frame(rows[0]); physical[0] = frame(physical[0]);
    }
    assert.deepEqual(physical, rows, 'foreign editor begins immediately after upper widget; no invisible inserted row');
    assert.equal(dump.screen[top + 1 + rows.length], 'FOREIGN_LOWER_ROW', 'own lower widget immediately follows editor/menu');
    return { top, cells: dump.cells.slice(top, top + rows.length + 2), rows };
  };
  const framePattern = /[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/u;
  const phaseRows = rows => rows.map(row => plain(row).includes('Working') ? row.replace(framePattern, '<native-frame>') : row);
  const phaseCells = (cells, rowIndex) => {
    const indexes = cells[rowIndex].flatMap((cell, x) => framePattern.test(cell.text) ? [x] : []);
    assert.equal(indexes.length, 1, 'exactly one identified native spinner cell');
    return cells.map((row, y) => row.map((cell, x) => y === rowIndex && x === indexes[0] ? { ...cell, text: '<native-frame>' } : cell));
  };
  const same = (native, live) => {
    const control = region(native), actual = region(live);
    assert.equal(live.idle, native.idle);
    const busy = !native.idle;
    assert.deepEqual(busy ? phaseRows(live.rows) : live.rows, busy ? phaseRows(native.rows) : native.rows,
      'complete ANSI render matches native; only its identified animation glyph may vary');
    assert.deepEqual(busy ? phaseRows(live.nativeStatusRows) : live.nativeStatusRows,
      busy ? phaseRows(native.nativeStatusRows) : native.nativeStatusRows, 'separate native status rows remain untouched');
    assert.deepEqual(busy && live.embedWorkingStatus ? phaseCells(actual.cells, 1) : actual.cells,
      busy && native.embedWorkingStatus ? phaseCells(control.cells, 1) : control.cells,
      'all physical input/widget colors and attributes match native, including the spinner cell');
    if (busy) {
      const indicatorCells = dump => {
        const row = dump.screen.findIndex(text => text.includes('Working'));
        assert.ok(row >= 0, 'native Working is physically visible');
        return phaseCells([dump.cells[row]], 0);
      };
      assert.deepEqual(indicatorCells(live), indicatorCells(native), 'physical native indicator glyph attributes remain unchanged in either placement');
    }
    assert.deepEqual({ x: live.hardware.x, y: live.hardware.y - actual.top },
      { x: native.hardware.x, y: native.hardware.y - control.top }, 'hardware cursor geometry remains native');
    assert.deepEqual(live.after, native.after, 'text, expanded paste and cursor match native');
    assert.equal(live.menu, native.menu); assert.equal(live.mode, native.mode);
    assert.equal(live.footerOwner, 'FooterComponent');
    assert.deepEqual(live.footerRows, native.footerRows, 'disabled input restores the complete native footer data/ANSI at every lifecycle phase');
    assert.deepEqual(live.mouseEvents, native.mouseEvents, 'complete foreign mouse events including absolute screen coordinates stay native with the native footer');
  };
  try {
    for (const mode of ['fullscreen', 'regular']) for (const order of ['foreign-first', 'tidy-ui-first']) {
      const prefix = `${mode}-${order}`, deferred = order === 'tidy-ui-first';
      const embedded = !deferred;
      const extraEnv = { TIDY_UI_TEST_DEFER_EDITOR: deferred ? '1' : '0', TIDY_UI_TEST_FOREIGN_EMBED: embedded ? '1' : '0' };
      const sharedWork = join(workspace, prefix); mkdirSync(sharedWork, { recursive: true });
      const native = new PiTerminal(`foreign-native-${prefix}`, { mode, workspace: sharedWork, agentSettings: { editorPaddingX: 2 }, extensions: [ownerExtension], extraEnv });
      terminals.push(native); await native.ready();
      const live = new PiTerminal(`foreign-live-${prefix}`, { mode, agentSettings: { editorPaddingX: 2 }, workspace: native.work, extraEnv,
        extensions: order === 'foreign-first' ? [ownerExtension, extension] : [extension, ownerExtension] });
      terminals.push(live); await live.ready();
      if (deferred) {
        const warm = await observe(live, 'stock-warm');
        assert.ok(warm.rows.some(row => plain(row).includes('┃')), 'production pi-tidy-ui was active before late takeover');
        assert.equal(warm.rows[0], '', 'warm upper-widget measurement exists before ownership changes');
        assert.equal(warm.footerOwner, 'FooterView', 'footer starts enabled beside the recognized stock editor');
        assert.equal(warm.belowRows.length, 3, 'both pi-tidy-ui rows existed before takeover beside the owner widget');
        await observe(native, 'install', 'install'); await observe(live, 'install', 'install');
      }
      let stock = await observe(native, 'initial'), styled = await observe(live, 'initial'); same(stock, styled);
      assert.equal(styled.custom, true); assert.equal(styled.mode, false);
      assert.equal(styled.footerOwner, 'FooterComponent', 'foreign editor disables pi-tidy-ui footer as well as input styling');
      assert.equal(stock.footerOwner, 'FooterComponent');
      const identity = styled.identity, ownerQueries = styled.git.queries;
      const pair = async (name, action = 'snapshot') => {
        stock = await observe(native, name, action); styled = await observe(live, name, action); same(stock, styled);
        assert.equal(styled.identity, identity, 'ordinary pi-tidy-ui/UI actions never replace the foreign editor');
        assert.equal(styled.git.queries, ownerQueries, 'foreign editor frames/operations do not query Git');
      };
      const send = async data => { native.send(data); live.send(data); await native.settle(); await live.settle(); };
      await send('\x1b\x18'); await pair('own-key'); assert.equal(styled.mode, true, 'extension-specific key remains effective');
      const draft = 'FOREIGN_INPUT_界é\n  FOREIGN_SECOND';
      await send('\x1b[200~' + draft + '\x1b[201~'); await pair('draft'); assert.equal(styled.after.expanded, draft);
      if (mode === 'fullscreen') {
        const clicked = new Map();
        for (const terminal of [native, live]) {
          const dump = terminal === native ? stock : styled;
          const y = dump.screen.findIndex(row => row.includes('FOREIGN_INPUT_')); clicked.set(terminal, y);
          assert.ok(y >= 0); await sgrAt(terminal, 2, y);
        }
        await pair('mouse'); assert.deepEqual(styled.after.cursor, { line: 0, col: 0 });
        assert.ok(styled.mouseEvents.length > 0, 'actual fullscreen mouse dispatch reaches the foreign override');
        for (const [terminal, dump] of [[native, stock], [live, styled]]) for (const event of dump.mouseEvents.slice(-3))
          assert.equal(event.screenY, clicked.get(terminal), 'absolute screen coordinate equals its actual physical click, not a fixed footer assumption');
        await send('Z'); await pair('insert'); assert.equal(styled.after.expanded, 'Z' + draft);
        await send('\x1f'); await pair('undo-insert'); assert.equal(styled.after.expanded, draft);
      }
      for (const width of [24, 60, 100]) {
        await native.resize(width); await live.resize(width); await pair(`width-${width}`); await assertFits(styled.rows, width);
      }
      for (const theme of ['light', 'dark']) await pair(theme, theme);
      await send('\x1f'); await pair('undo-paste'); assert.equal(styled.after.expanded, '');
      const paste = 'FOREIGN_PASTE_界é_'.repeat(100);
      await send('\x1b[200~' + paste + '\x1b[201~'); await pair('large-paste');
      assert.match(styled.after.text, /\[paste #/u); assert.equal(styled.after.expanded, paste);
      await send('\x1f'); await pair('large-undo'); assert.equal(styled.after.expanded, '');
      await send('/tidy-ui-d'); await pair('menu'); assert.equal(styled.menu, true);
      const menuClicked = new Map();
      if (mode === 'fullscreen') {
        for (const terminal of [native, live]) {
          const dump = terminal === native ? stock : styled;
          const y = dump.screen.findIndex(row => row.includes('tidy-ui-dump') && !row.includes('/tidy-ui-d')); menuClicked.set(terminal, y);
          assert.ok(y >= 0); await sgrAt(terminal, 5, y);
        }
      } else await send('\t');
      await pair('completion'); assert.match(styled.after.text, /^\/tidy-ui-dump/u);
      if (mode === 'fullscreen') for (const [terminal, dump] of [[native, stock], [live, styled]]) for (const event of dump.mouseEvents.slice(-3))
        assert.equal(event.screenY, menuClicked.get(terminal), 'autocomplete handler retains the independently measured physical click row');
      await send('\x03'); await pair('cleared');
      for (const action of ['off', 'on']) {
        await live.appearance(action === 'on'); await pair(action);
      }
      // A factory returning the exact stock class must also remain untouched.
      await observe(native, 'factory-stock', 'factory-stock'); await observe(live, 'factory-stock', 'factory-stock');
      stock = await observe(native, 'factory-stock-rows'); styled = await observe(live, 'factory-stock-rows'); same(stock, styled);
      assert.equal(styled.custom, false);
      assert.equal(styled.footerOwner, 'FooterComponent', 'even an exact stock class returned by a foreign factory keeps footer native');
      // Restore our subclass before testing native active status and history.
      await observe(native, 'owner-return', 'install'); await observe(live, 'owner-return', 'install');
      native.send('run pending\r'); live.send('run pending\r');
      await native.event('provider_gate'); await live.event('provider_gate');
      stock = await observe(native, 'working'); styled = await observe(live, 'working');
      for (const dump of [stock, styled]) {
        region(dump); assert.equal(dump.idle, false);
        const editorWorking = dump.rows.map(plain).join('\n').includes('Working');
        const separateWorking = dump.nativeStatusRows.map(plain).join('\n').includes('Working');
        assert.equal(editorWorking, embedded, 'native embedding follows the foreign factory option');
        assert.equal(separateWorking, !embedded, 'non-embedded native status retains its own container');
        assert.equal(dump.screen.filter(row => row.includes('Working')).length, 1, 'one physical native indicator, never a belowEditor duplicate');
      }
      same(stock, styled); // Includes active physical colors, spinner attributes and hardware cursor.
      for (const terminal of [native, live]) {
        writeFileSync(join(terminal.output, 'provider-go'), 'go'); await terminal.event('tool_gate');
        writeFileSync(join(terminal.output, 'tool-go'), 'go'); await terminal.event('agent_end'); await terminal.settle();
      }
      stock = await observe(native, 'completed'); styled = await observe(live, 'completed'); same(stock, styled);
      const nativeTraffic = await native.capture('foreign-native-traffic'), liveTraffic = await live.capture('foreign-live-traffic');
      assert.deepEqual(traffic(live, 2), traffic(native, 2), 'two calls/results and three model contexts remain exact');
      assert.deepEqual(persisted(liveTraffic), persisted(nativeTraffic));
      const activeTools = (dump, control) => {
        assert.equal(dump.tools.length, 2);
        const read = byName(dump, 'read')[0]; compactContent(read);
        assert.equal(summaryText(read), summaryExpected('read a.txt'), 'known pi-tidy-ui compact read presentation stays active');
        assert.doesNotMatch(lines(read).join('\n'), /READ_A_CONTENT/u, 'pi-tidy-ui read summary does not show native result body');
        assert.notDeepEqual(toolLines(dump), toolLines(control), 'only editor integration is skipped, not pi-tidy-ui tool presentation');
        assert.deepEqual(toolLines(dump), toolLines(liveTraffic), 'pi-tidy-ui layouts survive ownership/lifecycle boundaries');
      };
      activeTools(liveTraffic, nativeTraffic);
      const bytes = readFileSync(liveTraffic.session);
      for (const terminal of [native, live]) {
        await terminal.command('/reload'); await terminal.event('start', 2);
      }
      stock = await observe(native, 'reload'); styled = await observe(live, 'reload'); same(stock, styled);
      assert.equal(styled.footerOwner, 'FooterComponent');
      const nativeReload = await native.capture('foreign-native-reload-tools'), liveReload = await live.capture('foreign-live-reload-tools');
      activeTools(liveReload, nativeReload);
      assert.deepEqual(traffic(live, 2), traffic(native, 2), 'reload adds no model/tool traffic');
      assert.deepEqual(readFileSync(liveTraffic.session), bytes, 'UI reload does not change saved session bytes');
      const replayNative = new PiTerminal(`foreign-native-replay-${prefix}`, { mode, agentSettings: { editorPaddingX: 2 }, extraEnv: { TIDY_UI_TEST_FOREIGN_EMBED: embedded ? '1' : '0' }, session: liveTraffic.session, workspace: native.work, extensions: [ownerExtension] });
      const replayLive = new PiTerminal(`foreign-live-replay-${prefix}`, { mode, agentSettings: { editorPaddingX: 2 }, extraEnv: { TIDY_UI_TEST_FOREIGN_EMBED: embedded ? '1' : '0' }, session: liveTraffic.session, workspace: native.work,
        extensions: order === 'foreign-first' ? [ownerExtension, extension] : [extension, ownerExtension] });
      terminals.push(replayNative, replayLive); await replayNative.ready(); await replayLive.ready();
      const unstyled = await observe(replayNative, 'replay'), resumed = await observe(replayLive, 'replay'); same(unstyled, resumed);
      assert.equal(resumed.footerOwner, 'FooterComponent', 'saved replay keeps footer native with the foreign editor');
      const nativeReplay = await replayNative.capture('foreign-native-replay-traffic'), liveReplay = await replayLive.capture('foreign-live-replay-traffic');
      activeTools(liveReplay, nativeReplay);
      for (const [terminal, dump] of [[replayNative, nativeReplay], [replayLive, liveReplay]]) {
        assert.deepEqual(persisted(dump), persisted(liveTraffic));
        assert.equal(terminal.events().filter(event => ['call', 'result', 'model_context'].includes(event.type)).length, 0);
      }
      assert.deepEqual(readFileSync(liveTraffic.session), bytes);
      coverage.push({ mode, order, runtimeTakeover: deferred, embeddedWorking: embedded, calls: 2, results: 2, modelContexts: 3, replayNewTraffic: 0 });
      // Independent combinations must not accumulate live Pi processes and threads.
      await closeTerminals(terminals.slice().reverse());
      terminals.length = 0;
    }
    writeFileSync(join(artifacts, 'foreign-editor-coverage.json'), JSON.stringify({ installedPowerlineExecuted: false, coverage }, null, 2));
  } finally { await runCleanupSteps(() => closeTerminals(terminals.reverse()), () => rmSync(workspace, { recursive: true, force: true })); }
});
