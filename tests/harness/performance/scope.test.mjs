import '../../fixtures/test-guard.mjs';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { toolPath } from '../../../scripts/test/context.mjs';

const modulePath = fileURLToPath(new URL('../../../scripts/test/scope_core.py', import.meta.url));
function python(body) {
  const child = spawnSync(toolPath('python3'), ['-B', '-I', '-S', '-c', `
import importlib.util, json, os, pathlib, tempfile, types
spec = importlib.util.spec_from_file_location('scope', ${JSON.stringify(modulePath)})
scope = importlib.util.module_from_spec(spec)
spec.loader.exec_module(scope)
${body}
`], { encoding: 'utf8', timeout: 15000, maxBuffer: 128 * 1024 });
  assert.ifError(child.error);
  assert.equal(child.signal, null);
  assert.equal(child.status, 0, child.stderr);
  return child.stdout.trim();
}

test('performance scope validates fixed safety inputs and complete child environments', () => {
  python(`
for label, limit, command in [('bad/name', 1, ['/bin/true']), ('ok', 0, ['/bin/true']), ('ok', 301, ['/bin/true']), ('ok', 1, ['relative']), ('ok', 1, ['/bin/true', '\\0'])]:
    try: scope.validate_request(label, limit, command)
    except ValueError: pass
    else: raise AssertionError('invalid launch accepted')
scope.validate_request('smoke-1', 300, [scope.sys.executable, 'argument'])
assert scope.validate_environment({'HOME': '/owned', 'NODE_OPTIONS': '--expose-gc'}) == {'HOME': '/owned', 'NODE_OPTIONS': '--expose-gc'}
for value in [[], {'KEY': 1}, {'A=B': 'x'}, {'': 'x'}, {'KEY': '\\0'}]:
    try: scope.validate_environment(value)
    except ValueError: pass
    else: raise AssertionError('invalid environment accepted')
os.environ['SCOPE_SECRET'] = 'must-not-leak'
assert scope.load_environment(None) == {}
with tempfile.TemporaryDirectory() as directory:
    path = pathlib.Path(directory) / 'env.json'
    path.write_text('{"HOME":"/owned"}')
    path.chmod(0o600)
    assert scope.load_environment(str(path)) == {'HOME': '/owned'}
    if os.name == 'posix':
        path.chmod(0o644)
        try: scope.load_environment(str(path))
        except ValueError: pass
        else: raise AssertionError('public environment file accepted')
`);
});

test('performance scope verifies exact kernel limits and separate unified membership', () => {
  python(`
limits = dict(scope.LIMITS)
scope.verify_group('0::/user.slice/test.scope', 'test.scope', limits)
for membership, unit, values in [('0::/wayland-wm/test.scope', 'test.scope', limits), ('0::/user.slice/other.scope', 'test.scope', limits), ('0::/user.slice/test.scope/nested', 'test.scope', limits), ('1:memory:/test.scope', 'test.scope', limits), ('0::/../test.scope', 'test.scope', limits), ('0::/user.slice/test.scope', 'test.scope', dict(limits, **{'memory.high': 'max'})), ('0::/user.slice/test.scope', 'test.scope', dict(limits, **{'memory.oom.group': '0'}))]:
    try: scope.verify_group(membership, unit, values)
    except ValueError: pass
    else: raise AssertionError('unsafe containment accepted')
old = scope.sys.platform
scope.sys.platform = 'win32'
try:
    try: scope.require_linux()
    except RuntimeError: pass
    else: raise AssertionError('unsupported launch accepted')
finally: scope.sys.platform = old
`);
});

test('performance scope reads peak and event counters without inventing removed-group values', () => {
  python(`
with tempfile.TemporaryDirectory() as directory:
    group = pathlib.Path(directory)
    for name, value in {'memory.peak': '1234', 'memory.events': 'oom 0\\noom_kill 0\\nmax 3\\n', 'pids.events': 'max 0\\n'}.items():
        (group / name).write_text(value)
    handles = scope.open_counters(group)
    try:
        sample = scope.sample_counters(handles)
        assert sample['memoryPeakBytes'] == 1234
        assert sample['memoryEvents'] == {'oom': 0, 'oom_kill': 0, 'max': 3}
        assert sample['pidsPeak'] is None
        assert sample['unavailable'] == ['pidsPeak']
        os.close(handles['memoryPeakBytes'])
        handles['memoryPeakBytes'] = None
        sample = scope.sample_counters(handles)
        assert sample['memoryPeakBytes'] is None
        assert 'memoryPeakBytes' in sample['unavailable']
    finally: scope.close_counters(handles)
for invalid in ['oom -1', 'oom nope', 'oom 0\\noom 1']:
    try: scope.parse_events(invalid)
    except ValueError: pass
    else: raise AssertionError('invalid counters accepted')
`);
});

test('performance scope cleanup stops the fresh unit and cannot report failed teardown as success', () => {
  python(`
calls = []
def run(command, **options):
    calls.append(command)
    return types.SimpleNamespace(returncode=0)
original = scope.subprocess.run
scope.subprocess.run = run
scope.scope_result = lambda *a: None
try:
    assert scope.stop_scope('/systemctl', 'unique.scope') == {'stopped': True, 'explicitKill': False, 'scopeResult': None}
    assert calls == [['/systemctl', '--user', 'stop', 'unique.scope']]
    scope.subprocess.run = lambda *a, **k: types.SimpleNamespace(returncode=1)
    assert scope.stop_scope('/systemctl', 'unique.scope') == {'stopped': False, 'explicitKill': True, 'scopeResult': None}
    def timeout(*a, **k): raise scope.subprocess.TimeoutExpired('systemctl', 10)
    scope.subprocess.run = timeout
    assert scope.stop_scope('/systemctl', 'unique.scope') == {'stopped': False, 'explicitKill': True, 'scopeResult': None}
finally: scope.subprocess.run = original
assert scope.failed_limits({'memoryEvents': {'oom_kill': 1}, 'pidsEvents': {'max': 0}})
assert scope.failed_limits({'memoryEvents': {'oom_kill': 0}, 'pidsEvents': {'max': 1}})
assert not scope.failed_limits({'memoryEvents': {'oom_kill': 0}, 'pidsEvents': {'max': 0}})
`);
});

test('performance scope lost inner outcomes, interruptions and failed cleanup preserve failed outer receipts', () => {
  python(`
for result, cleanup in [(None, True), ({'exitCode': 0, 'signal': None}, False), ({'exitCode': 7, 'signal': None}, True), ({'exitCode': None, 'signal': 15}, True)]:
    record = scope.finish_record({'outcome': 'running'}, result, 0, cleanup, None, None)
    assert record['outcome'] == 'failed'
record = scope.finish_record({'outcome': 'running'}, {'exitCode': 0, 'signal': None}, 0, True, None, None)
assert record['outcome'] == 'passed'
with tempfile.TemporaryDirectory() as directory:
    receipt = pathlib.Path(directory) / 'receipt.json'
    scope.claim_receipt(receipt)
    scope.write_json(receipt, scope.finish_record({'outcome': 'running'}, None, -15, True, None, 'interrupted'))
    assert json.loads(receipt.read_text())['outcome'] == 'failed'
    try: scope.claim_receipt(receipt)
    except FileExistsError: pass
    else: raise AssertionError('existing evidence overwritten')
`);
});

test('performance scope drains bounded output and preserves the measured exit signal', () => {
  python(`
import io
original_stdout, original_stderr = scope.sys.stdout, scope.sys.stderr
out, err = io.BytesIO(), io.BytesIO()
scope.sys.stdout = types.SimpleNamespace(buffer=out)
scope.sys.stderr = types.SimpleNamespace(buffer=err)
# Selectable anonymous pipes are Linux-only; use harmless controlled pipe doubles
# on every host instead of requesting unsupported containment.
class Selector:
    def __enter__(self): return self
    def __exit__(self, *args): pass
    def register(self, fd, events, data): self.entries[fd] = types.SimpleNamespace(fd=fd, fileobj=fd, data=data)
    def unregister(self, fd): del self.entries[fd]
    def get_map(self): return self.entries
    def select(self): return [(next(iter(self.entries.values())), None)]
    def __init__(self): self.entries = {}
streams = {10: iter([b'a' * 700000, b'b' * 700000, b'']), 11: iter([b'c' * 700000, b''])}
class Pipe:
    def __init__(self, fd): self.fd, self.closed = fd, False
    def fileno(self): return self.fd
    def close(self): self.closed = True
process = types.SimpleNamespace(stdout=Pipe(10), stderr=Pipe(11))
original_read, original_selector = scope.os.read, scope.selectors.DefaultSelector
scope.os.read = lambda fd, size: next(streams[fd])
scope.selectors.DefaultSelector = Selector
try:
    result = scope.forward_output(process)
finally:
    scope.os.read, scope.selectors.DefaultSelector = original_read, original_selector
    scope.sys.stdout, scope.sys.stderr = original_stdout, original_stderr
assert result == {'bytes': 2100000, 'forwardedBytes': scope.OUTPUT_LIMIT, 'truncated': True}
assert len(out.getvalue()) + len(err.getvalue()) == scope.OUTPUT_LIMIT
assert process.stdout.closed and process.stderr.closed
assert scope.finish_record({}, {'exitCode': None, 'signal': 9}, -15, True, None, None)['signal'] == 9
`);
});

test('performance scope never starts a target before kernel verification', () => {
  python(`
with tempfile.TemporaryDirectory() as directory:
    args = types.SimpleNamespace(state=directory, unit='test.scope')
    scope.require_linux = lambda: None
    def reject(unit): raise ValueError('unsafe containment')
    scope.read_group = reject
    calls = []
    scope.subprocess.Popen = lambda *a, **k: calls.append('unsafe launch')
    assert scope.inside(args, [scope.sys.executable]) == 1
    assert len(calls) == 0
    assert json.loads((pathlib.Path(directory) / 'result.json').read_text())['failure'] == 'inner-ValueError'
`);
});

test('performance scope outer owner persists failures and stops the scope after an interrupted handshake', () => {
  python(`
with tempfile.TemporaryDirectory() as directory:
    receipt = pathlib.Path(directory) / 'receipt.json'
    args = types.SimpleNamespace(receipt=str(receipt), label='control', limit_seconds=3, env_file=None)
    scope.require_linux = lambda: None
    scope.shutil.which = lambda name: str(pathlib.Path(directory) / name)
    calls = []
    class Launcher:
        returncode = None
        def poll(self): raise InterruptedError()
        def wait(self, timeout): self.returncode = -15
    scope.subprocess.Popen = lambda *a, **k: Launcher()
    scope.scope_result = lambda *a: None
    scope.stop_scope = lambda tool, unit: calls.append(unit) or {'stopped': True, 'explicitKill': False, 'scopeResult': None}
    assert scope.outside(args, [scope.sys.executable]) == 1
    result = json.loads(receipt.read_text())
    assert result['outcome'] == 'failed' and result['failure'] == 'interrupted'
    assert result['cleanupStopped'] is True and len(calls) == 1
    assert result['launcherExitCode'] == -15
    assert result['finalLifetime'] is None
    assert 'env' not in result and 'command' not in result
`);
});

test('performance scope reports systemd timeout and OOM results without opaque control output', () => {
  python(`
for value, expected in [('timeout\\n', 'timeout'), ('oom-kill\\n', 'oom-kill'), ('untrusted raw text', None)]:
    scope.subprocess.run = lambda *a, **k: types.SimpleNamespace(returncode=0, stdout=value)
    assert scope.scope_result('/systemctl', 'unique.scope') == expected
assert scope.finish_record({'scopeResult': 'timeout'}, None, -15, True, None, None)['failure'] == 'timeout'
assert scope.finish_record({'scopeResult': 'oom-kill'}, None, -9, True, None, None)['failure'] == 'resource-limit'
assert scope.finish_record({'cleanupScopeResult': 'timeout'}, {'exitCode': 0}, -15, True, None, None)['failure'] == 'cleanup-timeout'
assert scope.finish_record({'cleanupExplicitKill': True}, {'exitCode': 0}, -15, True, None, None)['failure'] == 'cleanup-forced-kill'
`);
});

test('performance scope actual launch fails explicitly on unsupported platforms without starting a process', () => {
  python(`
with tempfile.TemporaryDirectory() as directory:
    receipt = pathlib.Path(directory) / 'receipt.json'
    args = types.SimpleNamespace(receipt=str(receipt), label='unsupported', limit_seconds=1, env_file=None)
    calls = []
    scope.subprocess.Popen = lambda *a, **k: calls.append('unsafe launch')
    scope.sys.platform = 'win32'
    assert scope.outside(args, [scope.sys.executable]) == 1
    record = json.loads(receipt.read_text())
    assert record['outcome'] == 'failed' and record['failure'] == 'unsupported-platform'
    assert len(calls) == 0
`);
});


test('performance scope cannot accept OOM first observed during cleanup with unavailable final counters', () => {
  python(`
record = {'scopeResult': 'success', 'cleanupScopeResult': 'oom-kill',
          'preCleanup': {'memoryEvents': {'oom_kill': 0}, 'pidsEvents': {'max': 0}}}
result = scope.finish_record(record, {'exitCode': 0, 'signal': None}, -15, True,
                            {'memoryPeakBytes': None, 'memoryEvents': None, 'pidsEvents': None, 'unavailable': ['memoryEvents']}, None)
assert result['outcome'] == 'failed'
assert result['failure'] == 'resource-limit'
`);
});

test('performance scope successful verified startup replaces inherited environment before target launch', () => {
  python(`
class Finished(BaseException): pass
for environment in [{}, {'HOME': '/owned', 'SAFE': 'explicit'}]:
    with tempfile.TemporaryDirectory() as directory:
        state = pathlib.Path(directory)
        (state / 'go').touch()
        scope.write_json(state / 'env.json', environment)
        scope.require_linux = lambda: None
        scope.read_group = lambda unit: ('0::/user.slice/owned.scope', state, dict(scope.LIMITS))
        scope.os.sched_getaffinity = lambda pid: {0, 1}
        scope.os.sched_setaffinity = lambda pid, cpus: None
        os.environ['SCOPE_SECRET'] = 'must-not-leak'
        os.environ['NODE_OPTIONS'] = '--invalid-startup-option'
        launches = []
        def launch(command, **options):
            assert (state / 'ready.json').exists()
            launches.append((command, options))
            return types.SimpleNamespace(wait=lambda: 0)
        scope.subprocess.Popen = launch
        scope.forward_output = lambda process: {'bytes': 0, 'forwardedBytes': 0, 'truncated': False}
        def finish(seconds): raise Finished()
        scope.time.sleep = finish
        try: scope.inside(types.SimpleNamespace(state=directory, unit='owned.scope'), [scope.sys.executable])
        except Finished: pass
        assert len(launches) == 1
        assert launches[0][1]['env'] == environment
        assert 'SCOPE_SECRET' not in launches[0][1]['env']
        assert 'NODE_OPTIONS' not in launches[0][1]['env']
        assert json.loads((state / 'result.json').read_text())['exitCode'] == 0
`);
});

test('direct shared-core controls do not write bytecode into a cold copied source', () => {
  python(`
assert scope.sys.dont_write_bytecode
with tempfile.TemporaryDirectory() as directory:
    target = pathlib.Path(directory) / 'scope_core.py'
    target.write_bytes(pathlib.Path(${JSON.stringify(modulePath)}).read_bytes())
    cold_spec = importlib.util.spec_from_file_location('cold_scope', target)
    cold_scope = importlib.util.module_from_spec(cold_spec)
    cold_spec.loader.exec_module(cold_scope)
    assert sorted(path.name for path in pathlib.Path(directory).iterdir()) == ['scope_core.py']
`);
});
