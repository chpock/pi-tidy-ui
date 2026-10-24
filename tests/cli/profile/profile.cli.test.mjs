import '../../fixtures/test-guard.mjs';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { getInstalledIntegrationProfile } from '../../fixtures/integration-profile.mjs';
import { PiTerminal, artifacts, plain, byName } from '../../fixtures/terminal-harness.mjs';
import { closeTerminals } from '../../fixtures/terminal-cleanup.mjs';
import { persisted, compactContent } from '../../fixtures/main-cli-support.mjs';

test('real CLI: installed-profile registrations and real local task renderers',
  { timeout: 120000 }, async (t) => {
    const terminals = [];
    const start = async (name, options = {}) => {
      const terminal = new PiTerminal(name, { profileFactory: getInstalledIntegrationProfile, ...options });
      terminals.push(terminal); await terminal.ready(); return terminal;
    };
    const profile = getInstalledIntegrationProfile({ homeDir: join(tmpdir(), `tidy-ui-profile-probe-${process.pid}`),
      agentDir: join(tmpdir(), `tidy-ui-profile-probe-${process.pid}`, 'agent'),
      workDir: join(tmpdir(), `tidy-ui-profile-probe-${process.pid}`, 'work') });
    mkdirSync(artifacts, { recursive: true });
    writeFileSync(join(artifacts, 'integration-profile-probe.json'), JSON.stringify(profile, null, 2));
    const includedNames = new Set(profile.inventory.filter((entry) => profile.packages.some((pkg) => pkg.source === entry.source))
      .map((entry) => entry.name));
    assert.ok(includedNames.has('@tintinweb/pi-tasks'), 'locked real local task integration is required');
    const registrationGroups = {
      '@tintinweb/pi-subagents': ['Agent'],
      '@tintinweb/pi-tasks': ['TaskCreate', 'TaskList', 'TaskExecute'],
      '@juicesharp/rpiv-ask-user-question': ['ask_user_question'],
      'pi-web-access': ['web_search', 'fetch_content'],
      '@cortexkit/pi-magic-context': ['ctx_memory', 'ctx_search', 'ctx_note', 'ctx_expand'],
    };
    const assertHealthy = (terminal, dump) => {
      for (const [pkg, names] of Object.entries(registrationGroups)) {
        if (!includedNames.has(pkg)) continue;
        for (const name of names) assert.ok(dump.registrations.includes(name), `installed registration: ${name}`);
      }
      assert.deepEqual(terminal.profile.packages, profile.packages, 'load exactly the current eligible audited configured packages');
      assert.deepEqual(terminal.profile.exclusions, profile.exclusions, 'retain the actual preflight exclusions');
      for (const name of ['@cortexkit/aft-pi', '@pedro_klein/pi-caffeinate'])
        assert.ok(!includedNames.has(name), `unsafe audited package remains excluded: ${name}`);
      const output = plain(Buffer.concat(terminal.raw).toString('utf8'));
      assert.doesNotMatch(output, /Extension "[^"\n]+" error:|Failed to load extension|Error loading extension/i,
        'no extension lifecycle errors (inspect stock-profile evidence separately on failure)');
      // Pi's resource diagnostic component colors load errors with the current error role.
      // [Extension issues] also contains harmless manifest warnings, so the heading alone is not a failure.
      const errorColor = dump.errorStyle.split('TERMINAL_ERROR')[0];
      assert.ok(errorColor, 'theme supplies an error style for native diagnostic inspection');
      assert.ok(dump.extensionIssues.flat().every((line) => !line.includes(errorColor)), 'native extension diagnostics contain no load errors');
      assert.equal(terminal.events().filter((e) => ['provider_error', 'unsafe_call_blocked'].includes(e.type)).length, 0);
    };
    const activity = (terminal) => {
      const events = terminal.events();
      assert.equal(events.filter((e) => e.type === 'call').length, 2);
      assert.equal(events.filter((e) => e.type === 'result').length, 2);
      assert.equal(events.filter((e) => e.type === 'model_context').length, 3);
      assert.deepEqual(events.filter((e) => e.type === 'call').map((e) => e.name), ['TaskCreate', 'TaskList']);
      assert.ok(events.filter((e) => e.type === 'result').every((e) => !e.isError));
      return events.filter((e) => ['call', 'result', 'model_context'].includes(e.type));
    };
    try {
      // Stock goes first so pre-existing package incompatibility cannot be blamed on pi-tidy-ui.
      const stock = await start('installed-stock');
      const stockStartup = await stock.capture('startup'); assertHealthy(stock, stockStartup);
      await stock.run('integration'); const control = await stock.capture('collapsed'); assertHealthy(stock, control);
      assert.equal(control.tools.length, 2);
      assert.ok(control.screen.some((line) => line.includes('created successfully')));
      assert.match(byName(control, 'TaskList')[0].content[0].text, /#1 \[pending\] TERMINAL_LOCAL_TASK/);
      const stockActivity = activity(stock);
      await stock.close();
      assert.equal(stock.closed, true, 'completed stock profile is reaped before the patched profile starts');
      const live = await start('installed-tidyUi', { tidyUi: true, workspace: stock.work });
      await live.run('integration'); const compacted = await live.capture('collapsed'); assertHealthy(live, compacted);
      assert.deepEqual(compacted.extensionIssues, control.extensionIssues, 'existing package warnings are identical with and without pi-tidy-ui');
      assert.deepEqual(activity(live), stockActivity, 'same installed-profile calls/results and model-facing contents are unchanged');
      assert.deepEqual(persisted(compacted), persisted(control));
      assert.equal(compacted.tools.length, 2);
      for (const name of ['TaskCreate', 'TaskList']) {
        const tool = byName(compacted, name)[0];
        const rows = compactContent(tool);
        assert.match(rows[0], new RegExp(name));
        assert.doesNotMatch(rows.join(''), /✓|✗/u);
        if (name === 'TaskList') assert.equal(rows.length, 1, 'no-args real task stays single-row');
        const row = compacted.screen.findIndex((line) => line.includes(`⚙ ${name}`));
        assert.ok(row >= 0, `real installed ${name} summary is on screen`);
        assert.equal(compacted.cells[row][compacted.screen[row].indexOf(name)].bgMode, 0);
      }
      assert.ok(!compacted.screen.some((line) => line.includes('created successfully')), 'native task result is hidden while collapsed');
      live.send('\x0f'); await live.settle(); const expanded = await live.capture('expanded');
      assert.ok(expanded.tools.every((tool) => tool.expanded));
      assert.ok(expanded.screen.some((line) => line.includes('created successfully')));
      assert.deepEqual(expanded.tools.map((tool) => tool.content), compacted.tools.map((tool) => tool.content));
      live.send('\x0f'); await live.settle();
      await live.appearance(false); const disabled = await live.capture('disabled'); assertHealthy(live, disabled);
      assert.deepEqual(disabled.tools.map((tool) => tool.content), compacted.tools.map((tool) => tool.content), 'within-profile off preserves actual results');
      assert.deepEqual(disabled.tools.map((tool) => tool.lines), control.tools.map((tool) => tool.lines));
      assert.ok(disabled.screen.some((line) => line.includes('created successfully')));
      await live.close();
      assert.equal(live.closed, true, 'completed patched profile is reaped before replay');
      const replay = await start('installed-stock-replay', { session: compacted.session, workspace: stock.work });
      const nativeReplay = await replay.capture('replay'); assertHealthy(replay, nativeReplay);
      assert.deepEqual(disabled.tools.map((tool) => tool.lines), nativeReplay.tools.map((tool) => tool.lines), 'same-session installed stock renderer is restored exactly');
      await replay.close();
      writeFileSync(join(artifacts, 'integration-coverage.json'), JSON.stringify({
        executed: ['TaskCreate', 'TaskList'], registrations: compacted.registrations,
        stockExtensionDiagnostics: control.extensionIssues, patchedExtensionDiagnostics: compacted.extensionIssues,
        packages: live.profile.inventory.filter((entry) => live.profile.packages.some((p) => p.source === entry.source)),
        exclusions: live.profile.exclusions, limitations: live.profile.limitations,
        rendererCoverage: '@tintinweb/pi-tasks real tools through their registered native/default renderer; other installed tools registration only',
      }, null, 2));
    } finally {
      await closeTerminals(terminals.reverse());
    }
  });
