#!/usr/bin/env python3
"""In-netns half of the model gateway relay.

Listens on the sandbox loopback (or the BASE_URL IP assigned to lo) and
splices each TCP connection to the host unix socket. The host process is the
only thing that dials BASE_URL. This file is bind-mounted into the sandbox;
it does not import devii_one.
"""
from __future__ import annotations

import socket
import subprocess
import sys
import threading


def _pipe(src: socket.socket, dst: socket.socket) -> None:
    try:
        while True:
            data = src.recv(65536)
            if not data:
                break
            dst.sendall(data)
    except OSError:
        pass
    finally:
        try:
            dst.shutdown(socket.SHUT_WR)
        except OSError:
            pass


def _splice(left: socket.socket, right: socket.socket) -> None:
    forward = threading.Thread(target=_pipe, args=(left, right), daemon=True)
    backward = threading.Thread(target=_pipe, args=(right, left), daemon=True)
    forward.start()
    backward.start()
    forward.join()
    backward.join()
    left.close()
    right.close()


def _serve(listen: str, port: int, sock_path: str) -> None:
    if listen != "127.0.0.1":
        added = subprocess.run(
            ["/usr/sbin/ip", "addr", "add", f"{listen}/32", "dev", "lo"],
            check=False, capture_output=True, text=True,
        )
        if added.returncode != 0 and "File exists" not in (added.stderr or ""):
            sys.stderr.write(f"model relay could not add {listen} to lo: {added.stderr}\n")
            raise SystemExit(1)
    server = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    server.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    try:
        server.bind((listen, port))
    except OSError as exc:
        sys.stderr.write(f"model relay listen failed on {listen}:{port}: {exc}\n")
        raise SystemExit(1) from exc
    server.listen(128)

    def accept_loop() -> None:
        while True:
            try:
                client, _addr = server.accept()
            except OSError:
                return
            try:
                remote = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
                remote.connect(sock_path)
            except OSError:
                client.close()
                continue
            threading.Thread(target=_splice, args=(client, remote), daemon=True).start()

    threading.Thread(target=accept_loop, daemon=True).start()


def main(argv: list[str]) -> int:
    if "--" not in argv:
        sys.stderr.write("model relay: missing command\n")
        return 1
    split = argv.index("--")
    flags = argv[:split]
    command = argv[split + 1 :]
    if not command:
        sys.stderr.write("model relay: missing command\n")
        return 1
    listen = "127.0.0.1"
    port = None
    sock_path = ""
    index = 0
    while index < len(flags):
        flag = flags[index]
        if flag == "--listen" and index + 1 < len(flags):
            listen = flags[index + 1]
            index += 2
            continue
        if flag == "--port" and index + 1 < len(flags):
            port = int(flags[index + 1])
            index += 2
            continue
        if flag == "--sock" and index + 1 < len(flags):
            sock_path = flags[index + 1]
            index += 2
            continue
        sys.stderr.write(f"model relay: unknown argument {flag}\n")
        return 1
    if port is None or port <= 0 or not sock_path:
        sys.stderr.write("model relay: --port and --sock are required\n")
        return 1
    _serve(listen, port, sock_path)
    return subprocess.call(command)


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
