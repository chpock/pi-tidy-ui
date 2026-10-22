"""Small JSON-lines PTY transport; all terminal bytes remain unmodified."""
import base64
import errno
import fcntl
import json
import os
import pty
import select
import signal
import shlex
import struct
import sys
import termios
import time


def emit(message):
    print(json.dumps(message), flush=True)


def main():
    cols, rows = int(sys.argv[1]), int(sys.argv[2])
    cwd, command = sys.argv[3], sys.argv[4:]
    job_shell = os.environ.get("TIDY_UI_TEST_JOB_SHELL")
    job_file = os.environ["TIDY_UI_TEST_JOB_FILE"] if job_shell else ""
    launch = [sys.executable, "-I", "-S", __file__, "--job-child", job_file, *command]
    pid, master = pty.fork()
    if pid == 0:
        os.chdir(cwd)
        if job_shell:
            # A real parent shell keeps Pi's job group non-orphaned, so SIGTSTP is effective.
            rc = job_file + ".rc"
            with open(rc, "w") as file:
                file.write("PS1='JOB_CONTROL> '\n")
            os.execvpe(job_shell, [job_shell, "--noprofile", "--rcfile", rc, "-i"], os.environ)
        os.execvpe(command[0], command, os.environ)
    alive = True
    status = None
    master_open = True
    drained_bytes = 0
    escalations = 0
    launch_pending = bool(job_shell)
    prompt_tail = b""

    def read_output(shutdown=False):
        nonlocal master_open, drained_bytes, launch_pending, prompt_tail
        try:
            data = os.read(master, 65536)
        except OSError as error:
            if error.errno != errno.EIO:
                raise
            data = b""
        if data:
            emit({"data": base64.b64encode(data).decode("ascii")})
            if launch_pending and not shutdown:
                prompt_tail = (prompt_tail + data)[-256:]
                if b"JOB_CONTROL> " in prompt_tail:
                    # Bash enables job control after startup files have finished.
                    launch_pending = False
                    pending = (shlex.join(launch) + "\n").encode()
                    while pending:
                        pending = pending[os.write(master, pending):]
            if shutdown:
                drained_bytes += len(data)
        else:
            master_open = False

    def resize(columns, lines):
        fcntl.ioctl(master, termios.TIOCSWINSZ, struct.pack("HHHH", lines, columns, 0, 0))

    def stop(*_):
        raise InterruptedError("PTY transport stopped")

    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    buffer = b""
    resize(cols, rows)
    emit({"ready": pid})
    # Isolated opt-in for a real pause past Occipital's 300-second deadline.
    lifetime = 360 if os.environ.get('TIDY_UI_TEST_LONG_SUSPEND') == '1' else 180
    deadline = time.monotonic() + lifetime
    # Isolated regression opt-in: delay ioctl itself, not Pi's text or geometry.
    resize_delay = int(os.environ.get("TIDY_UI_TEST_RESIZE_DELAY_MS", "0")) / 1000
    host_hold = int(os.environ.get("TIDY_UI_TEST_RESIZE_HOLD_MS", "0")) / 1000
    try:
        while time.monotonic() < deadline:
            readers, _, _ = select.select([master, sys.stdin.fileno()], [], [], 0.1)
            if master in readers:
                read_output()
                if not master_open:
                    break
            if sys.stdin.fileno() in readers:
                data = os.read(sys.stdin.fileno(), 65536)
                if not data:
                    break
                buffer += data
                while b"\n" in buffer:
                    line, buffer = buffer.split(b"\n", 1)
                    message = json.loads(line)
                    if message.get("stop"):
                        return
                    if "input" in message:
                        data = base64.b64decode(message["input"])
                        while data:
                            count = os.write(master, data)
                            data = data[count:]
                    if "resize" in message:
                        if resize_delay:
                            time.sleep(resize_delay)
                        # A second opt-in proves ioctl acknowledgement alone is insufficient.
                        if host_hold:
                            os.kill(pid, signal.SIGSTOP)
                            os.waitpid(pid, os.WUNTRACED)
                        try:
                            resize(*message["resize"])
                            emit({"resized": message["resize"], "id": message["id"]})
                            if host_hold:
                                time.sleep(host_hold)
                        finally:
                            if host_hold:
                                os.kill(pid, signal.SIGCONT)
            exited, status = os.waitpid(pid, os.WNOHANG)
            if exited:
                alive = False
                break
        if time.monotonic() >= deadline:
            emit({"error": f"PTY lifetime exceeded {lifetime} seconds"})
    except InterruptedError:
        pass
    finally:
        job_group = None
        if job_shell:
            try:
                with open(job_file) as file:
                    record = file.read()
                if not record.endswith("\n") or not record[:-1].isdigit():
                    raise ValueError("incomplete owned job group")
                job_group = int(record)
                if job_group <= 1 or job_group == os.getpgrp():
                    raise ValueError("invalid owned job group")
                os.killpg(job_group, signal.SIGCONT)
                os.killpg(job_group, signal.SIGTERM)
            except (FileNotFoundError, ProcessLookupError):
                pass
            except ValueError:
                job_group = None
                emit({"error": "Incomplete or invalid owned job-group record during cleanup"})
        if alive:
            # Without job control, Pi and its non-detached children share this group.
            try:
                os.killpg(pid, signal.SIGTERM)
            except ProcessLookupError:
                pass
            end = time.monotonic() + 2
            while time.monotonic() < end:
                exited, status = os.waitpid(pid, os.WNOHANG)
                if exited:
                    alive = False
                    break
                # Shutdown writers must not block on a full PTY while we wait.
                # Stdin is deliberately excluded, including after its EOF.
                if master_open:
                    readers, _, _ = select.select([master], [], [], min(0.02, max(0, end - time.monotonic())))
                    if readers:
                        read_output(shutdown=True)
                else:
                    time.sleep(min(0.02, max(0, end - time.monotonic())))
            if alive:
                try:
                    os.killpg(pid, signal.SIGKILL)
                    escalations += 1
                except ProcessLookupError:
                    pass
                _, status = os.waitpid(pid, 0)
        if job_group is not None:
            try:
                os.killpg(job_group, signal.SIGKILL)
            except ProcessLookupError:
                pass
        try:
            # Reaping can precede the last readable terminal packet. Do not wait
            # for a descendant holding the slave, or drain an endless writer forever.
            tail_end = time.monotonic() + 2
            while master_open:
                readers, _, _ = select.select([master], [], [], 0)
                if not readers:
                    break
                if time.monotonic() >= tail_end:
                    emit({"error": "PTY tail drain exceeded 2 seconds"})
                    break
                read_output(shutdown=True)
            if status is not None:
                emit({"exit": os.waitstatus_to_exitcode(status)})
            emit({"shutdown": {"drainedBytes": drained_bytes, "escalations": escalations}})
        finally:
            os.close(master)


if __name__ == "__main__":
    if len(sys.argv) > 1 and sys.argv[1] == "--job-child":
        with open(sys.argv[2], "w") as file:
            file.write(str(os.getpgrp()) + "\n")
        os.execvpe(sys.argv[3], sys.argv[3:], os.environ)
    else:
        main()
