import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

// Inert declared tools for lifecycle tests; these never contact a display server.
export async function runTool(name, root) {
  const args = process.argv.slice(2), settings = JSON.parse(readFileSync(join(root, 'control.json'), 'utf8'));
  const record = value => appendFileSync(join(root, 'journal.jsonl'), JSON.stringify({ tool: name, ...value }) + '\n');
  const save = (path, value) => writeFileSync(path, JSON.stringify(value));
  record({ args });
  if (name === 'hyprctl') {
    if (args[0] === '-j' && args[1] === 'monitors') console.log(JSON.stringify([{ name: 'fixture-monitor', scale: 1, focused: true }]));
    else if (args[0] === '-j' && args[1] === 'clients') {
      const path = join(root, 'window.json');
      console.log(JSON.stringify(existsSync(path) ? [JSON.parse(readFileSync(path, 'utf8'))] : []));
    } else if (args[0] === 'eval') {
      record({ rule: args[1].includes('set_enabled(false)') ? 'disabled' : 'enabled' });
      console.log('ok');
    } else throw new Error('Unexpected fixture compositor request');
    return;
  }
  if (name === 'grim') {
    if (settings.mode === 'grim-failure') { process.exitCode = 7; return; }
    // A complete one-pixel sentinel, not an actual terminal screenshot.
    writeFileSync(args[2], Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j3n0AAAAASUVORK5CYII=', 'base64'));
    return;
  }
  if (name === 'foot') {
    const output = settings.output, columns = 160, rows = 104;
    save(join(root, 'window.json'), { class: args[args.indexOf('--app-id') + 1], mapped: true,
      stableId: 'fixture-owned-toplevel', address: '0xfixture', size: [1600, 2080] });
    await new Promise(resolve => {
      let painted = false;
      const finish = (event, code = 0) => {
        clearInterval(timer); record({ event }); process.exitCode = code; resolve();
      };
      const timer = setInterval(() => {
        if (existsSync(join(output, 'foot-stop'))) { finish('stopped'); return; }
        if (existsSync(join(output, 'foot-start')) && !existsSync(join(output, 'foot-metrics.json'))) {
          save(join(output, 'foot-metrics.json'), { columns, rows, cellWidth: 10, cellHeight: 20 });
          save(join(output, 'foot-size.json'), { columns, rows });
        }
        if (!painted && existsSync(join(output, 'foot-paint'))) {
          painted = true;
          if (settings.mode === 'missing-ack') { finish('no-ack', 9); return; }
          save(join(output, 'foot-ready.json'), { columns: settings.mode === 'wrong-grid' ? columns - 1 : columns, rows });
        }
      }, 10);
      process.once('SIGTERM', () => finish('terminated', 143));
    });
    return;
  }
  if (name === 'python3') {
    const receipt = args[args.indexOf('--receipt') + 1];
    if (receipt.endsWith('/scope.json')) { save(receipt, { outcome: 'passed' }); return; }
    const output = dirname(receipt);
    if (settings.mode === 'scope-failure') { save(receipt, { outcome: 'failed' }); process.exitCode = 9; return; }
    await new Promise(resolve => {
      const timer = setInterval(() => {}, 1000);
      const stop = signal => {
        clearInterval(timer); record({ event: 'supervisor-stopped', signal });
        save(receipt, { outcome: 'interrupted' }); resolve();
      };
      process.once('SIGINT', stop); process.once('SIGTERM', stop);
      record({ event: 'graphics-live', output });
      console.log('fixture-graphics-live');
    });
    return;
  }
  throw new Error('Unexpected fixture tool: ' + name);
}
