import '../../fixtures/test-guard.mjs';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { deflateSync } from 'node:zlib';
import { TUI_KEYBINDINGS } from '@earendil-works/pi-tui';
import { PiTerminal, deferredNativePreparation } from '../../fixtures/terminal-harness.mjs';
import { closeTerminals } from '../../fixtures/terminal-cleanup.mjs';
import { sgrAt } from '../../fixtures/main-cli-support.mjs';

const file = 'read-image-protocol.png';
const heightPx = 540;
const jumpKeys = [TUI_KEYBINDINGS['tui.altScreen.bottom'].defaultKeys].flat();
const jumpShortcut = jumpKeys.map(key => key.split('+').map(part => part[0].toUpperCase() + part.slice(1)).join('+')).join('/');
const nativeJumpLabel = ` ↓ Jump to latest message${jumpShortcut ? ` · ${jumpShortcut}` : ''} `;

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const body = Buffer.concat([Buffer.from(type), data]), length = Buffer.alloc(4), checksum = Buffer.alloc(4);
  length.writeUInt32BE(data.length); checksum.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, checksum]);
}

function png(size) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size); header.writeUInt32BE(size, 4); header[8] = 8; header[9] = 2;
  const stride = size * 3 + 1, pixels = Buffer.alloc(stride * size, 0x87);
  for (let y = 0; y < size; y++) pixels[y * stride] = 0;
  return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', header),
    chunk('IDAT', deflateSync(pixels)), chunk('IEND', Buffer.alloc(0))]);
}

function imagePackets(bytes) {
  return [...bytes.matchAll(/\x1b_G([^;\x1b]*)(?:;[^\x1b]*)?\x1b\\/gu)].map(match => {
    const controls = Object.fromEntries(match[1].split(',').map(field => field.split('=')));
    const anchor = bytes.slice(0, match.index).match(/\x1b\[(\d+);1H(?:\x1b\[2K)?((?:\x1b\[0m)?(?:\x1b\[\d+C)?)$/u);
    return { controls, index: match.index, end: match.index + match[0].length,
      row: anchor ? Number(anchor[1]) - 1 : undefined, prefix: anchor?.[2] };
  });
}

function raw(terminal, start = 0) { return Buffer.concat(terminal.raw.slice(start)).toString('utf8'); }
function isPlacement(packet) { return packet.controls.a === 'T' || packet.controls.a === 'p'; }
function uploads(terminal, id) { return imagePackets(raw(terminal)).filter(packet => packet.controls.a === 'T' && packet.controls.i === id).length; }

async function phase(terminal, name, action) {
  const start = terminal.raw.length;
  await action();
  // PNG placement is host frame output, independent of asynchronous syntax publication.
  await terminal.settle(); await terminal.queue;
  const capture = terminal.captureScreen(name, {}), bytes = raw(terminal, start);
  return { capture, bytes, packets: imagePackets(bytes) };
}

function placement(observed, id) {
  const placements = observed.packets.filter(isPlacement);
  assert.equal(new Set(placements.map(item => item.controls.i)).size, 1, 'one saved image is not duplicated under another TUI image ID');
  const packet = placements.findLast(item => id === undefined || item.controls.i === id);
  assert.ok(packet, 'the real TUI emitted a Kitty placement for this visible image phase');
  assert.ok(Number.isInteger(packet.row), 'fullscreen image output starts at a native CUP row, not an unpositioned payload');
  return packet;
}

function crop(packet, totalRows) {
  const visible = Number(packet.controls.r), sourceY = Number(packet.controls.y ?? 0);
  const hidden = Math.ceil(sourceY * totalRows / heightPx);
  assert.ok(Number.isSafeInteger(visible) && visible > 0 && visible <= totalRows);
  assert.ok(hidden >= 0 && hidden + visible <= totalRows);
  assert.equal(sourceY, Math.floor(heightPx * hidden / totalRows), 'top crop uses the saved image pixel/grid ratio');
  assert.equal(Number(packet.controls.h ?? heightPx), Math.ceil(heightPx * (hidden + visible) / totalRows) - sourceY,
    'the source pixel height covers exactly the visible grid rows');
  return { hidden, visible };
}

function blankReservation(observed, packet, rows, owned) {
  assert.ok(packet.row + rows <= observed.capture.screen.length, 'the reservation fits the physical viewport');
  for (let y = packet.row; y < packet.row + rows; y++) {
    const cells = observed.capture.cells[y];
    assert.ok(cells, `opaque image reservation row ${y} is present in the captured frame`);
    const rowText = cells.map(cell => cell.text).join('');
    const labelAt = rowText.indexOf(nativeJumpLabel);
    const labelStart = Math.floor((cells.length - nativeJumpLabel.length) / 2);
    assert.ok(labelAt === -1 || labelAt === labelStart, `native jump label stays inside its exact centered row: ${JSON.stringify(rowText)}`);
    for (let x = 0; x < cells.length; x++) {
      const cell = cells[x];
      if (x === cells.length - 1) {
        assert.ok(['', ' ', '│', '┃', '█'].includes(cell.text), `only a native right-edge scrollbar may occupy column ${x}: ${JSON.stringify(cell.text)}`);
      } else if (labelAt >= 0 && x >= labelAt && x < labelAt + nativeJumpLabel.length) {
        assert.equal(cell.text, nativeJumpLabel[x - labelAt], `only the exact Pi jump-label cell is allowed at ${x},${y}`);
      } else {
        assert.ok((cell.text === '' || cell.text === ' ') && cell.bg === -1 && cell.bgMode === 0,
          `opaque image reservation cell ${x},${y} has no application stripe, background, or source text`);
      }
    }
  }
  if (owned) assert.match(packet.prefix, /^\x1b\[0m\x1b\[\d+C$/u, 'only reset/horizontal positioning precedes the image protocol');
}

function returnedImage(terminal, bytes) {
  const results = terminal.events().filter(event => event.type === 'result');
  assert.equal(results.length, 1); assert.equal(results[0].isError, false);
  const image = results[0].content.find(part => part.type === 'image');
  assert.ok(image, 'the actual read tool returned an image, not a shape fixture');
  assert.equal(image.mimeType, 'image/png');
  assert.equal(image.data, bytes.toString('base64'), 'the small PNG is the saved tool image used for pixel/grid expectations');
}

function terminal(name, mode, size = 540) {
  // Pi scales to configured cells, including upscaling small image files.
  const instance = new PiTerminal(name, { tidyUi: true, mode, dimensions: { columns: 100, rows: 60 },
    agentSettings: { outputPad: 1, terminal: { imageWidthCells: mode === 'regular' ? 18 : 60, showImages: true } },
    extraEnv: { PI_IMAGE_PROTOCOL: 'kitty', WEZTERM_PANE: '', TERM_PROGRAM: '', TIDY_UI_TEST_NATIVE_PREPARATION: '1' } });
  const bytes = png(size);
  writeFileSync(join(instance.work, file), bytes);
  writeFileSync(join(instance.output, 'highlighting-limits.json'), JSON.stringify({ calls: [{ name: 'read', arguments: { path: file } }] }));
  return { instance, bytes };
}

async function proveNativeOwnership(terminal) {
  const before = deferredNativePreparation(terminal);
  assert.ok(before.probes.length > 0, 'the loaded deferred-renderer prototype has a real observation epoch');
  assert.equal(before.attempts.filter(event => event.tool === 'read').length, 0, 'owned image interactions materialize no stock read callback');
  const epochs = new Set(before.probes.map(event => event.epoch));
  const native = await phase(terminal, 'image-native-positive', () => terminal.appearance(false));
  const attempts = deferredNativePreparation(terminal).attempts.filter(event => event.tool === 'read');
  assert.ok(attempts.every(event => epochs.has(event.epoch) && event.prototypeMatches === true));
  assert.deepEqual([...new Set(attempts.map(event => event.slot))].sort(), ['call', 'result'], 'Appearance Off observes both stock slots in that same actual epoch');
  assert.ok(native.packets.some(isPlacement), 'the positive stock image is physically placed');
  assert.ok(!native.capture.screen.some(row => row.includes(`→ Read ${file}`)));
}

async function scrollImage(terminal, owned, id, totalRows, initialUploads) {
  const small = await phase(terminal, 'image-small', () => terminal.resize(100, 14));
  let current = placement(small, id), clipped = crop(current, totalRows);
  assert.ok(clipped.hidden > 0 && clipped.visible < totalRows, 'the real short viewport clips the image above its anchor');
  blankReservation(small, current, clipped.visible, owned);
  const heightUploads = uploads(terminal, id) - initialUploads;
  const beforeScroll = uploads(terminal, id), scrollPhases = [];
  for (let step = 0; clipped.hidden > 0 && step < totalRows + 8; step++) {
    const previousHidden = clipped.hidden;
    const scrolled = await phase(terminal, `image-wheel-${step}`, () => sgrAt(terminal, 5, current.row, 64, false));
    current = placement(scrolled, id); clipped = crop(current, totalRows);
    assert.ok(clipped.hidden < previousHidden, 'a real wheel-up action moves the clipped source toward its original anchor');
    blankReservation(scrolled, current, clipped.visible, owned);
    scrollPhases.push({ hidden: clipped.hidden, visible: clipped.visible, sourceY: Number(current.controls.y ?? 0) });
  }
  assert.equal(clipped.hidden, 0, 'wheel scrolling brings the original image anchor back into the viewport');
  assert.ok(clipped.visible < totalRows, 'the re-entering original anchor has a real bottom crop');
  return { heightUploads, scrollUploads: uploads(terminal, id) - beforeScroll, scrollPhases };
}

async function fullscreen(terminal, owned, bytes) {
  await terminal.ready();
  if (!owned) await terminal.appearance(false);
  const start = terminal.raw.length;
  await terminal.run('highlighting-limits-read'); returnedImage(terminal, bytes);
  if (owned) assert.equal(imagePackets(raw(terminal, start)).filter(isPlacement).length, 0, 'collapsed owned read paints no image');
  const full = await phase(terminal, 'image-full', () => terminal.send('\x0f'));
  const anchor = placement(full), id = anchor.controls.i;
  assert.match(id, /^\d+$/u, 'the actual protocol carries the reusable host image identity');
  const initialUpload = imagePackets(raw(terminal, start)).find(packet => packet.controls.a === 'T' && packet.controls.i === id);
  assert.ok(initialUpload, 'the full image has a non-vacuous actual upload');
  const totalRows = Number(initialUpload.controls.r), columns = Number(initialUpload.controls.c);
  assert.ok(totalRows > 14 && totalRows < 50, 'the observed uncropped image is taller than the later small viewport');
  assert.equal(Number(anchor.controls.r), totalRows);
  assert.equal(crop(anchor, totalRows).hidden, 0);
  blankReservation(full, anchor, totalRows, owned);
  assert.equal(full.capture.screen.some(row => row.includes(`→ Read ${file}`)), owned, 'Appearance Off is a genuine stock image presentation');
  if (owned) assert.equal(full.capture.cells[anchor.row + totalRows]?.[1]?.text, '┃', 'the final framed padding stripe follows the opaque reservation at the real left panel edge');
  const initialUploads = uploads(terminal, id);
  assert.equal(initialUploads, 1, 'one host image has one initial transmission');

  const scrolling = await scrollImage(terminal, owned, id, totalRows, initialUploads);

  const beforeHeight = uploads(terminal, id);
  const restored = await phase(terminal, 'image-height-restored', () => terminal.resize(100, 60));
  const restoredAnchor = placement(restored, id);
  assert.equal(Number(restoredAnchor.controls.r), totalRows); assert.equal(crop(restoredAnchor, totalRows).hidden, 0);
  blankReservation(restored, restoredAnchor, totalRows, owned);
  const restoreUploads = uploads(terminal, id) - beforeHeight;
  const beforeWidth = uploads(terminal, id);
  const narrow = await phase(terminal, 'image-narrow', () => terminal.resize(50, 60));
  const narrowAnchor = placement(narrow, id);
  assert.ok(Number(narrowAnchor.controls.c) < columns, 'a narrower content width changes the actual image grid');
  assert.equal(uploads(terminal, id), beforeWidth + 1, 'width change retransmits once under the same host-owned image ID');
  if (owned) {
    const collapsed = await phase(terminal, 'image-collapsed', () => terminal.send('\x0f'));
    assert.equal(collapsed.packets.filter(isPlacement).length, 0, 'collapse does not paint or re-place the image');
    assert.ok(collapsed.packets.some(packet => packet.controls.a === 'd' && packet.controls.d === 'a'), 'the TUI removes the old image placement');
    assert.ok(collapsed.capture.screen.some(row => row.includes(file)));
    assert.ok(!collapsed.capture.screen.some(row => row.includes(`→ Read ${file}`)));
    await proveNativeOwnership(terminal);
  }
  await terminal.close();
  return { ...scrolling, restoreUploads, totalRows, columns, output: terminal.output };
}

test('read image CLI: owned opaque Kitty block preserves real fullscreen scroll and crop geometry', { timeout: 120000 }, async () => {
  const terminals = [];
  try {
    const stock = terminal('read-image-stock-fullscreen', 'fullscreen'); terminals.push(stock.instance);
    const control = await fullscreen(stock.instance, false, stock.bytes);
    const owned = terminal('read-image-owned-fullscreen', 'fullscreen'); terminals.push(owned.instance);
    const actual = await fullscreen(owned.instance, true, owned.bytes);
    assert.equal(actual.columns, control.columns, 'the wide owned block preserves the configured stock image width');
    assert.equal(actual.totalRows, control.totalRows, 'both use the same host image aspect ratio');
    for (const counter of ['heightUploads', 'scrollUploads', 'restoreUploads'])
      assert.equal(actual[counter], control[counter], `owned image adds no transmissions over the stock ${counter} policy`);
    console.log(JSON.stringify({ readImageProtocol: { control, actual, scope: 'real PTY Kitty bytes/cursor grid, not graphical pixels' } }));
  } finally { await closeTerminals(terminals); }
});

test('read image CLI: regular mode reserves the small image before its opaque protocol anchor', { timeout: 60000 }, async () => {
  const { instance, bytes } = terminal('read-image-owned-regular', 'regular', 90);
  try {
    await instance.ready(); await instance.run('highlighting-limits-read'); returnedImage(instance, bytes);
    const expanded = await phase(instance, 'image-regular-expanded', () => instance.send('\x0f'));
    const upload = expanded.packets.find(packet => packet.controls.a === 'T');
    assert.ok(upload, 'a real regular-mode image upload is emitted');
    const reserved = Number(upload.controls.r);
    assert.ok(reserved > 1 && reserved < 14);
    const reservation = new RegExp(`(?:\\r{1,2}\\n(?:\\x1b\\[2K)?){${reserved - 1}}\\x1b\\[${reserved - 1}A\\x1b\\[0m\\x1b\\[3C$`, 'u');
    assert.match(expanded.bytes.slice(0, upload.index), reservation,
      'the immediate native reservation suffix contains only empty rows or differential row erasures, then the content-origin prefix');
    assert.ok(expanded.bytes.slice(upload.end).startsWith(`\x1b[${reserved - 1}B`), 'the native cursor accounts for every reserved row');
    assert.ok(expanded.capture.screen.some(row => row.includes(`→ Read ${file}`)));
    const collapsed = await phase(instance, 'image-regular-collapsed', () => instance.send('\x0f'));
    assert.equal(collapsed.packets.filter(isPlacement).length, 0);
    await proveNativeOwnership(instance);
    console.log(JSON.stringify({ readImageRegular: { reserved, output: instance.output, scope: 'PTY protocol/cursor accounting, not pixels' } }));
  } finally { await closeTerminals([instance]); }
});
