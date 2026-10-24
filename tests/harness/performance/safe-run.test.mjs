import '../../fixtures/test-guard.mjs';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { toolPath } from '../../../scripts/test/context.mjs';

const ordinaryPath = fileURLToPath(new URL('../../../scripts/test/safe-run.py', import.meta.url));
const benchmarkPath = fileURLToPath(new URL('../../../scripts/test/performance/scope.py', import.meta.url));
function python(body) {
  const child = spawnSync(toolPath('python3'), ['-I', '-S', '-c', `
import importlib.util, json, os, pathlib, sys, tempfile, types
sys.dont_write_bytecode = True

def load(path):
    spec = importlib.util.spec_from_file_location('entry', path)
    entry = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(entry)
    return entry
ordinary = load(${JSON.stringify(ordinaryPath)})
benchmark = load(${JSON.stringify(benchmarkPath)})
${body}
`], { encoding: 'utf8', timeout: 15000, maxBuffer: 128 * 1024 });
  assert.ifError(child.error);
  assert.equal(child.signal, null);
  assert.equal(child.status, 0, child.stderr);
  return child.stdout.trim();
}

test('safe-run: isolated entry policies keep ordinary and benchmark deadlines and affinity separate', () => {
  python(`
for entry, maximum, pinned, exposed in [(ordinary, 600, False, True), (benchmark, 300, True, False)]:
    calls = []
    entry.scope.outside = lambda args, command, **policy: calls.append((args, command, policy)) or 0
    sys.argv = ['entry', '--label', 'control', '--receipt', '/receipt', '--', sys.executable]
    assert entry.main() == 0
    args, command, policy = calls.pop()
    assert args.limit_seconds == 300 and command == [sys.executable]
    assert policy['max_seconds'] == maximum
    assert policy['pin_cpus'] is pinned and policy['expose_receipt'] is exposed
    entry.scope.validate_request('control', maximum, command, max_seconds=maximum)
    try: entry.scope.validate_request('control', maximum + 1, command, max_seconds=maximum)
    except ValueError: pass
    else: raise AssertionError('deadline cap widened')
`);
});

test('safe-run: trusted entry loading ignores caller module paths and startup customizers', () => {
  python(`
import subprocess
with tempfile.TemporaryDirectory() as directory:
    root = pathlib.Path(directory)
    marker = root / 'polluted'
    for name in ['scope_core.py', 'sitecustomize.py', 'usercustomize.py']:
        (root / name).write_text('open(' + repr(str(marker)) + ', "w").write("polluted")')
    for path in [${JSON.stringify(ordinaryPath)}, ${JSON.stringify(benchmarkPath)}]:
        child = subprocess.run([sys.executable, '-I', '-S', path, '--help'], cwd=root,
                               env={'PYTHONPATH': directory, 'PYTHONSTARTUP': str(root / 'sitecustomize.py')},
                               stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=3)
        assert child.returncode == 0
        assert b'--limit-seconds' in child.stdout
        assert not marker.exists()
`);
});

test('safe-run: ordinary inner keeps the inherited CPU set and launches only the explicit environment', () => {
  python(`
scope = ordinary.scope
class Finished(BaseException): pass
with tempfile.TemporaryDirectory() as directory:
    state = pathlib.Path(directory)
    (state / 'go').touch()
    environment = {'TIDY_TEST_SCOPE_RECEIPT': '/verified-receipt.json'}
    scope.write_json(state / 'env.json', environment)
    scope.require_linux = lambda: None
    scope.read_group = lambda unit: ('0::/user.slice/owned.scope', state, dict(scope.LIMITS))
    scope.os.sched_getaffinity = lambda pid: {2, 4, 6, 8}
    def reject_pin(*args): raise AssertionError('ordinary affinity changed')
    scope.os.sched_setaffinity = reject_pin
    os.environ['DBUS_SESSION_BUS_ADDRESS'] = 'outer-only'
    os.environ['NODE_OPTIONS'] = '--invalid-option'
    launches = []
    scope.subprocess.Popen = lambda command, **options: launches.append(options) or types.SimpleNamespace(wait=lambda: 0)
    scope.forward_output = lambda process: {'bytes': 0, 'forwardedBytes': 0, 'truncated': False}
    def finish(seconds): raise Finished()
    scope.time.sleep = finish
    try: scope.inside(types.SimpleNamespace(state=directory, unit='owned.scope'), [sys.executable], pin_cpus=False)
    except Finished: pass
    assert len(launches) == 1 and launches[0]['env'] == environment
    assert json.loads((state / 'ready.json').read_text())['cpus'] == [2, 4, 6, 8]
`);
});

test('safe-run: both entries verify their CPU policy and publish resource receipts before releasing the target', () => {
  python(`
for pinned, mismatch, explicit in [(False, False, False), (False, False, True), (False, True, False), (True, False, False), (True, False, True), (True, True, False)]:
    scope = load(${JSON.stringify(ordinaryPath)}).scope
    with tempfile.TemporaryDirectory() as directory:
        root = pathlib.Path(directory)
        receipt = root / 'receipt.json'
        env_file = root / 'explicit.json'
        scope.write_json(env_file, {'SAFE': 'explicit', 'TIDY_TEST_SCOPE_RECEIPT': 'untrusted'})
        maximum = 300 if pinned else 600
        cpus = [2, 4] if pinned else [2, 4, 6, 8]
        entry = ${JSON.stringify(benchmarkPath)} if pinned else ${JSON.stringify(ordinaryPath)}
        args = types.SimpleNamespace(receipt=str(receipt), label='control', limit_seconds=maximum, env_file=str(env_file) if explicit else None)
        expected_environment = {'SAFE': 'explicit', 'TIDY_TEST_SCOPE_RECEIPT': 'untrusted'} if explicit else {}
        if not pinned:
            expected_environment['TIDY_TEST_SCOPE_RECEIPT'] = str(receipt)
        scope.require_linux = lambda: None
        scope.shutil.which = lambda name: '/' + name
        scope.os.sched_getaffinity = lambda pid: {2, 4, 6, 8} if pid == 0 else set(cpus)
        scope.open_counters = lambda group: {'fake': 1}
        sample = {'memoryPeakBytes': 1234, 'memoryEvents': {'oom_kill': 0}, 'pidsPeak': 3, 'pidsEvents': {'max': 0}, 'unavailable': []}
        scope.sample_counters = lambda handles: dict(sample)
        scope.close_counters = lambda handles: None
        scope.scope_result = lambda *args: 'success'
        stops = []
        scope.stop_scope = lambda tool, unit: stops.append(unit) or {'stopped': True, 'explicitKill': False, 'scopeResult': 'success'}
        calls = []
        class Launcher:
            returncode = None
            def poll(self): return None
            def wait(self, timeout): self.returncode = -15
        def launch(command, **options):
            calls.append(command)
            state = pathlib.Path(command[command.index('--state') + 1])
            unit = next(arg[7:] for arg in command if arg.startswith('--unit='))
            membership = '0::/user.slice/' + unit
            scope.read_group = lambda requested, pid: (membership, state, dict(scope.LIMITS))
            scope.write_json(state / 'ready.json', {'pid': 123, 'cgroup': membership, 'limits': dict(scope.LIMITS), 'cpus': [2] if mismatch else cpus})
            return Launcher()
        scope.subprocess.Popen = launch
        original_touch = pathlib.Path.touch
        released = []
        def touch(path, *a, **kw):
            if path.name == 'go':
                running = json.loads(receipt.read_text())
                assert running['outcome'] == 'running' and running['limits'] == scope.LIMITS
                assert running['cpus'] == cpus and running['cgroup'].endswith('.scope')
                assert json.loads((path.parent / 'env.json').read_text()) == expected_environment
                released.append(True)
                scope.write_json(path.parent / 'result.json', {'exitCode': 0, 'signal': None, 'elapsedSeconds': 0.01, 'output': {}})
            return original_touch(path, *a, **kw)
        pathlib.Path.touch = touch
        try:
            code = scope.outside(args, [sys.executable], max_seconds=maximum, pin_cpus=pinned, expose_receipt=not pinned, entry_path=entry)
        finally: pathlib.Path.touch = original_touch
        result = json.loads(receipt.read_text())
        assert len(calls) == 1 and len(stops) == 1
        assert bool(released) is not mismatch
        assert code == (1 if mismatch else 0)
        assert result['outcome'] == ('failed' if mismatch else 'passed')
        assert 'command' not in result and 'env' not in result
        if not mismatch:
            assert result['preCleanup'] == sample and result['finalLifetime'] == sample
            assert result['cleanupStopped'] is True and result['limitSeconds'] == maximum
            call = calls[0]
            assert call[call.index(sys.executable) + 1:call.index(sys.executable) + 3] == ['-I', '-S']
            assert entry in call
`);
});

test('safe-run: over-limit ordinary admission never starts a scope or target', () => {
  python(`
scope = ordinary.scope
with tempfile.TemporaryDirectory() as directory:
    args = types.SimpleNamespace(receipt=str(pathlib.Path(directory) / 'receipt.json'), label='control', limit_seconds=601, env_file=None)
    calls = []
    scope.subprocess.Popen = lambda *a, **kw: calls.append(True)
    assert scope.outside(args, [sys.executable], max_seconds=600, pin_cpus=False, expose_receipt=True) == 1
    result = json.loads(pathlib.Path(args.receipt).read_text())
    assert not calls and result['outcome'] == 'failed'
    assert result['failure'] == 'scope-ValueError'
`);
});

test('safe-run: cold shared-guard loading never adds bytecode to prepared source snapshots', () => {
  python(`
import shutil, subprocess
with tempfile.TemporaryDirectory() as directory:
    root = pathlib.Path(directory)
    (root / 'performance').mkdir()
    shutil.copy2(${JSON.stringify(ordinaryPath)}, root / 'safe-run.py')
    shutil.copy2(${JSON.stringify(benchmarkPath)}, root / 'performance' / 'scope.py')
    shutil.copy2(pathlib.Path(${JSON.stringify(ordinaryPath)}).parent / 'scope_core.py', root / 'scope_core.py')
    for entry in [root / 'safe-run.py', root / 'performance' / 'scope.py']:
        child = subprocess.run([sys.executable, '-I', '-S', str(entry), '--help'],
                               env={}, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=3)
        assert child.returncode == 0
        assert not list(root.rglob('__pycache__')), 'guard loading modified the source snapshot'
`);
});
