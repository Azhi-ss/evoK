"""Canonical JSON and append-only fsync writes shared by the relay."""
import json
import os
from pathlib import Path

fsync_count = 0


def canonical(obj) -> bytes:
    return json.dumps(obj, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()


def append_jsonl(path, obj) -> None:
    """Append one JSON line and fsync it. Never truncates."""
    global fsync_count
    dest = Path(path)
    dest.parent.mkdir(parents=True, exist_ok=True)
    os.chmod(dest.parent, 0o700)
    line = json.dumps(obj, ensure_ascii=False, separators=(",", ":")) + "\n"
    fd = os.open(dest, os.O_APPEND | os.O_CREAT | os.O_WRONLY, 0o600)
    try:
        os.write(fd, line.encode())
        os.fsync(fd)
        fsync_count += 1
    finally:
        os.close(fd)
