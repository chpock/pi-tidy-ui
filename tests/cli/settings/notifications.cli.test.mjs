import '../../fixtures/test-guard.mjs';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { PiTerminal, plain, until } from '../../fixtures/terminal-harness.mjs';
import { closeTerminals } from '../../fixtures/terminal-cleanup.mjs';
import { persisted, traffic } from '../../fixtures/main-cli-support.mjs';

for (const mode of ['regular', 'fullscreen']) test(`notifications: real prefixed error/warning and unchanged foreign info (${mode})`,
  { timeout: 60000 }, async () => {
    const live = new PiTerminal(`notification-prefix-${mode}`, { tidyUi: true, mode,
      tidyUiSettings: { syntaxTheme: { kind: 'theme', id: 'unavailable-notification-family' }, nativeHighlightingEnabled: false },
      extraEnv: { TIDY_UI_TEST_NOTIFICATIONS: '1' } });
    const notices = () => live.events().filter(event => event.type === 'notification');
    const missing = () => notices().filter(event => event.message.includes('Syntax theme'));
    try {
      await live.ready(); await live.resize(120, 60); await live.run('user-card');
      const initial = await live.capture('notification-error'), session = readFileSync(initial.session), originalTraffic = traffic(live, 2);
      const config = join(live.agent, 'extensions/pi-tidy-ui/config.json'), saved = readFileSync(config);
      assert.equal(missing().length, 1);
      assert.equal(missing()[0].level, 'error');
      assert.equal(missing()[0].message, '[pi-tidy-ui] Syntax theme "unavailable-notification-family" is unavailable; using Pi palette temporarily.');
      assert.ok(initial.screen.map(plain).join('\n').includes('[pi-tidy-ui] Syntax theme'), 'the source prefix is physically rendered by Pi');
      await live.command('/tidy-ui on');
      await until(() => notices().some(event => event.level === 'warning' && event.message.startsWith('[pi-tidy-ui] Usage: /tidy-ui')), 'the real command warning is attributed');
      const warning = await live.capture('notification-warning');
      assert.ok(warning.screen.map(plain).join('\n').includes('[pi-tidy-ui] Usage: /tidy-ui'));
      await live.command('/tidy-ui-theme dark');
      await until(() => notices().some(event => event.message === 'TERMINAL_THEME dark' && event.level === 'info'), 'another extension’s notification is not prefixed');
      await live.command('/reload'); await live.capture('notification-reload');
      assert.equal(missing().length, 2, 'each runtime delivers one missing-theme episode, without stacked observers');
      assert.ok(missing().every(event => event.message.startsWith('[pi-tidy-ui] Syntax theme')));
      assert.deepEqual(readFileSync(config), saved); assert.deepEqual(readFileSync(initial.session), session);
      assert.deepEqual(traffic(live, 2), originalTraffic);
      const final = await live.capture('notification-final'); assert.deepEqual(persisted(final), persisted(initial));
    } finally { await closeTerminals([live]); }
  });
