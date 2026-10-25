import fcntl
import json
import os
from pathlib import Path
import re
import select
import struct
import sys
import termios
import time
import tty

output = Path(sys.argv[1])
fd = sys.stdin.fileno()
previous = termios.tcgetattr(fd)


def size():
    rows, columns, width, height = struct.unpack("HHHH", fcntl.ioctl(fd, termios.TIOCGWINSZ, b"\0" * 8))
    return {"columns": columns, "rows": rows, "pixelWidth": width, "pixelHeight": height}


def record(name, value):
    pending = output / (name + ".pending")
    pending.write_text(json.dumps(value) + "\n")
    pending.replace(output / name)


def write(data):
    remaining = memoryview(data)
    while remaining:
        remaining = remaining[os.write(sys.stdout.fileno(), remaining):]


try:
    tty.setraw(fd)
    record("foot-size.json", size())
    deadline = time.monotonic() + 30
    while not (output / "foot-start").exists():
        if time.monotonic() >= deadline:
            raise TimeoutError("Waiting for the screenshot window timed out")
        if select.select([fd], [], [], 0.05)[0]:
            os.read(fd, 4096)
    write(b"\x1b[16t\x1b[6n")
    response = b""
    while not (match := re.search(rb"\x1b\[6;([0-9]+);([0-9]+)t", response)):
        if time.monotonic() >= deadline:
            raise TimeoutError("foot did not report its native cell metrics")
        if select.select([fd], [], [], 0.05)[0]:
            response = (response + os.read(fd, 4096))[-8192:]
    record("foot-metrics.json", {**size(), "cellWidth": int(match[2]), "cellHeight": int(match[1])})
    while not (output / "foot-paint").exists():
        if time.monotonic() >= deadline:
            raise TimeoutError("Waiting for the requested terminal grid timed out")
        record("foot-size.json", size())
        if select.select([fd], [], [], 0.05)[0]:
            os.read(fd, 4096)
    write((output / "preview.ansi").read_bytes())
    write(b"\x1b[6n")
    response = b""
    while not re.search(rb"\x1b\[[0-9]+;[0-9]+R", response):
        if time.monotonic() >= deadline:
            raise TimeoutError("foot did not acknowledge the complete ANSI replay")
        if select.select([fd], [], [], 0.05)[0]:
            response = (response + os.read(fd, 4096))[-8192:]
    record("foot-ready.json", size())
    while not (output / "foot-stop").exists():
        if time.monotonic() >= deadline:
            raise TimeoutError("Waiting for screenshot completion timed out")
        if select.select([fd], [], [], 0.05)[0]:
            os.read(fd, 4096)
finally:
    termios.tcsetattr(fd, termios.TCSANOW, previous)
