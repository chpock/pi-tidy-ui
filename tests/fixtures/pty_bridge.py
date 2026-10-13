"""Small JSON-lines PTY transport; all terminal bytes remain unmodified."""
import base64
import errno
import fcntl
import json
import os
import pty
import select
import signal
import struct
import sys
import termios
import time


def emit(message):
    print(json.dumps(message), flush=True)


def main():
    cols, rows = int(sys.argv[1]), int(sys.argv[2])
    cwd, command = sys.argv[3], sys.argv[4:]
    pid, master = pty.fork()
    if pid == 0:
        os.chdir(cwd)
        os.execvpe(command[0], command, os.environ)
    alive = True

    def resize(columns, lines):
        fcntl.ioctl(master, termios.TIOCSWINSZ, struct.pack("HHHH", lines, columns, 0, 0))

    def stop(*_):
        raise InterruptedError("PTY transport stopped")

    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    buffer = b""
    resize(cols, rows)
    emit({"ready": pid})
    deadline = time.monotonic() + 180
    # Isolated regression opt-in: delay ioctl itself, not Pi's text or geometry.
    resize_delay = int(os.environ.get("TIDY_UI_TEST_RESIZE_DELAY_MS", "0")) / 1000
    host_hold = int(os.environ.get("TIDY_UI_TEST_RESIZE_HOLD_MS", "0")) / 1000
    try:
        while time.monotonic() < deadline:
            readers, _, _ = select.select([master, sys.stdin.fileno()], [], [], 0.1)
            if master in readers:
                try:
                    data = os.read(master, 65536)
                except OSError as error:
                    if error.errno != errno.EIO:
                        raise
                    data = b""
                if data:
                    emit({"data": base64.b64encode(data).decode("ascii")})
                else:
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
                emit({"exit": os.waitstatus_to_exitcode(status)})
                return
        if time.monotonic() >= deadline:
            emit({"error": "PTY lifetime exceeded 180 seconds"})
    except InterruptedError:
        pass
    finally:
        if alive:
            # Pi and any real bash grandchildren share this PTY process group.
            try:
                os.killpg(pid, signal.SIGTERM)
            except ProcessLookupError:
                pass
            end = time.monotonic() + 2
            while time.monotonic() < end:
                exited, status = os.waitpid(pid, os.WNOHANG)
                if exited:
                    alive = False
                    emit({"exit": os.waitstatus_to_exitcode(status)})
                    break
                time.sleep(0.02)
            if alive:
                os.killpg(pid, signal.SIGKILL)
                _, status = os.waitpid(pid, 0)
                emit({"exit": os.waitstatus_to_exitcode(status)})
        os.close(master)


if __name__ == "__main__":
    main()
