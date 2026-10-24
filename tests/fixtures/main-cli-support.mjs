// Shared main-CLI assertions. Importing this module registers no tests.
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { stripVTControlCharacters } from 'node:util';
import xterm from '@xterm/headless';
import { editorPaint } from './editor-paint.ts';
import { visibleWidth } from '@earendil-works/pi-tui';
import { PiTerminal, root, fixtures, sleep, plain, lines, byName, until } from './terminal-harness.mjs';

const { Terminal } = xterm;

function execution(terminal) {
  const events = terminal.events();
  assert.equal(events.filter((e) => e.type === 'call').length, 7);
  assert.equal(events.filter((e) => e.type === 'result').length, 7);
  assert.equal(events.filter((e) => e.type === 'model_context').length, 8);
  return events.filter((e) => ['call', 'result', 'model_context'].includes(e.type));
}

function persisted(dump) {
  return dump.branch.filter((e) => e.type === 'message').flatMap(({ message }) => {
    if (message.role === 'toolResult') return [{ role: message.role, toolName: message.toolName,
      content: message.content, details: message.details, isError: message.isError }];
    if (message.role === 'assistant') return message.content.filter((c) => c.type === 'toolCall')
      .map(({ name, arguments: args }) => ({ name, arguments: args }));
    return [];
  });
}

const summaryText = (tool) => lines(tool).map((row) => row.slice(3)).join('').replace(/\s/gu, '');

const summaryExpected = (value) => value.replace(/\s/gu, '');

function compactContent(tool) {
  const rows = lines(tool);
  assert.ok(rows.length > 0, `compact content exists: ${tool.id}`);
  assert.equal(rows[0].slice(0, 3), tool.name === 'read' ? ' → ' : ['edit', 'write'].includes(tool.name) ? ' ← ' : ' ⚙ ', `compact prefix: ${tool.id}`);
  for (const row of rows.slice(1)) assert.match(row, /^ {3}\S/, `continuation aligns at tool-name column: ${tool.id}`);
  assert.doesNotMatch(rows.join(''), /✓|✗/u, `completion markers are disabled: ${tool.id}`);
  assert.ok(!rows.at(-1).endsWith(' '), `hidden marker leaves no trailing separator space: ${tool.id}`);
  return rows;
}

function compact(dump) {
  const reads = byName(dump, 'read');
  assert.equal(reads.length, 3);
  for (const [i, tool] of reads.entries()) {
    const rows = compactContent(tool);
    if (i < 2) assert.equal(rows.length, 1, `short read stays single-row: ${tool.id}`);
    assert.match(rows[0], /\bread\b/);
    assert.equal(summaryText(tool), summaryExpected(`read ${['a.txt', 'b.txt', 'missing.txt'][i]}${i === 0 ? ' [offset=1, limit=1]' : ''}`));
  }
  assert.doesNotMatch(summaryText(reads[2]), /ENOENT|nosuch|notfound|Error/i, 'failed summary contains call arguments, never the error body');
  const unknown = byName(dump, 'tidy_ui_unknown')[0];
  assert.equal(lines(unknown).length, 1);
  assert.equal(summaryText(unknown), summaryExpected('tidy_ui_unknown [query="wide 界 é query"]'));
  const a = dump.screen.findIndex((line) => /\bread\b.*a\.txt/.test(line));
  assert.ok(a >= 0, 'first compact read is on the real screen');
  assert.match(dump.screen[a + 1], /\bread\b.*b\.txt/, 'consecutive compact reads have no blank screen row');
  assert.doesNotMatch(dump.screen[a], /✓|✗/u);
  assert.ok(!dump.screen.some((line) => /READ_[AB]_CONTENT|UNKNOWN_RESULT/.test(line)), 'collapsed output is hidden on screen');
  // Compact summaries have no card background, including their text cells.
  for (const y of [a, a + 1]) {
    const x = dump.screen[y].indexOf('read');
    assert.equal(dump.cells[y][x].bgMode, 0, 'compact summary has terminal-default background');
  }
  const doc = dump.document.map(plain);
  const first = doc.findIndex((line) => /\bread\b.*a\.txt/.test(line));
  assert.ok(first >= 0);
  assert.match(doc[first + 1], /\bread\b.*b\.txt/);
}

async function semanticColors(dump) {
  const row = dump.screen.findIndex((line) => /\bread\b.*a\.txt/.test(line));
  assert.ok(row >= 0);
  assert.match(dump.screen[row], /read a\.txt \[offset=1, limit=1\]/);
  const customRow = dump.screen.findIndex((line) => line.includes('⚙ tidy_ui_unknown'));
  assert.ok(customRow >= 0, 'gear-prefixed unknown tool appears on the actual screen');
  assert.equal(dump.cells[customRow][1].text, '⚙');
  assert.equal(dump.cells[customRow][1].width, 1, 'gear is one terminal column, not emoji presentation');
  assert.equal(dump.screen[customRow].indexOf('tidy_ui_unknown'), 3, 'gear keeps tool-name alignment');
  const samples = [
    [row, 'dim', '→'], [row, 'toolTitle', 'read'], [row, 'muted', 'a.txt'], [row, 'dim', '[offset='],
    [customRow, 'dim', '⚙'],
  ];
  const reference = new Terminal({ cols: 10, rows: 2, allowProposedApi: true });
  try {
    for (const [sampleRow, role, text] of samples) {
      reference.reset();
      await new Promise((done) => reference.write(dump.summaryStyles[role], done));
      const expected = reference.buffer.active.getLine(0).getCell(0);
      const actual = dump.cells[sampleRow][dump.screen[sampleRow].indexOf(text)];
      assert.deepEqual({ fg: actual.fg, fgMode: actual.fgMode, dim: actual.dim },
        { fg: expected.getFgColor(), fgMode: expected.getFgColorMode(), dim: expected.isDim() },
        `real screen ${text} uses theme role ${role}`);
    }
  } finally { reference.dispose(); }
  const custom = dump.screen[customRow];
  assert.match(custom, /tidy_ui_unknown \[query="wide/);
  await errorSummaryColors(dump, byName(dump, 'read').find((tool) => tool.isError));
}

async function errorSummaryColors(dump, tool) {
  assert.equal(tool.isError, true);
  const rows = compactContent(tool);
  const y = dump.screen.findIndex((row, index) => row === rows[0] &&
    rows.every((expected, offset) => dump.screen[index + offset] === expected));
  assert.ok(y >= 0, 'complete failed compact call is present on the actual screen');
  const reference = new Terminal({ cols: 10, rows: 2, allowProposedApi: true });
  let checkedCells = 0;
  try {
    await new Promise((done) => reference.write(dump.summaryStyles.error, done));
    const sample = reference.buffer.active.getLine(0).getCell(0);
    const expected = { fg: sample.getFgColor(), fgMode: sample.getFgColorMode(), dim: sample.isDim() };
    for (let offset = 0; offset < rows.length; offset++) {
      for (const cell of dump.cells[y + offset]) {
        if (!cell.text.trim()) continue;
        assert.deepEqual({ fg: cell.fg, fgMode: cell.fgMode, dim: cell.dim }, expected,
          'every visible failure glyph/name/description/connector/parameter cell uses the active error role');
        assert.equal(cell.bgMode, 0, 'failed compact summary retains terminal-default background');
        checkedCells++;
      }
      assert.ok(['', ' '].includes(dump.cells[y + offset][dump.width - 1].text), 'failure retains one blank right column');
    }
    assert.ok(checkedCells > 0);
    return checkedCells;
  } finally { reference.dispose(); }
}

const leadingBlanks = (tool) => tool.lines.findIndex((row) => plain(row).trim());

function nativeAfterMultiline(tool, control) {
  const expected = leadingBlanks(control) === 0 ? ['', ...control.lines] : control.lines;
  assert.deepEqual(tool.lines, expected, `native ${tool.name} unchanged except missing separator`);
  assert.equal(leadingBlanks(tool), 1, `exactly one native separator: ${tool.name}`);
}

const summaryGraphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

const summarySize = (text) => [...summaryGraphemes.segment(text)].length;

function fixtureQuotedPreview(text) {
  const quoted = [...summaryGraphemes.segment(JSON.stringify(text))].map(({ segment }) => segment);
  return quoted.length <= 256 ? quoted.join('') : quoted.slice(0, 254).join('') + '…"';
}

function fixtureBoundedSummary(name, primary, parameters) {
  const title = name + (primary ? ' ' + primary : '');
  const retained = [];
  for (const [index, parameter] of parameters.entries()) {
    const candidate = [...retained, parameter, ...(index + 1 < parameters.length ? ['…'] : [])];
    if (summarySize(title + ' [' + candidate.join(', ') + ']') > 1024) { retained.push('…'); break; }
    retained.push(parameter);
  }
  return title + (retained.length ? ' [' + retained.join(', ') + ']' : '');
}

function multilineLayout(dump, wide) {
  const reads = byName(dump, 'read');
  const empty = byName(dump, 'tidy_ui_noargs');
  const summaries = byName(dump, 'tidy_ui_summary');
  assert.equal(reads.length, 4);
  assert.equal(summaries.length, 8);
  assert.equal(empty.length, 3);
  for (const hidden of byName(dump, 'tidy_ui_hidden')) assert.deepEqual(hidden.lines, [], 'hidden components have zero rows');
  for (const tool of dump.tools.filter((tool) => ['read', 'tidy_ui_noargs', 'tidy_ui_summary'].includes(tool.name))) {
    compactContent(tool);
    assert.ok(leadingBlanks(tool) <= 1, `never duplicate separator: ${tool.id}`);
    assert.ok(plain(tool.lines.at(-1)).trim(), `no trailing separator: ${tool.id}`);
    if (wide) assert.equal(summaryText(tool), summaryText(wide.tools.find((item) => item.id === tool.id)), 'every value survives narrow wrapping');
  }
  assert.equal(leadingBlanks(reads[1]), 0, 'single follows single without separator');
  assert.equal(leadingBlanks(reads[2]), 0, 'multiline following single has no separator');
  assert.ok(lines(reads[2]).length > 1, 'real long-path read wraps');
  assert.equal(leadingBlanks(empty[0]), 1, 'hidden between multiline and next is skipped');
  assert.equal(leadingBlanks(empty[1]), 0, 'leading separator does not turn prior single into multiline');
  assert.equal(leadingBlanks(summaries[0]), 0, 'multiline after single has no separator');
  assert.equal(leadingBlanks(summaries[1]), 0, 'pattern call follows single read without separator');
  assert.equal(summaryText(empty[0]), summaryExpected('tidy_ui_noargs'), 'no invented no-args placeholder');
  assert.equal(summaryText(reads[2]), summaryExpected('read long-directory/' + 'r'.repeat(180) + '.txt [offset=1, limit=1]'));
  const query = 'quoted "query"\\value 界 é ' + 'UNBREAKABLE'.repeat(30) + ' END_QUERY_VISIBLE';
  const parameters = [
    'op="trace"', 'action="inspect"', 'command="command"', `query=${fixtureQuotedPreview(query)}`, 'queries=["first","second"]', 'subject="subject"',
    'symbol="symbol"', 'symbols=["one","two"]', 'startLine=0', 'endLine=0', 'offset=0', 'limit=0', 'maxTokens=0',
    'AFirst="FIRST_ALPHA_VISIBLE"', 'Authorization="<redacted>"', 'Content="CASE_SENSITIVE_PAYLOAD_VISIBLE"', 'Token="CASE_SENSITIVE_TOKEN_VISIBLE"',
    'access_token="<redacted>"', 'apiKey="<redacted>"', 'api_key="<redacted>"', 'authorization="<redacted>"', 'count=0', 'empty=""', 'enabled=false',
    'nested={"input":"NESTED_PAYLOAD_VISIBLE","token":"NESTED_TOKEN_VISIBLE","values":[false,0,"nested quoted value"],"clean":"clean nestedvalue"}',
    'nothing=null', '"odd key"="QUOTED_KEY"', 'passwd="<redacted>"', 'password="<redacted>"', 'refresh_token="<redacted>"', 'sanitized="white space redend"', 'secret="<redacted>"', 'token="<redacted>"', 'zLast="LAST_FIELD_VISIBLE"',
    'content="PAYLOAD_CONTENT_HIDDEN"', 'edits=["PAYLOAD_EDITS_HIDDEN"]', 'code="PAYLOAD_CODE_HIDDEN"', 'input="PAYLOAD_INPUT_HIDDEN"',
    'messages=["PAYLOAD_MESSAGES_HIDDEN"]', 'prompt="PAYLOAD_PROMPT_HIDDEN"', 'newString="PAYLOAD_NEWSTRING_HIDDEN"', 'oldString="PAYLOAD_OLDSTRING_HIDDEN"',
    'appendContent="PAYLOAD_APPEND_HIDDEN"', 'rewrite="PAYLOAD_REWRITE_HIDDEN"', 'oldText="PAYLOAD_OLDTEXT_HIDDEN"', 'newText="PAYLOAD_NEWTEXT_HIDDEN"',
  ];
  assert.equal(summaryText(summaries[0]), summaryExpected(fixtureBoundedSummary('tidy_ui_summary', '', parameters)), 'action-first/alpha/content ordering, capped values, overall budget and exact masking');
  assert.doesNotMatch(summaries[0].lines.join(''), /\u202e|\u001b\[31m/u, 'top-level and nested controls cannot affect terminal presentation');
  assert.ok(lines(summaries[0]).length > (dump.width === 24 ? 30 : 4), 'bounded logical text still wraps normally rather than acquiring a row cap');
  const expected = [
    'tidy_ui_summary "needle \\"quoted\\"" [query="always named", paths=["ordinary-path"], path=["src dir","tests"], target="ordinary-target", url="https://example.invalid/ordinary", scope="ordinary-scope", enabled=true]',
    'tidy_ui_summary "chosen target" [query="named", paths=["ordinary-path"], path=null, url="ordinary-url", scope="ordinary-scope", pattern=0]',
    'tidy_ui_summary chosen-path [paths=["ordinary-path"], target="ordinary-target", url="ordinary-url", scope="ordinary-scope"]',
    'tidy_ui_summary https://example.invalid/chosen [paths=[], scope="ordinary-scope", pattern=false]',
    'tidy_ui_summary [paths=["ordinary-path"], scope=[]]',
    'tidy_ui_summary [paths=[]]',
    'tidy_ui_summary "" [query="", path=[]]',
  ];
  for (const [index, expectedSummary] of expected.entries())
    assert.equal(summaryText(summaries[index + 1]), summaryExpected(expectedSummary), `primary selection case ${index + 1}`);
}

function bashArguments(dump) {
  return persisted(dump).filter((entry) => entry.name === 'bash').map((entry) => entry.arguments);
}

function hardRows(text, width) {
  return text.split('\n').flatMap((row) => {
    let expanded = '';
    for (const char of row) expanded += char === '\t' ? ' '.repeat(8 - expanded.length % 8) : char;
    return expanded.length ? Array.from({ length: Math.ceil(expanded.length / width) }, (_, i) => expanded.slice(i * width, (i + 1) * width)) : [''];
  });
}

function bashGeometry(width, outputPad = 1) {
  let spare = Math.max(0, width - 1);
  const border = Math.min(1, spare); spare -= border;
  const padding = Math.min(2, spare); spare -= padding;
  const inside = Math.ceil(padding / 2), insideRight = Math.floor(padding / 2);
  const left = Math.min(outputPad, Math.floor(spare / 2)), right = Math.min(outputPad, spare - left);
  return { left, border, inside, insideRight, right, origin: left + border + inside, content: width - left - right - border - padding };
}

function bashExpected(tool, args, dump, { partial = false } = {}) {
  const width = bashGeometry(dump.width, dump.outputPad).content;
  const comments = [];
  if (args.description?.trim()) comments.push('# ' + args.description.trim());
  if (args.workdir && resolve(dump.cwd, args.workdir) !== resolve(dump.cwd)) comments.push('# Running in ' + resolve(dump.cwd, args.workdir));
  const rows = comments.flatMap((row) => hardRows(row, width));
  if (comments.length) rows.push('');
  rows.push(...hardRows('$ ' + args.command, width));
  const output = (tool.content || []).filter((block) => block.type === 'text').map((block) => block.text).join('\n').replace(/\r\n?/g, '\n');
  const code = tool.details?.exit_code;
  const nonzero = Number.isFinite(code) && Number.isInteger(code) && code !== 0;
   const logical = output.split('\n');
   while (logical.length && !logical.at(-1).trim()) logical.pop();
   // Independent ASCII suffix expression, not production's logical-row indexing.
   const timeout = !partial && code === 124 && /(?:^|\n)[ \t]*\n\[command timed out\]\n\[exit code: 124\]$/.test(logical.join('\n'));
   const footer = timeout ? '[exit code: 124; error: command timed out]' :
     nonzero ? `[exit code: ${code}${tool.isError ? '; error: execution failed' : ''}]` : tool.isError ? '[error: execution failed]' : '';
   if (timeout) logical.splice(-2);
   else if (!partial && nonzero && logical.at(-1) === footer && logical.length > 1 && !logical.at(-2).trim()) logical.pop();
   while (logical.length && !logical.at(-1).trim()) logical.pop();
   // Keep the leading separator available for a suffix-only duplicate before edge trimming.
   while (logical.length && !logical[0].trim()) logical.shift();
   // Deliberately wrap all ASCII output; production's bounded 11-row iterator is not this oracle.
  const visual = logical.length ? hardRows(logical.join('\n'), width) : [];
  if (visual.length) {
    const preview = tool.expanded ? visual : visual.slice(0, 10);
    if (!tool.expanded && visual.length > 10) while (preview.length && !preview.at(-1).trim()) preview.pop();
    rows.push('', ...preview);
    if (!tool.expanded && visual.length > 10) {
      const hint = '… (Click to expand)';
      rows.push(hint.length <= width ? hint : width <= 3 ? '.'.repeat(width) : hint.slice(0, width - 3) + '...');
    }
  }
  if (!partial && footer) rows.push('', ...hardRows(footer, width));
  return rows;
}

function bashCard(tool, args, dump, options) {
  assert.equal(typeof args.command, 'string');
  const actual = tool.lines.map((row) => stripVTControlCharacters(row));
  if (dump.width === 0) { assert.deepEqual(actual, []); return; }
  const geometry = bashGeometry(dump.width, dump.outputPad);
  const top = geometry.border ? actual.findIndex((row) => row.includes('┃')) : actual[0] === '' ? 1 : 0;
  assert.ok(top === 0 || top === 1, 'at most one unpainted transcript separator before panel');
  if (top) assert.equal(actual[0], '', 'outside separator is genuinely empty, not a painted panel row');
  const frame = (body = '') => ' '.repeat(geometry.left) + (geometry.border ? '┃' : '') +
    ' '.repeat(geometry.inside) + body.padEnd(geometry.content) + ' '.repeat(geometry.insideRight + geometry.right);
  assert.equal(actual[top], frame(), 'exact full-panel top padding row, including left marker and exterior margins');
  assert.equal(actual.at(-1), frame(), 'exact full-panel bottom padding row');
  const expected = bashExpected(tool, args, dump, options);
  assert.deepEqual(actual.slice(top + 1, -1), expected.map(frame), 'independent Output-padding oracle: complete body, left marker, one inside cell per side, exact exterior margins');
  assert.doesNotMatch(actual.join('\n'), /Took \d|✓| [→⚙] bash/, 'custom bash card has no native title/runtime/success marker');
}

function allBashCards(dump, options) {
  const args = bashArguments(dump);
  assert.equal(args.length, byName(dump, 'bash').length);
  byName(dump, 'bash').forEach((tool, i) => bashCard(tool, args[i], dump, options));
}

function simpleBashCards(dump, result = 'BASH_RESULT') {
  allBashCards(dump);
  assert.ok(byName(dump, 'bash')[0].lines.some((row) => plain(row).includes(result)));
}

function traffic(terminal, count) {
  const events = terminal.events();
  assert.equal(events.filter((event) => event.type === 'call').length, count);
  assert.equal(events.filter((event) => event.type === 'result').length, count);
  assert.equal(events.filter((event) => event.type === 'model_context').length, count + 1);
  assert.equal(events.filter((event) => event.type === 'provider_error').length, 0);
  return events.filter((event) => ['call', 'result', 'model_context'].includes(event.type));
}

async function mouseAt(terminal, dump, needle, { offset = 0, button = 0 } = {}) {
  const y = dump.screen.findIndex((row) => row.includes(needle));
  assert.ok(y >= 0, `mouse target is on real screen: ${needle}`);
  const x = Math.max(1, dump.screen[y].indexOf(needle) + 1);
  terminal.send(`\x1b[<${button};${x};${y + 1 + offset}M\x1b[<${button};${x};${y + 1 + offset}m`);
  await terminal.settle();
}

async function bashScreenStyle(dump, needle, role, background) {
  // Heredoc data is present in both supplied command and returned output; sample the output occurrence.
  const y = role === 'toolOutput' ? dump.screen.findLastIndex((row) => row.includes(needle)) : dump.screen.findIndex((row) => row.includes(needle));
  assert.ok(y >= 0, `styled content appears on screen: ${needle}`);
  const actual = dump.cells[y][dump.screen[y].indexOf(needle)];
  const ref = new Terminal({ cols: 10, rows: 2, allowProposedApi: true });
  try {
    await new Promise((done) => ref.write(dump.summaryStyles[role], done));
    let cell = ref.buffer.active.getLine(0).getCell(0);
    assert.deepEqual({ fg: actual.fg, mode: actual.fgMode, dim: actual.dim },
      { fg: cell.getFgColor(), mode: cell.getFgColorMode(), dim: cell.isDim() }, `screen foreground: ${role}`);
    ref.reset();
    await new Promise((done) => ref.write(dump.backgroundStyles[background], done));
    cell = ref.buffer.active.getLine(0).getCell(0);
    assert.deepEqual({ bg: actual.bg, mode: actual.bgMode }, { bg: cell.getBgColor(), mode: cell.getBgColorMode() }, `screen background: ${background}`);
  } finally { ref.dispose(); }
}

function panelAt(dump, index, needle) {
  const tool = byName(dump, 'bash')[index];
  const component = tool.lines.map((row) => stripVTControlCharacters(row));
  const top = component.findIndex((row) => row.includes('┃'));
  const row = component.findIndex((line) => line.includes(needle));
  const screen = dump.screen.findIndex((line) => line.includes(needle));
  assert.ok(top >= 0 && row > top && screen >= 0, `panel ${index} anchor on actual screen: ${needle}`);
  const y = screen - row + top;
  const bottom = y + component.length - top - 1;
  assert.ok(y > 0 && bottom < dump.screen.length, 'complete panel and preceding separator visible');
  return { y, bottom, command: screen, left: 1, right: dump.width - 2 };
}

async function sgrAt(terminal, x, y, button = 0, release = true) {
  if (button === 0 && release && terminal.lastSingleClick) {
    // Distinct single clicks must not become Pi's native <=500ms word/line selection.
    await sleep(Math.max(0, 520 - (Date.now() - terminal.lastSingleClick)));
  }
  terminal.send(`\x1b[<${button};${x + 1};${y + 1}M` + (release ? `\x1b[<${button};${x + 1};${y + 1}m` : ''));
  if (button === 0 && release) terminal.lastSingleClick = Date.now();
  await terminal.settle();
}

async function moveAt(terminal, x, y) { await sgrAt(terminal, x, y, 35, false); }

async function referenceCell(style) {
  const term = new Terminal({ cols: 10, rows: 2, allowProposedApi: true });
  try {
    await new Promise((done) => term.write(style, done));
    const cell = term.buffer.active.getLine(0).getCell(0);
    return { fg: cell.getFgColor(), fgMode: cell.getFgColorMode(), dim: cell.isDim(), bg: cell.getBgColor(), bgMode: cell.getBgColorMode() };
  } finally { term.dispose(); }
}

async function panelCells(dump, index, needle, { error = false } = {}) {
  const panel = panelAt(dump, index, needle);
  const bg = await referenceCell(dump.backgroundStyles.toolPendingBg);
  const border = await referenceCell(error ? dump.frameStyles.errorBorder : dump.frameStyles.border);
  assert.notEqual(border.fgMode, 0, 'semantic border reference is nondefault');
  if (error) {
    const footerY = dump.screen.findIndex((row, y) => y >= panel.y && y <= panel.bottom && /\[(?:exit code:|error:)/u.test(row));
    assert.ok(footerY >= 0, 'error footer is physically displayed inside the failed panel');
    const footerX = dump.screen[footerY].indexOf('['), footer = dump.cells[footerY][footerX];
    const stripe = dump.cells[footerY][1];
    assert.deepEqual({ fg: stripe.fg, mode: stripe.fgMode, dim: stripe.dim },
      { fg: footer.fg, mode: footer.fgMode, dim: footer.dim }, 'failed stripe matches actual footer foreground');
  }
  for (let y = panel.y; y <= panel.bottom; y++) {
    for (let x = 0; x < dump.width; x++) {
      const cell = dump.cells[y][x];
      if (x < 1 || x >= dump.width - 1) {
        assert.ok(cell.text === '' || cell.text === ' ', `exterior cell is blank at (${x},${y})`);
        assert.equal(cell.bgMode, 0, `exterior background remains terminal default at (${x},${y})`);
      } else if (x === 1) {
        assert.equal(cell.bgMode, 0, `ordinary/error stripe background is terminal default at (${x},${y})`);
      } else {
        assert.deepEqual({ bg: cell.bg, bgMode: cell.bgMode }, { bg: bg.bg, bgMode: bg.bgMode }, `whole panel background stays strictly neutral at (${x},${y})`);
      }
    }
    const cell = dump.cells[y][1];
    assert.equal(cell.text, '┃', 'left border on every panel row including padding');
    assert.deepEqual({ fg: cell.fg, fgMode: cell.fgMode, dim: cell.dim },
      { fg: border.fg, fgMode: border.fgMode, dim: border.dim }, 'border foreground matches public active-theme reference');
    for (const x of [2, dump.width - 2]) assert.equal(dump.cells[y][x].text, ' ', 'one inside cell per side');
  }
  assert.equal(dump.screen[panel.y - 1], '', 'exactly one blank transcript separator precedes panel top');
  for (const cell of dump.cells[panel.y - 1]) assert.equal(cell.bgMode, 0, 'preceding transcript separator is outside panel painting');
  for (const y of [panel.y, panel.bottom]) for (let x = 2; x < dump.width - 1; x++)
    assert.equal(dump.cells[y][x].text, ' ', 'full top/bottom panel padding');
  return panel;
}

function physicalEditor(dump) {
  assert.ok(dump.editor, 'actual public stock editor is recorded');
  const expected = editorPaint(dump.editor.lines).map(plain);
  const top = dump.screen.findLastIndex((_row, start) => expected.every((row, offset) => dump.screen[start + offset]?.trimEnd() === row));
  assert.ok(top >= 0, 'complete actual editor block is physically visible');
  return { top, bottom: top + expected.length - 1 };
}

async function bashPointerChecks(live, initial) {
  let current = initial;
  const anchor = 'for i in $(seq 1 11)';
  const panel = () => panelAt(current, 2, anchor);
  const snapshot = async (name) => { current = await live.capture(`pointer-${name}`); return current; };
  const states = () => current.tools.map((tool) => tool.expanded);
  await panelCells(current, 0, "cat <<'TIDY_UI_EOF'");
  await panelCells(current, 2, anchor);
  await panelCells(current, 3, "printf 'REAL_ERROR", { error: true });
  const noninteractive = panelAt(current, 0, "cat <<'TIDY_UI_EOF'");
  await moveAt(live, 5, noninteractive.command); await snapshot('nonexpandable-move');
  await panelCells(current, 0, "cat <<'TIDY_UI_EOF'");
  await sgrAt(live, 2, noninteractive.y); await snapshot('nonexpandable-click');
  assert.ok(current.tools.every((tool) => !tool.expanded), 'nonexpandable panel does not toggle');
  // Native no-button motion must leave every panel cell strictly neutral.
  await moveAt(live, 5, panel().command); await snapshot('enter');
  await panelCells(current, 2, anchor);
  for (const x of [0, current.width - 1]) {
    await moveAt(live, 5, panel().command); await snapshot(`margin-${x}-enter`);
    await panelCells(current, 2, anchor);
    await moveAt(live, x, panel().command); await snapshot(`margin-${x}`);
    await panelCells(current, 2, anchor);
  }
  await moveAt(live, 5, panel().command); await snapshot('before-editor'); await panelCells(current, 2, anchor);
  const editor = physicalEditor(current);
  await moveAt(live, 5, editor.top + 1); await snapshot('editor-leave'); await panelCells(current, 2, anchor);
  await moveAt(live, 5, panel().command); await snapshot('before-focus'); await panelCells(current, 2, anchor);
  live.send('\x1b[O'); await live.settle(); await snapshot('focus-out'); await panelCells(current, 2, anchor);
  live.send('\x1b[I'); await live.settle(); await snapshot('focus-in'); await panelCells(current, 2, anchor);
  // Primary clicks on both exterior cells and the separator are ignored.
  for (const [x, y, label] of [[0, panel().command, 'left'],
    [current.width - 1, panel().command, 'right'], [3, panel().y - 1, 'separator']]) {
    const before = states(); await sgrAt(live, x, y); await snapshot(`outside-click-${label}`); assert.deepEqual(states(), before);
  }
  // A press and drag must remain a host selection, not a captured expansion gesture.
  let p = panel(); const beforeDrag = states();
  await sgrAt(live, 5, p.command, 0, false); await snapshot('press'); assert.deepEqual(states(), beforeDrag);
  await sgrAt(live, 15, p.command, 32, false);
  live.send(`\x1b[<0;16;${p.command + 1}m`); await live.settle();
  await snapshot('selection-drag');
  assert.equal(current.selectionActive, true, 'public root confirms an actual text selection after SGR drag/release');
  assert.deepEqual(states(), beforeDrag);
  await moveAt(live, 5, p.command); await snapshot('selection-move'); assert.deepEqual(states(), beforeDrag);
  // An actual single click in the exterior resets native selection without toggling the card.
  await sgrAt(live, 0, p.command); await snapshot('selection-cleared'); assert.equal(current.selectionActive, false); assert.deepEqual(states(), beforeDrag);
  await sgrAt(live, 5, panel().command, 2); await snapshot('secondary'); assert.deepEqual(states(), beforeDrag);
  // Native word selection on a deliberate double-click suppresses the second normalized click.
  await sleep(520); p = panel();
  const click = `\x1b[<0;8;${p.command + 1}M\x1b[<0;8;${p.command + 1}m`;
  live.send(click + click); await live.settle(); await snapshot('active-selection-click');
  assert.equal(current.selectionActive, true, 'actual native double-click selected the command word');
  assert.equal(current.tools[2].expanded, true, 'first click expands; active-selection second click does not collapse');
  assert.ok(current.tools.filter((_, i) => i !== 2).every((tool) => !tool.expanded));
  await sgrAt(live, 0, panel().command); await snapshot('double-selection-cleared'); assert.equal(current.selectionActive, false);
  await sgrAt(live, 2, panel().command); await snapshot('double-selection-restored'); assert.equal(current.tools[2].expanded, false);
  // These coordinates include exact left/right panel bounds, both padding rows and all content roles.
  for (const region of ['border', 'inside', 'inside-right', 'command', 'gap', 'right-edge', 'top', 'bottom']) {
    p = panel();
    const [x, y] = region === 'border' ? [1, p.command] : region === 'inside' ? [2, p.command] :
      region === 'inside-right' ? [current.width - 2, p.command] :
      region === 'command' ? [3, p.command] : region === 'gap' ? [3, p.command + 1] :
      region === 'right-edge' ? [current.width - 2, p.command] : region === 'top' ? [3, p.y] : [3, p.bottom];
    const before = states(); await sgrAt(live, x, y); await snapshot(`panel-${region}`);
    assert.equal(current.tools[2].expanded, !before[2], `whole-panel primary click toggles ${region}`);
    assert.deepEqual(states().filter((_, i) => i !== 2), before.filter((_, i) => i !== 2), 'only receiving card toggles');
    // Restore collapsed through its border for the next region; no direct mutation.
    if (current.tools[2].expanded) { await sgrAt(live, 1, panel().command); await snapshot(`restore-${region}`); }
  }
  // Wheel remains native; no card toggles.
  const beforeWheel = states(); p = panel();
  await sgrAt(live, 5, p.command, 64, false); await snapshot('wheel'); assert.deepEqual(states(), beforeWheel);
  await sgrAt(live, 5, panel().command, 65, false); await snapshot('wheel-back'); assert.deepEqual(states(), beforeWheel);
  live.send('\x0f'); await live.settle(); await snapshot('expanded-transfer-base');
  assert.ok(current.tools.every((tool) => tool.expanded));
  await moveAt(live, 5, panel().command); await snapshot('transfer-from'); await panelCells(current, 2, anchor);
  const first = panelAt(current, 0, "cat <<'TIDY_UI_EOF'");
  await moveAt(live, 5, first.command); await snapshot('transfer-to');
  await panelCells(current, 0, "cat <<'TIDY_UI_EOF'"); await panelCells(current, 2, anchor);
  // Expanded error footer remains clickable; motion changes neither neutral paint nor error border.
  await moveAt(live, 5, panelAt(current, 3, "printf 'REAL_ERROR").command); await snapshot('error-move');
  await panelCells(current, 3, "printf 'REAL_ERROR", { error: true });
  await mouseAt(live, current, '[error: execution failed]'); await snapshot('footer-collapse'); assert.equal(current.tools[3].expanded, false);
  live.send('\x0f'); await live.settle(); await snapshot('collapsed-transfer-end');
  assert.ok(current.tools.every((tool) => !tool.expanded));
  await live.resize(100, 35); await snapshot('wheel-small-viewport');
  const wheelY = current.screen.findIndex((line) => line.includes('REAL_ROW_08'));
  assert.ok(wheelY >= 0, 'interactive output is visible in a genuinely scrollable viewport');
  const wheelScreen = [...current.screen], wheelStates = states();
  await sgrAt(live, 5, wheelY, 64, false); await snapshot('wheel-scroll');
  assert.notDeepEqual(current.screen, wheelScreen, 'uncaptured wheel reaches native transcript scrolling');
  assert.deepEqual(states(), wheelStates, 'native scrolling does not toggle any card');
  await live.resize(100, 150); await snapshot('wheel-restored');
  await moveAt(live, 5, panel().command); await snapshot('before-resize'); await panelCells(current, 2, anchor);
  await live.resize(24, 150); await snapshot('resized');
  await panelCells(current, 2, 'for i in $(seq');
  // Neutral paint must survive resize, re-entry and widening.
  await moveAt(live, 5, panelAt(current, 2, 'for i in $(seq').command); await snapshot('narrow-enter');
  await panelCells(current, 2, 'for i in $(seq');
  await live.resize(100, 150); await snapshot('resize-back'); await panelCells(current, 2, anchor);
  await moveAt(live, 5, panel().command); await snapshot('before-off'); await panelCells(current, 2, anchor);
  await live.appearance(false); await snapshot('off');
  await live.appearance(true); await snapshot('on'); await panelCells(current, 2, anchor);
  await moveAt(live, 5, panel().command); await snapshot('before-reload'); await panelCells(current, 2, anchor);
  const starts = live.events().filter((event) => event.type === 'start').length;
  await live.command('/reload'); await live.event('start', starts + 1); await snapshot('reload'); await panelCells(current, 2, anchor);
  await moveAt(live, 5, panel().command); await snapshot('post-reload-enter'); await panelCells(current, 2, anchor);
  await moveAt(live, 0, panel().command); await snapshot('post-reload-leave'); await panelCells(current, 2, anchor);
  // Native /settings replaces the renderer without reloading extensions or transcript components.
  const modeEvents = live.events();
  const modeTraffic = traffic(live, 4);
  const nativeMode = async (from, to) => {
    await live.command('/settings');
    live.send('TUI mode'); await live.settle();
    assert.ok(live.screen().some((row) => new RegExp(`^\\s*→ TUI mode\\s+${from}\\s*$`, 'u').test(row)),
      `native settings search selects TUI mode: ${from}`);
    // SettingsList cycles values immediately on Enter; Esc only closes the selector.
    live.send('\r'); await live.settle();
    assert.ok(live.screen().some((row) => new RegExp(`^\\s*→ TUI mode\\s+${to}\\s*$`, 'u').test(row)),
      `native settings Enter switches TUI mode: ${to}`);
    assert.equal(live.term.buffer.active.type, to === 'fullscreen' ? 'alternate' : 'normal',
      'actual terminal buffer reflects the native renderer replacement');
    live.send('\x1b'); await live.settle();
    assert.ok(!live.screen().some((row) => /→ TUI mode\s+/u.test(row)), 'Esc closes native settings');
  };
  await moveAt(live, 5, panel().command); await snapshot('mode-before-regular');
  await panelCells(current, 2, anchor);
  await nativeMode('fullscreen', 'regular'); await snapshot('mode-regular'); allBashCards(current);
  await panelCells(current, 0, "cat <<'TIDY_UI_EOF'");
  await panelCells(current, 2, anchor);
  await panelCells(current, 3, "printf 'REAL_ERROR", { error: true });
  assert.ok(current.tools.every((tool) => !tool.expanded), 'regular replacement retains collapsed state');
  live.send('\x0f'); await live.settle(); await snapshot('mode-regular-expanded'); allBashCards(current);
  await panelCells(current, 2, anchor);
  await panelCells(current, 3, "printf 'REAL_ERROR", { error: true });
  assert.ok(current.tools.every((tool) => tool.expanded), 'real Ctrl+O expands retained tools in regular mode');
  assert.ok(current.screen.some((row) => row.includes('REAL_ROW_11')), 'regular expanded output appears on actual screen');
  live.send('\x0f'); await live.settle(); await snapshot('mode-regular-collapsed'); allBashCards(current);
  await panelCells(current, 2, anchor);
  assert.ok(current.tools.every((tool) => !tool.expanded), 'real Ctrl+O collapses retained tools in regular mode');
  await nativeMode('regular', 'fullscreen'); await snapshot('mode-fullscreen'); allBashCards(current);
  await panelCells(current, 0, "cat <<'TIDY_UI_EOF'");
  await panelCells(current, 2, anchor);
  await panelCells(current, 3, "printf 'REAL_ERROR", { error: true });
  await moveAt(live, 5, panel().command); await snapshot('mode-fullscreen-enter');
  await panelCells(current, 2, anchor);
  await moveAt(live, 0, panel().command); await snapshot('mode-fullscreen-margin-leave');
  await panelCells(current, 2, anchor);
  await moveAt(live, 5, panel().command); await snapshot('mode-fullscreen-focus-enter');
  await panelCells(current, 2, anchor);
  live.send('\x1b[O'); await live.settle(); await snapshot('mode-fullscreen-focus-out');
  await panelCells(current, 2, anchor);
  live.send('\x1b[I'); await live.settle(); await snapshot('mode-fullscreen-focus-in');
  await panelCells(current, 2, anchor);
  assert.deepEqual(live.events(), modeEvents, 'native settings replacements emit no extra start/session_start/reload or execution events');
  assert.deepEqual(traffic(live, 4), modeTraffic, 'native settings replacements preserve four calls/results and five model contexts');
  assert.deepEqual(current.tools.map((tool) => tool.id), initial.tools.map((tool) => tool.id), 'native settings replacements retain the same transcript calls');
  assert.deepEqual(persisted(current), persisted(initial), 'pointer and lifecycle operations preserve exact stored traffic');
  return current;
}

async function actualCommandCells(dump, commands, { mode, scrollbar }) {
  const panels = [], editor = physicalEditor(dump);
  // An always-visible native scrollbar also uses ┃, outside the tool allocation.
  const reserved = mode === 'fullscreen' && scrollbar === 'always' ? 1 : 0;
  const hasCardBorder = (row) => row.slice(0, row.length - reserved).some((cell) => cell?.text === '┃');
  for (let y = 0; y < dump.cells.length; y++) {
    const statusEdge = dump.cells[y + 1]?.some(cell => cell?.text === '╹') &&
      dump.cells[y + 1]?.some(cell => cell?.text === '▀');
    if ((y >= editor.top && y <= editor.bottom) || statusEdge || !hasCardBorder(dump.cells[y])) continue;
    const top = y;
    while (y + 1 < dump.cells.length && y + 1 !== editor.top && hasCardBorder(dump.cells[y + 1])) y++;
    panels.push({ top, bottom: y });
  }
  assert.equal(panels.length, commands.length + dump.users.length,
    'exactly the user and command panels are displayed; no missing or extra frame');
  // User messages now share the frame. Identify command panels by their actual
  // first content cells, not by counting all stripes or assuming distinct colors.
  const commandPanels = panels.filter(({ top }) => dump.cells[top + 1]?.slice(3, 5)
    .map((cell) => cell?.text || ' ').join('') === '$ ');
  assert.equal(commandPanels.length, commands.length, 'every command owns exactly one complete displayed panel');
  const background = await referenceCell(dump.backgroundStyles.toolPendingBg);
  const cellText = (cell) => cell.text || ' ';
  const observations = [];
  for (const [index, { top, bottom }] of commandPanels.entries()) {
    const padding = dump.cells[top];
    const left = padding.findIndex((cell) => cell.text === '┃');
    let panelEnd = left + 1; // stripe background is default, not panel paint
    while (panelEnd < padding.length && padding[panelEnd].bgMode === background.bgMode && padding[panelEnd].bg === background.bg) panelEnd++;
    // Observe the painted end, then add the contract's one unpainted exterior cell.
    // Fullscreen 'always' reserves a scrollbar column; regular/auto do not.
    const allocated = panelEnd + 1;
    assert.equal(allocated, dump.cells[top].length - (mode === 'fullscreen' && scrollbar === 'always' ? 1 : 0),
      'observed frame width matches actual host allocation, not the manual dump width');
    assert.equal(left, 1, 'exact one-cell exterior-left margin');
    const origin = left + 2, contentWidth = panelEnd - 1 - origin;
    assert.equal(origin, 3, 'one border cell plus one inside-left cell');
    assert.equal(contentWidth, allocated - 5, 'observed content width excludes both inner and exterior paddings');
    const command = commands[index];
    assert.match(command, /^[\x20-\x7e\n]*$/u, 'this independent oracle is deliberately ASCII-only');
    const logical = ('$ ' + command).split('\n');
    const expected = logical.flatMap((line) => line.length ? Array.from({ length: Math.ceil(line.length / contentWidth) },
      (_, row) => line.slice(row * contentWidth, (row + 1) * contentWidth)) : ['']);
    assert.ok(top > 0 && bottom + 1 < dump.cells.length, 'all command rows and complete panel padding are visible');
    assert.ok(bottom > top + expected.length, 'panel includes every command row and bottom padding');
    for (let y = top; y <= bottom; y++) {
      for (let x = 0; x < allocated; x++) {
        const cell = dump.cells[y][x];
        if (x === 0 || x === allocated - 1) {
          assert.equal(cellText(cell), ' ', `exact blank exterior (${x},${y})`);
          assert.equal(cell.bgMode, 0, `unpainted exterior (${x},${y})`);
        } else if (x === left) {
          assert.equal(cell.bgMode, 0, `default stripe background (${x},${y})`);
        } else {
          assert.deepEqual({ bg: cell.bg, bgMode: cell.bgMode }, { bg: background.bg, bgMode: background.bgMode },
            `panel physical background (${x},${y})`);
        }
      }
      assert.equal(dump.cells[y][left].text, '┃', 'one border on every physical row');
      for (const x of [left + 1, panelEnd - 1]) assert.equal(cellText(dump.cells[y][x]), ' ', 'exact inside-left/right padding');
    }
    for (const y of [top, bottom]) assert.equal(dump.cells[y].slice(origin, panelEnd - 1).map(cellText).join(''),
      ' '.repeat(contentWidth), 'full top/bottom content padding');
    const actual = expected.map((row, offset) => {
      const cells = dump.cells[top + 1 + offset];
      const region = cells.slice(origin, panelEnd - 1);
      assert.ok(region.every((cell) => cell.width === 1), 'ASCII command occupies one physical cell per column');
      assert.equal(region.map(cellText).join(''), row.padEnd(contentWidth), 'every displayed command row, including whitespace and right padding');
      return region.slice(0, row.length).map(cellText).join('');
    });
    assert.equal(dump.cells[top + expected.length + 1].slice(origin, panelEnd - 1).map(cellText).join(''),
      ' '.repeat(contentWidth), 'immediately after complete command is its blank output separator or bottom padding');
    // Restore only known logical newline boundaries; never trim or delete command whitespace.
    let cursor = 0;
    const reconstructed = logical.map((line) => actual.slice(cursor, cursor += Math.max(1, Math.ceil(line.length / contentWidth))).join('')).join('\n');
    assert.equal(reconstructed, '$ ' + command, 'all displayed command chars reconstructed exactly: no missing/duplicated chars');
    observations.push({ allocatedWidth: allocated, contentWidth, origin, commandChars: command.length,
      commandRows: actual.length, displayed: actual, reconstructed, equality: true });
  }
  return observations;
}

async function footerObserve(terminal, name, action = 'snapshot', animated = false) {
  writeFileSync(join(terminal.output, 'footer-request.json'), JSON.stringify({ name, ...(typeof action === 'string' ? { action } : action) }));
  terminal.send('\x1b\x06');
  const dump = await terminal.waitForProgress(() => {
    terminal.health();
    try { return JSON.parse(readFileSync(join(terminal.output, `${name}.json`), 'utf8')); }
    catch (error) { if (error.code === 'ENOENT' || error instanceof SyntaxError) return false; throw error; }
  }, `footer ${name}`);
  if (animated) await terminal.observeAnimation(); else await terminal.settle(); terminal.session = dump.session;
  return terminal.captureScreen(name, dump);
}

function footerPhysical(dump) {
  const expected = dump.rows.map(plain), starts = dump.screen.flatMap((row, y) => plain(row) === expected[0] &&
    expected.every((value, offset) => plain(dump.screen[y + offset] || '') === value) ? [y] : []);
  assert.ok(starts.length > 0, `complete physical footer at ${dump.width}: ${expected.join('|')}`);
  for (const row of dump.rows) assert.ok(visibleWidth(row) <= dump.width);
  return starts.at(-1);
}

function colorProfile(agentDir, project = false, workDir) {
  const theme = JSON.parse(readFileSync(join(root, 'node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/dark.json'), 'utf8'));
  theme.name = 'terminal-colors'; theme.appearance = 'dark';
  theme.colors.userMessageBg = ''; theme.colors.toolPendingBg = '';
  theme.colors.toolDiffAdded = '#00ff00'; theme.colors.toolDiffRemoved = '#ff0000'; theme.colors.text = '#eeeeee';
  // Pin diff inputs: this control tests terminal defaults, not changes to Pi's bundled palette.
  theme.colors.toolSuccessBg = '#2d4935'; theme.colors.toolErrorBg = '#492d35'; theme.colors.toolOutput = '#eeeeee';
  for (const role of Object.keys(theme.colors)) if (role.startsWith('syntax')) theme.colors[role] = '#eeeeee';
  theme.vars.surface = '#123456'; theme.vars.surfaceAlias = 'surface'; theme.export = { ...theme.export, pageBg: 'surfaceAlias' };
  mkdirSync(join(agentDir, 'themes'), { recursive: true });
  const path = join(agentDir, 'themes', `${theme.name}.json`);
  writeFileSync(path, JSON.stringify(theme));
  if (project) { mkdirSync(join(workDir, '.pi'), { recursive: true }); writeFileSync(join(workDir, '.pi/settings.json'), '{"theme":"dark"}'); }
  return { theme, path };
}

function colorTerminal(name, mode, { native = false, project = false, automatic = false, driver = join(fixtures, 'terminal-colors-driver.ts'), session, workspace, jobControl = false,
  tidyUiSettings = { terminalColorsEnabled: true } } = {}) {
  let source;
  const terminal = new PiTerminal(name, { mode, session, workspace, jobControl, tidyUiSettings, flags: project ? ['--approve'] : [],
    agentSettings: { theme: project ? 'dark' : automatic ? 'dark/dark' : 'terminal-colors' },
    extraEnv: native ? { TIDY_UI_TEST_COLORS_NATIVE: '1' } : {},
    extensions: [driver],
    profileFactory: ({ agentDir, workDir }) => { source = colorProfile(agentDir, project, workDir); },
  });
  const profile = { foreground: '#e5e5e7', background: '#0a0b0c' }, owned = {}, protocol = [];
  for (const [code, key] of [[10, 'foreground'], [11, 'background']]) {
    terminal.term.parser.registerOscHandler(code, value => {
      if (value === '?') {
        const hex = owned[key] ?? profile[key]; protocol.push({ query: key, value: hex });
        terminal.send(`\x1b]${code};rgb:` + [1, 3, 5].map(i => hex.slice(i, i + 2).repeat(2)).join('/') + '\x07');
      } else if (/^#[\da-f]{6}$/iu.test(value)) { owned[key] = value.toLowerCase(); protocol.push({ set: key, value: owned[key] }); }
      return true;
    });
    terminal.term.parser.registerOscHandler(code + 100, () => { delete owned[key]; protocol.push({ reset: key }); return true; });
  }
  const capture = async (name, action = 'snapshot', theme) => {
    writeFileSync(join(terminal.output, 'colors-request.json'), JSON.stringify({ name, action, theme }));
    terminal.send('\x1b[98;7u');
    if (action === 'on' || action === 'off') await terminal.appearance(action === 'on', { alreadyOpen: true });
    else if (action === 'colors on' || action === 'colors off') await terminal.terminalColors(action === 'colors on', { alreadyOpen: true });
    else if (action === 'colors status') {
      await until(() => terminal.tidyHeading('Tidy UI'), 'shortcut opened color status');
      await terminal.selectTidyItem('Status & troubleshooting'); await terminal.closeTidyMenu();
    }
    const data = await terminal.waitForProgress(() => {
      terminal.health();
      try { return JSON.parse(readFileSync(join(terminal.output, `${name}.json`), 'utf8')); }
      catch (error) { if (error.code === 'ENOENT' || error instanceof SyntaxError) return false; throw error; }
    }, `color snapshot ${name}`);
    await terminal.settle(); return terminal.captureScreen(name, data);
  };
  return { terminal, source, profile, owned, protocol, capture };
}

async function selectDarkDark(terminal) {
  await terminal.command('/settings'); terminal.send('Theme'); await terminal.settle(); terminal.send('\r'); await terminal.settle();
  assert.ok(terminal.screen().some(row => row.includes('automatic')), 'native Theme selector');
  terminal.send('\x1b[A'); await terminal.settle(); terminal.send('\r'); await terminal.settle();
  assert.ok(terminal.screen().some(row => row.includes('Automatic Theme')), 'native Automatic Theme selector');
  terminal.send('\x1b[B\x1b[B'); await terminal.settle(); terminal.send('\r'); await terminal.settle(); terminal.send('\x1b'); await terminal.settle();
}

function colorTraffic(terminal) {
  for (const [type, count] of [['call', 7], ['result', 7], ['model_context', 8], ['provider_error', 0]])
    assert.equal(terminal.events().filter(event => event.type === type).length, count, `exact ${type} count`);
  return terminal.events().filter(event => ['call', 'result', 'model_context'].includes(event.type));
}

export { Terminal, execution, persisted, summaryText, summaryExpected, compactContent, compact, semanticColors, errorSummaryColors, leadingBlanks, nativeAfterMultiline, summaryGraphemes, summarySize, fixtureQuotedPreview, fixtureBoundedSummary, multilineLayout, bashArguments, hardRows, bashGeometry, bashExpected, bashCard, allBashCards, simpleBashCards, traffic, mouseAt, bashScreenStyle, panelAt, sgrAt, moveAt, referenceCell, panelCells, physicalEditor, bashPointerChecks, actualCommandCells, footerObserve, footerPhysical, colorProfile, colorTerminal, selectDarkDark, colorTraffic };
