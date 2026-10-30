import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { fileURLToPath } from 'node:url';
import { PaletteInputOwner } from '../../src/syntax/pi-input-owner.ts';

export function observePaletteInput(id) {
  const path = fileURLToPath(new URL(`../../src/themes/palettes/${id}.json`, import.meta.url));
  const descriptors = new Set();
  const original = {
    openSync: Object.getOwnPropertyDescriptor(fs, 'openSync'),
    readSync: Object.getOwnPropertyDescriptor(fs, 'readSync'),
    closeSync: Object.getOwnPropertyDescriptor(fs, 'closeSync'),
    prepare: Object.getOwnPropertyDescriptor(PaletteInputOwner.prototype, 'prepare'),
  };
  const openSync = fs.openSync;
  const readSync = fs.readSync;
  const closeSync = fs.closeSync;
  const prepare = PaletteInputOwner.prototype.prepare;
  let opens = 0, reads = 0, ownerLookups = 0, restored = false;

  Object.defineProperty(fs, 'openSync', { ...original.openSync, value: function(file, ...args) {
    const palette = String(file) === path;
    if (palette) opens++;
    const fd = openSync.call(fs, file, ...args);
    if (palette) descriptors.add(fd);
    return fd;
  } });
  Object.defineProperty(fs, 'readSync', { ...original.readSync, value: function(fd, ...args) {
    if (descriptors.has(fd)) reads++;
    return readSync.call(fs, fd, ...args);
  } });
  Object.defineProperty(fs, 'closeSync', { ...original.closeSync, value: function(fd) {
    try { return closeSync.call(fs, fd); }
    finally { descriptors.delete(fd); }
  } });
  Object.defineProperty(PaletteInputOwner.prototype, 'prepare', { ...original.prepare, value: function(...args) {
    ownerLookups++;
    return prepare.apply(this, args);
  } });
  // Owned-palette loading uses named built-in imports, so mirror the scoped wrappers.
  syncBuiltinESMExports();

  return {
    snapshot: () => ({ opens, reads, ownerLookups }),
    restore() {
      if (restored) return;
      restored = true;
      Object.defineProperty(fs, 'openSync', original.openSync);
      Object.defineProperty(fs, 'readSync', original.readSync);
      Object.defineProperty(fs, 'closeSync', original.closeSync);
      Object.defineProperty(PaletteInputOwner.prototype, 'prepare', original.prepare);
      syncBuiltinESMExports();
    },
  };
}
