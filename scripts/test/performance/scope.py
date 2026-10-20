#!/usr/bin/python3
"""One fresh kernel-verified Linux scope; no uncontained execution fallback.

Derived from the exercised local safe-run.py. The outer owner retains the user
bus environment; only the measured command receives the supplied complete map.
"""
import argparse
import datetime
import json
import os
import pathlib
import re
import selectors
import shutil
import signal
import stat
import subprocess
import sys
import tempfile
import time
import uuid
from typing import Any

RAM = 2 * 1024**3
LIMITS = {'memory.max': str(RAM), 'memory.high': str(3 * RAM // 4),
          'memory.swap.max': '0', 'memory.oom.group': '1', 'pids.max': '128'}
COUNTERS = {'memoryPeakBytes': 'memory.peak', 'memoryEvents': 'memory.events',
            'pidsPeak': 'pids.peak', 'pidsEvents': 'pids.events'}
OUTPUT_LIMIT = 1024 * 1024


class UnsupportedPlatformError(RuntimeError):
    pass


def require_linux():
    if sys.platform != 'linux':
        raise UnsupportedPlatformError('Linux systemd/cgroup v2 containment is required')


def validate_request(label, limit, command):
    if not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9-]{0,79}', label):
        raise ValueError('label must be a short ASCII slug')
    if not 1 <= limit <= 300:
        raise ValueError('runtime limit must be between 1 and 300 seconds')
    if (not command or not pathlib.Path(command[0]).is_absolute()
            or any(not isinstance(arg, str) or '\0' in arg for arg in command)):
        raise ValueError('an absolute command and NUL-free arguments are required')


def validate_environment(value):
    if not isinstance(value, dict) or any(
            not isinstance(key, str) or not key or '=' in key or '\0' in key
            or not isinstance(item, str) or '\0' in item for key, item in value.items()):
        raise ValueError('environment must be a complete string map')
    return value


def load_environment(path):
    if path is None:
        return {}
    if not pathlib.Path(path).is_absolute():
        raise ValueError('environment file must be absolute')
    fd = os.open(path, os.O_RDONLY | getattr(os, 'O_NOFOLLOW', 0))
    with os.fdopen(fd, 'r', encoding='utf-8') as stream:
        info = os.fstat(stream.fileno())
        if (not stat.S_ISREG(info.st_mode) or info.st_size > 1024 * 1024
                or (os.name == 'posix' and (stat.S_IMODE(info.st_mode) != 0o600
                                          or info.st_uid != os.getuid()))):
            raise ValueError('environment file must be owned, regular and mode 0600')
        return validate_environment(json.load(stream))


def verify_group(membership, unit, limits):
    if not membership.startswith('0::/') or '\n' in membership:
        raise ValueError('unified cgroup membership required')
    relative = pathlib.PurePosixPath(membership[3:])
    if (relative.name != unit or '..' in relative.parts
            or any(word in str(relative).lower() for word in ('wayland', 'compositor', 'hyprland'))
            or limits != LIMITS):
        raise ValueError('kernel process-tree containment was not established')
    return pathlib.Path('/sys/fs/cgroup') / str(relative).lstrip('/')


def read_group(unit, pid='self'):
    membership = pathlib.Path(f'/proc/{pid}/cgroup').read_text().strip()
    group = pathlib.Path('/sys/fs/cgroup') / membership.split('::', 1)[-1].lstrip('/')
    limits = {name: (group / name).read_text().strip() for name in LIMITS}
    verify_group(membership, unit, limits)
    return membership, group, limits


def parse_events(text):
    result = {}
    for line in text.splitlines():
        key, value = line.split()
        if key in result or not value.isdecimal():
            raise ValueError('invalid cgroup event counter')
        result[key] = int(value)
    return result


def open_counters(group):
    handles = {}
    try:
        for key, name in COUNTERS.items():
            try:
                handles[key] = os.open(group / name, os.O_RDONLY)
            except FileNotFoundError:
                if key != 'pidsPeak':
                    raise
                handles[key] = None
        return handles
    except BaseException:
        close_counters(handles)
        raise


def sample_counters(handles):
    result: dict[str, Any] = {'unavailable': []}
    for key in COUNTERS:
        fd = handles.get(key)
        try:
            if fd is None:
                raise OSError('counter unavailable')
            os.lseek(fd, 0, os.SEEK_SET)
            text = os.read(fd, 65536).decode().strip()
            value = parse_events(text) if key.endswith('Events') else int(text)
            if isinstance(value, int) and value < 0:
                raise ValueError('invalid peak')
            result[key] = value
        except (OSError, ValueError):
            result[key] = None
            result['unavailable'].append(key)
    return result


def close_counters(handles):
    for fd in handles.values():
        if fd is not None:
            try:
                os.close(fd)
            except OSError:
                pass


def failed_limits(sample):
    return bool(sample and ((sample.get('memoryEvents') or {}).get('oom_kill', 0)
                            or (sample.get('pidsEvents') or {}).get('max', 0)))


def write_json(path, value):
    temporary = path.with_name(path.name + '.tmp')
    fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, 'w', encoding='utf-8') as stream:
        json.dump(value, stream, indent=2, allow_nan=False)
        stream.write('\n')
    os.replace(temporary, path)


def claim_receipt(path):
    if not path.is_absolute():
        raise ValueError('receipt must be absolute')
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    os.close(fd)


def scope_result(systemctl, unit):
    try:
        completed = subprocess.run([systemctl, '--user', 'show', unit, '--property=Result', '--value'],
                                   timeout=2, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                                   text=True)
        value = completed.stdout.strip()
        return value if completed.returncode == 0 and value in {
            'success', 'timeout', 'oom-kill', 'signal', 'resources'} else None
    except (OSError, subprocess.TimeoutExpired):
        return None


def stop_scope(systemctl, unit):
    def control(arguments, timeout):
        try:
            return subprocess.run([systemctl, '--user', *arguments, unit], timeout=timeout,
                                  stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode == 0
        except (OSError, subprocess.TimeoutExpired):
            return False
    stopped = control(['stop'], 5)
    explicit_kill = not stopped
    if explicit_kill:
        control(['kill', '--kill-whom=all', '--signal=KILL'], 3)
        stopped = control(['stop'], 3)
    return {'stopped': stopped, 'explicitKill': explicit_kill,
            'scopeResult': scope_result(systemctl, unit)}


def finish_record(record, result, launcher_code, stopped, final_sample, failure):
    record.update(outcome='failed', launcherExitCode=launcher_code, cleanupStopped=stopped,
                  exitCode=result.get('exitCode') if result else None,
                  signal=result.get('signal') if result else None,
                  finalLifetime=final_sample)
    if record.get('scopeResult') == 'timeout':
        record['failure'] = 'timeout'
    elif record.get('scopeResult') == 'oom-kill' or record.get('cleanupScopeResult') == 'oom-kill':
        record['failure'] = 'resource-limit'
    elif failure:
        record['failure'] = failure
    elif not result:
        record['failure'] = 'inner-result-unavailable'
    elif result.get('failure'):
        record['failure'] = result['failure']
    elif not stopped:
        record['failure'] = 'cleanup-failed'
    elif record.get('cleanupExplicitKill'):
        record['failure'] = 'cleanup-forced-kill'
    elif record.get('cleanupScopeResult') == 'timeout':
        record['failure'] = 'cleanup-timeout'
    elif failed_limits(record.get('preCleanup')) or failed_limits(final_sample):
        record['failure'] = 'resource-limit'
    elif result.get('exitCode') == 0 and result.get('signal') is None:
        record['outcome'] = 'passed'
    else:
        record['failure'] = 'command-failed'
    return record


def forward_output(process):
    """Drain both streams, forwarding at most one MiB combined; retain no body."""
    total = forwarded = 0
    with selectors.DefaultSelector() as selector:
        selector.register(process.stdout.fileno(), selectors.EVENT_READ, (process.stdout, sys.stdout.buffer))
        selector.register(process.stderr.fileno(), selectors.EVENT_READ, (process.stderr, sys.stderr.buffer))
        while selector.get_map():
            for key, _ in selector.select():
                source, destination = key.data
                data = os.read(key.fd, 65536)
                if not data:
                    selector.unregister(key.fileobj)
                    source.close()
                    continue
                total += len(data)
                chunk = data[:max(0, OUTPUT_LIMIT - forwarded)]
                forwarded += len(chunk)
                try:
                    destination.write(chunk)
                    destination.flush()
                except (BrokenPipeError, OSError):
                    pass
    return {'bytes': total, 'forwardedBytes': forwarded, 'truncated': total > forwarded}


def inside(args, command):
    require_linux()
    state = pathlib.Path(args.state)
    try:
        membership, group, limits = read_group(args.unit)
        cpus = sorted(os.sched_getaffinity(0))[:2]
        os.sched_setaffinity(0, cpus)
        actual = sorted(os.sched_getaffinity(0))
        if actual != cpus:
            raise RuntimeError('affinity was not established')
        write_json(state / 'ready.json', {'pid': os.getpid(), 'cgroup': membership,
                                         'limits': limits, 'cpus': actual})
        deadline = time.monotonic() + 10
        while not (state / 'go').exists():
            if time.monotonic() > deadline:
                raise TimeoutError('outer handshake unavailable')
            time.sleep(0.02)
        # The map was validated and privately copied before starting this scope.
        environment = load_environment(str(state / 'env.json'))
        start = time.monotonic()
        process = subprocess.Popen(command, env=environment, stdin=subprocess.DEVNULL,
                                   stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        output = forward_output(process)
        code = process.wait()
        write_json(state / 'result.json', {'exitCode': code if code >= 0 else None,
                                          'signal': -code if code < 0 else None,
                                          'elapsedSeconds': time.monotonic() - start,
                                          'output': output})
        # Keep the cgroup alive until the outer owner has captured pre-cleanup
        # counters. Its systemctl stop then terminates every remaining descendant.
        while True:
            time.sleep(1)
    except Exception as error:
        write_json(state / 'result.json', {'failure': 'inner-' + type(error).__name__,
                                          'exitCode': None, 'signal': None})
        return 1


def interrupted(signum, frame):
    raise InterruptedError(signum)


def outside(args, command):
    receipt = pathlib.Path(args.receipt)
    claim_receipt(receipt)
    started = time.monotonic()
    record = {'schema': 1, 'label': args.label, 'outcome': 'running',
              'startedUtc': datetime.datetime.now(datetime.timezone.utc).isoformat(),
              'limitSeconds': args.limit_seconds, 'stopGraceSeconds': 2,
              'outputLimitBytes': OUTPUT_LIMIT,
              'peakSemantics': 'whole-scope accounted memory, including launcher and cleanup; not target RSS or phase peak'}
    write_json(receipt, record)
    process = None
    handles = {}
    result = None
    failure = None
    stopped = False
    systemctl = None
    unit = 'tidy-ui-perf-' + uuid.uuid4().hex + '.scope'
    previous = {}
    try:
        validate_request(args.label, args.limit_seconds, command)
        require_linux()
        environment = load_environment(args.env_file)
        systemd_run = shutil.which('systemd-run')
        systemctl = shutil.which('systemctl')
        if not systemd_run or not systemctl:
            raise RuntimeError('systemd user controls unavailable')
        for sig in (signal.SIGINT, signal.SIGTERM):
            previous[sig] = signal.signal(sig, interrupted)
        with tempfile.TemporaryDirectory(prefix='tidy-perf-scope-') as directory:
            state = pathlib.Path(directory)
            write_json(state / 'env.json', environment)
            call = [systemd_run, '--user', '--scope', '--quiet', '--unit=' + unit,
                    '--property=MemoryAccounting=yes', '--property=MemoryHigh=' + LIMITS['memory.high'],
                    '--property=MemoryMax=' + LIMITS['memory.max'], '--property=MemorySwapMax=0',
                    '--property=OOMPolicy=kill', '--property=TasksMax=128',
                    '--property=TimeoutStopSec=2',
                    '--property=RuntimeMaxSec=' + str(args.limit_seconds),
                    sys.executable, '-I', '-S', str(pathlib.Path(__file__).resolve()),
                    '--inside', '--unit', unit, '--state', directory,
                    '--label', args.label, '--limit-seconds', str(args.limit_seconds), '--', *command]
            try:
                process = subprocess.Popen(call, stdin=subprocess.DEVNULL)
                deadline = started + min(args.limit_seconds + 5, 15)
                while not (state / 'ready.json').exists():
                    if process.poll() is not None:
                        raise RuntimeError('scope-start-failed')
                    if time.monotonic() >= deadline:
                        raise TimeoutError('scope-handshake-timeout')
                    time.sleep(0.02)
                ready = json.loads((state / 'ready.json').read_text())
                membership, group, limits = read_group(unit, ready['pid'])
                if membership != ready['cgroup'] or limits != ready['limits']:
                    raise RuntimeError('scope-handshake-mismatch')
                cpus = sorted(os.sched_getaffinity(ready['pid']))
                if cpus != sorted(os.sched_getaffinity(0))[:2] or cpus != ready['cpus']:
                    raise RuntimeError('scope-affinity-mismatch')
                record.update(unit=unit, cgroup=membership, limits=limits, cpus=cpus)
                handles = open_counters(group)
                (state / 'go').touch(mode=0o600)
                deadline = started + args.limit_seconds + 5
                while not (state / 'result.json').exists():
                    if process.poll() is not None:
                        raise RuntimeError('inner-result-unavailable')
                    if time.monotonic() >= deadline:
                        raise TimeoutError('scope-runtime-timeout')
                    time.sleep(0.05)
                result = json.loads((state / 'result.json').read_text())
                record['preCleanup'] = sample_counters(handles)
                record['targetElapsedSeconds'] = result.get('elapsedSeconds')
                record['output'] = result.get('output')
            finally:
                # Ignore repeated interrupts only during bounded whole-unit cleanup.
                for sig in previous:
                    signal.signal(sig, signal.SIG_IGN)
                if handles and 'preCleanup' not in record:
                    record['preCleanup'] = sample_counters(handles)
                record['scopeResult'] = scope_result(systemctl, unit)
                cleanup = stop_scope(systemctl, unit)
                stopped = cleanup['stopped']
                record['cleanupExplicitKill'] = cleanup['explicitKill']
                record['cleanupScopeResult'] = cleanup['scopeResult']
                if process is not None:
                    try:
                        process.wait(timeout=3)
                    except subprocess.TimeoutExpired:
                        process.kill()
                        process.wait(timeout=3)
    except UnsupportedPlatformError:
        failure = 'unsupported-platform'
    except InterruptedError:
        failure = 'interrupted'
    except TimeoutError:
        failure = 'timeout'
    except Exception as error:
        failure = 'scope-' + type(error).__name__
    finally:
        final_sample = sample_counters(handles) if handles else None
        close_counters(handles)
        for sig, handler in previous.items():
            signal.signal(sig, handler)
        code = process.returncode if process is not None else None
        # The inner supervisor deliberately stays until whole-group teardown;
        # preserve its real exit separately from the measured command's exit.
        record['elapsedSeconds'] = time.monotonic() - started
        write_json(receipt, finish_record(record, result, code, stopped, final_sample, failure))
    return 0 if record['outcome'] == 'passed' else 1


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--receipt')
    parser.add_argument('--label', required=True)
    parser.add_argument('--limit-seconds', type=int, default=300)
    parser.add_argument('--env-file')
    parser.add_argument('--inside', action='store_true', help=argparse.SUPPRESS)
    parser.add_argument('--unit', help=argparse.SUPPRESS)
    parser.add_argument('--state', help=argparse.SUPPRESS)
    parser.add_argument('command', nargs=argparse.REMAINDER)
    args = parser.parse_args()
    command = args.command[1:] if args.command[:1] == ['--'] else args.command
    if args.inside:
        validate_request(args.label, args.limit_seconds, command)
        if not args.unit or not args.state:
            parser.error('internal scope handshake required')
        return inside(args, command)
    if not args.receipt:
        parser.error('--receipt is required')
    return outside(args, command)


if __name__ == '__main__':
    sys.exit(main())
