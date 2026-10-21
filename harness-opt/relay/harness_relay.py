"""Host logging relay.

Production binds only 10.204.0.1. An explicit bind_host of 127.0.0.1 is the
test listener. The key scan compares raw request bytes with the raw key
bytes. It does not decode base64, JSON escapes, or split encodings.
"""
import hashlib
import hmac
import json
import os
import re
import secrets
import socket
import stat
import sys
import threading
import time
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path

from canon import append_jsonl, canonical

BIND_HOST = "10.204.0.1"
UPSTREAM_URL = "https://newapi.ai-modeling.top/v1/chat/completions"
DEFAULT_LOG_ROOT = "/home/box/.harness-relay"
RUN_ID_RE = re.compile(r"^[0-9a-f]{32}$")
HASH_RE = re.compile(r"[0-9a-f]{64}")
COMPLETIONS = re.compile(r"^/r/([0-9a-f]{32})/v1/chat/completions$")
HERE = Path(__file__).resolve()
TZ = timezone(timedelta(hours=9))


def relay_code_sha() -> str:
    return hashlib.sha256(HERE.read_bytes()).hexdigest()


def new_run_id() -> str:
    return secrets.token_hex(16)


def assert_bind_host(host: str) -> None:
    if host != BIND_HOST:
        raise RuntimeError(f"refusing bind {host}")


class UpstreamNetworkError(Exception):
    pass


def _stamp():
    ts = time.time()
    return ts, datetime.fromtimestamp(ts, TZ).isoformat()


def _read_secret(path: str) -> bytes:
    st = os.lstat(path)
    if stat.S_ISLNK(st.st_mode) or not stat.S_ISREG(st.st_mode):
        raise RuntimeError("key must be a regular file")
    if stat.S_IMODE(st.st_mode) != 0o600:
        raise RuntimeError("key must be mode 0600")
    return Path(path).read_bytes()


def _overlaps(left: str, right: str) -> bool:
    a = os.path.realpath(left)
    b = os.path.realpath(right)
    return a == b or a.startswith(b + os.sep) or b.startswith(a + os.sep)


def _content_text(content) -> str:
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts = []
        for item in content:
            if isinstance(item, str):
                parts.append(item)
            elif isinstance(item, dict):
                parts.append(str(item.get("text") or ""))
        return "".join(parts)
    return "" if content is None else str(content)


def _system_hashes(messages) -> list:
    blobs = []
    for message in messages:
        if isinstance(message, dict) and message.get("role") == "system":
            blobs.append(_content_text(message.get("content")))
    return HASH_RE.findall("\n".join(blobs))


def _parse_args(raw):
    if isinstance(raw, str):
        try:
            parsed = json.loads(raw)
        except json.JSONDecodeError:
            return raw
        return parsed
    return raw


class Relay:
    def __init__(self, *, port, log_root, upstream_key_file, attest_key_file, upstream_url=None, mounts=(), upstream=None, bind_host=None):
        if os.path.realpath(upstream_key_file) == os.path.realpath(attest_key_file):
            raise RuntimeError("upstream key and attest key are the same path")
        self.upstream_key = _read_secret(upstream_key_file)
        self.attest_key = _read_secret(attest_key_file)
        if self.upstream_key == self.attest_key:
            raise RuntimeError("upstream key and attest key have the same content")
        self.port = int(port)
        host = BIND_HOST if bind_host is None else str(bind_host)
        if host != BIND_HOST and host != "127.0.0.1":
            assert_bind_host(host)
        self.host = host
        self._lock = threading.RLock()
        self.log_root = str(log_root)
        self.upstream_url = upstream_url or UPSTREAM_URL
        self.mounts = list(mounts)
        for mount in self.mounts:
            source = mount["source"] if isinstance(mount, dict) else mount[0]
            if _overlaps(self.log_root, source):
                raise RuntimeError("relay log is inside a mount")
        self.upstream = upstream or _default_upstream
        self.boot_id = str(uuid.uuid4())
        self.pid = os.getpid()
        self.relay_sha = relay_code_sha()
        self.open_id = None
        self.forwarded = []
        Path(self.log_root).mkdir(parents=True, exist_ok=True)
        os.chmod(self.log_root, 0o700)

    def status(self) -> dict:
        return {"pid": self.pid, "bootId": self.boot_id, "relaySha": self.relay_sha}

    def log_path(self, run_id: str) -> Path:
        return Path(self.log_root) / run_id / "relay.jsonl"

    def _seal_path(self, run_id: str) -> Path:
        return self.log_path(run_id).with_name("relay.jsonl.sig")

    def _restore_open(self) -> None:
        """A new process has no open_id. One open line without a close line is the open run."""
        if self.open_id is not None:
            return
        root = Path(self.log_root)
        if not root.is_dir():
            return
        found = []
        for child in root.iterdir():
            if not RUN_ID_RE.fullmatch(child.name):
                continue
            path = child / "relay.jsonl"
            if path.is_symlink() or not path.is_file():
                continue
            opened = False
            closed = False
            for row in self._lines(child.name):
                if row.get("type") == "open" and row.get("runId") == child.name:
                    opened = True
                elif row.get("type") == "close":
                    closed = True
            if opened and not closed:
                found.append(child.name)
        if len(found) > 1:
            raise RuntimeError("a run is already open")
        if len(found) == 1:
            self.open_id = found[0]

    def _has_close(self, run_id: str) -> bool:
        return any(row.get("type") == "close" for row in self._lines(run_id))

    def open_run(self, run_id: str, kind: str, expected_config_sha: str) -> None:
        with self._lock:
            self._open_run(run_id, kind, expected_config_sha)

    def _open_run(self, run_id: str, kind: str, expected_config_sha: str) -> None:
        if not RUN_ID_RE.fullmatch(run_id or ""):
            raise RuntimeError("run id must be 32 hex")
        if self.open_id is None:
            self._restore_open()
        if self.open_id is not None:
            raise RuntimeError("a run is already open")
        path = self.log_path(run_id)
        path.parent.mkdir(parents=True, exist_ok=True)
        os.chmod(path.parent, 0o700)
        ts, iso = _stamp()
        append_jsonl(path, {"type": "relay_start", "bootId": self.boot_id, "pid": self.pid, "relaySha": self.relay_sha, "ts": ts, "ts_iso": iso})
        append_jsonl(path, {"type": "open", "runId": run_id, "kind": kind, "expectedConfigSha": expected_config_sha, "ts": ts, "ts_iso": iso})
        self.open_id = run_id

    def close_run(self, run_id: str) -> None:
        """Append close, then HMAC the log bytes. An existing seal is left untouched."""
        with self._lock:
            self._close_run(run_id)

    def _close_run(self, run_id: str) -> None:
        if not RUN_ID_RE.fullmatch(run_id or ""):
            raise RuntimeError("run id must be 32 hex")
        path = self.log_path(run_id)
        sig = self._seal_path(run_id)
        if path.is_symlink() or sig.is_symlink() or sig.is_file():
            if self.open_id == run_id:
                self.open_id = None
            return
        if self.open_id is None:
            self._restore_open()
        if not path.exists():
            if self.open_id == run_id:
                self.open_id = None
            return
        if self.open_id != run_id:
            raise RuntimeError("run is not open")
        if not self._has_close(run_id):
            ts, iso = _stamp()
            append_jsonl(path, {"type": "close", "runId": run_id, "ts": ts, "ts_iso": iso})
        self.open_id = None
        self._write_seal(run_id)

    def _write_seal(self, run_id: str) -> None:
        path = self.log_path(run_id)
        sig = self._seal_path(run_id)
        if sig.exists() or path.is_symlink() or not path.is_file():
            return
        digest = hashlib.sha256(path.read_bytes()).hexdigest()
        body = {"type": "relay_log", "relayLogSha": digest}
        mac = hmac.new(self.attest_key, canonical(body), hashlib.sha256).hexdigest()
        raw = json.dumps({**body, "hmacSha256": mac}, sort_keys=True, separators=(",", ":")).encode() + b"\n"
        try:
            fd = os.open(sig, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
        except FileExistsError:
            return
        try:
            os.write(fd, raw)
            os.fsync(fd)
        finally:
            os.close(fd)

    def verify_log(self, run_id: str) -> dict:
        path = self.log_path(run_id)
        sig = self._seal_path(run_id)
        if path.is_symlink() or sig.is_symlink() or not path.is_file() or not sig.is_file():
            return {"ok": False, "reason": "attest_mismatch"}
        digest = hashlib.sha256(path.read_bytes()).hexdigest()
        try:
            signed = json.loads(sig.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            return {"ok": False, "reason": "attest_mismatch"}
        if not isinstance(signed, dict):
            return {"ok": False, "reason": "attest_mismatch"}
        body = {"type": "relay_log", "relayLogSha": signed.get("relayLogSha")}
        mac = hmac.new(self.attest_key, canonical(body), hashlib.sha256).hexdigest()
        offered = str(signed.get("hmacSha256") or "")
        if not hmac.compare_digest(mac, offered) or signed.get("relayLogSha") != digest:
            return {"ok": False, "reason": "attest_mismatch"}
        return {"ok": True}

    def base_url(self, run_id: str) -> str:
        return f"http://{self.host}:{self.port}/r/{run_id}/v1"

    def handle(self, method: str, path: str, body: bytes, headers=None, *, client_disconnect=False):
        with self._lock:
            return self._handle(method, path, body, headers, client_disconnect=client_disconnect)

    def _handle(self, method: str, path: str, body: bytes, headers=None, *, client_disconnect=False):
        headers = {str(k).lower(): v for k, v in (headers or {}).items()}
        if self._secret_in_body(body):
            self._reject(method, path, "secret_in_body")
            return 403, b""
        match = COMPLETIONS.fullmatch(path or "")
        if method != "POST" or match is None:
            self._reject(method, path, "path")
            return 403, b""
        run_id = match.group(1)
        if self.open_id is None:
            self._restore_open()
        if run_id != self.open_id:
            reason = "closed" if self._was_opened(run_id) else "run"
            self._reject(method, path, reason)
            return 403, b""
        expected_host = f"{self.host}:{self.port}"
        if headers.get("host") != expected_host:
            self._reject(method, path, "host")
            return 403, b""
        try:
            incoming = json.loads(body.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError):
            self._reject(method, path, "bad_json")
            return 403, b""
        if not isinstance(incoming, dict):
            self._reject(method, path, "bad_json")
            return 403, b""
        forward, stream, patched = _prepare(incoming)
        messages = incoming.get("messages") or []
        seq = 1 + sum(1 for line in self._lines(run_id) if line.get("type") == "req")
        ts, iso = _stamp()
        tool_results = self._store_tools(run_id, messages)
        req = {
            "type": "req",
            "seq": seq,
            "runId": run_id,
            "ts_recv": ts,
            "ts_iso": iso,
            "bootId": self.boot_id,
            "reqSha": hashlib.sha256(body).hexdigest(),
            "systemSha": hashlib.sha256(_system_blob(messages).encode()).hexdigest(),
            "systemConfigHashes": _system_hashes(messages),
            "stream": stream,
            "streamPatched": patched,
            "toolResults": tool_results,
        }
        if incoming.get("conclusion") is True:
            req["conclusion"] = True
        append_jsonl(self.log_path(run_id), req)
        if client_disconnect:
            self._done(run_id, seq, status=None, usage=None, error="client_disconnect", resp=b"")
            return 499, b""
        try:
            status, resp, usage = self.upstream(forward, stream)
        except UpstreamNetworkError:
            self._done(run_id, seq, status=None, usage=None, error="upstream_network", err_class="network", resp=b"")
            return 502, b""
        self.forwarded.append(forward)
        if status is None or int(status) >= 400:
            err = "network" if status is None else ("5xx" if int(status) >= 500 else "4xx")
            self._done(run_id, seq, status=status, usage=None, error="upstream_http", err_class=err, resp=resp or b"")
            return int(status or 502), resp or b""
        if stream and usage is None:
            usage = _usage_from_stream(resp)
        self._done(run_id, seq, status=int(status), usage=usage, resp=resp or b"")
        return int(status), resp or b""

    def _secret_in_body(self, body: bytes) -> bool:
        # Raw bytes only. Encoded or escaped copies of the key are not matches.
        if not isinstance(body, (bytes, bytearray)):
            body = str(body).encode()
        return (self.upstream_key and self.upstream_key in body) or (self.attest_key and self.attest_key in body)

    def _reject(self, method, path, reason) -> None:
        ts, iso = _stamp()
        target = self.log_path(self.open_id) if self.open_id else Path(self.log_root) / "reject.jsonl"
        append_jsonl(target, {"type": "reject", "ts": ts, "ts_iso": iso, "method": method, "path": path, "reason": reason})

    def _done(self, run_id, seq, *, status, usage, resp, error=None, err_class=None) -> None:
        ts, iso = _stamp()
        row = {
            "type": "done",
            "seq": seq,
            "ts_resp_end": ts,
            "ts_iso": iso,
            "respSha": hashlib.sha256(resp or b"").hexdigest(),
            "status": status,
            "usage": usage,
        }
        assistant = _assistant_text(resp or b"")
        if assistant:
            row["assistant"] = assistant
            row["assistantSha"] = hashlib.sha256(assistant.encode()).hexdigest()
        if error:
            row["error"] = error
        if err_class:
            row["errClass"] = err_class
        append_jsonl(self.log_path(run_id), row)

    def _store_tools(self, run_id, messages) -> list:
        calls = {}
        for message in messages:
            if not isinstance(message, dict) or message.get("role") != "assistant":
                continue
            for call in message.get("tool_calls") or []:
                fn = call.get("function") or {}
                calls[call.get("id")] = {"toolName": fn.get("name"), "args": _parse_args(fn.get("arguments"))}
        out = []
        tool_dir = self.log_path(run_id).parent / "tool"
        for message in messages:
            if not isinstance(message, dict) or message.get("role") != "tool":
                continue
            text = _content_text(message.get("content"))
            raw = text.encode()
            sha = hashlib.sha256(raw).hexdigest()
            tool_dir.mkdir(parents=True, exist_ok=True)
            os.chmod(tool_dir, 0o700)
            (tool_dir / sha).write_bytes(raw)
            meta = calls.get(message.get("tool_call_id")) or {}
            out.append({
                "sha256": sha,
                "tool_call_id": message.get("tool_call_id"),
                "toolName": meta.get("toolName"),
                "args": meta.get("args"),
            })
        return out

    def _lines(self, run_id):
        path = self.log_path(run_id)
        if not path.is_file():
            return []
        return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]

    def _was_opened(self, run_id) -> bool:
        path = self.log_path(run_id)
        if not path.is_file():
            return False
        return any(line.get("type") == "open" for line in self._lines(run_id))

    def bind(self):
        if self.host != "127.0.0.1":
            assert_bind_host(self.host)
        sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        sock.bind((self.host, self.port))
        sock.listen(32)
        return sock


def _system_blob(messages) -> str:
    return "\n".join(_content_text(m.get("content")) for m in messages if isinstance(m, dict) and m.get("role") == "system")


def _prepare(incoming: dict):
    stream = incoming.get("stream") is True
    patched = False
    forward = dict(incoming)
    if stream:
        opts = dict(forward.get("stream_options") or {})
        if opts.get("include_usage") is not True:
            opts["include_usage"] = True
            forward["stream_options"] = opts
            patched = True
    raw = json.dumps(forward, ensure_ascii=False, separators=(",", ":")).encode()
    return raw, stream, patched


def _assistant_text(resp: bytes) -> str:
    """Assistant text from a chat-completion body. Empty when the body has none."""
    if not resp:
        return ""
    if resp.lstrip().startswith(b"data:"):
        parts = []
        for line in resp.splitlines():
            if not line.startswith(b"data:"):
                continue
            data = line[5:].strip()
            if data == b"[DONE]":
                continue
            try:
                obj = json.loads(data.decode())
            except (UnicodeDecodeError, json.JSONDecodeError):
                continue
            if not isinstance(obj, dict):
                continue
            for choice in obj.get("choices") or []:
                if not isinstance(choice, dict):
                    continue
                message = choice.get("delta") if isinstance(choice.get("delta"), dict) else choice.get("message")
                if isinstance(message, dict):
                    piece = _content_text(message.get("content"))
                    if piece:
                        parts.append(piece)
        return "".join(parts)
    try:
        parsed = json.loads(resp.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError):
        return ""
    if not isinstance(parsed, dict):
        return ""
    choices = parsed.get("choices")
    if isinstance(choices, list) and choices and isinstance(choices[-1], dict):
        message = choices[-1].get("message")
        if isinstance(message, dict):
            return _content_text(message.get("content"))
    return ""


def _usage_from_stream(resp: bytes):
    usage = None
    for line in (resp or b"").splitlines():
        if not line.startswith(b"data:"):
            continue
        data = line[5:].strip()
        if data == b"[DONE]":
            continue
        try:
            obj = json.loads(data.decode())
        except json.JSONDecodeError:
            continue
        if isinstance(obj, dict) and obj.get("usage"):
            usage = obj["usage"]
    return usage


def _default_upstream(body, stream):
    usage = {"prompt_tokens": 3, "completion_tokens": 1, "prompt_tokens_details": {"cached_tokens": 0}}
    if stream:
        payload = json.dumps({"choices": [], "usage": usage}).encode()
        return 200, b"data: " + payload + b"\n\n", usage
    return 200, json.dumps({"usage": usage}).encode(), usage


def _usage_from_json(raw: bytes):
    try:
        parsed = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError):
        return None
    if isinstance(parsed, dict):
        return parsed.get("usage")
    return None


def _network_upstream(url: str, key: bytes):
    """POST the forwarded body. Usage comes only from the upstream response."""
    token = key.rstrip(b"\r\n").decode("utf-8")

    def upstream(body, stream):
        import urllib.error
        import urllib.request
        req = urllib.request.Request(url, data=body, method="POST", headers={
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json",
        })
        try:
            with urllib.request.urlopen(req, timeout=60) as resp:
                raw = resp.read()
                status = int(resp.status)
        except urllib.error.HTTPError as exc:
            raw = exc.read()
            status = int(exc.code)
        except Exception as exc:
            raise UpstreamNetworkError("upstream network") from exc
        usage = _usage_from_stream(raw) if stream else _usage_from_json(raw)
        return status, raw, usage

    return upstream


def _read_http(conn) -> tuple:
    data = b""
    while b"\r\n\r\n" not in data:
        chunk = conn.recv(65536)
        if chunk == b"":
            return None
        data += chunk
        if len(data) > 2_000_000:
            return None
    head, rest = data.split(b"\r\n\r\n", 1)
    lines = head.decode("iso-8859-1", "replace").split("\r\n")
    request = lines[0].split(" ")
    if len(request) < 2:
        return None
    path = request[1].split("?", 1)[0]
    headers = {}
    for line in lines[1:]:
        if ":" not in line:
            continue
        name, value = line.split(":", 1)
        headers[name.strip().lower()] = value.strip()
    try:
        length = int(headers.get("content-length") or "0")
    except ValueError:
        return None
    if length < 0 or length > 8_000_000:
        return None
    while len(rest) < length:
        chunk = conn.recv(65536)
        if chunk == b"":
            break
        rest += chunk
    return request[0], path, headers, rest[:length]


def _http_exchange(relay: Relay, conn) -> None:
    conn.settimeout(30)
    parsed = _read_http(conn)
    if parsed is None:
        return
    method, path, headers, body = parsed
    status, resp = relay.handle(method, path, body, headers)
    payload = resp if isinstance(resp, (bytes, bytearray)) else b""
    reason = "OK" if int(status) == 200 else "Error"
    header = (
        f"HTTP/1.1 {int(status)} {reason}\r\n"
        "Content-Type: application/json\r\n"
        f"Content-Length: {len(payload)}\r\n"
        "Connection: close\r\n"
        "\r\n"
    ).encode("ascii")
    conn.sendall(header + bytes(payload))


def _accept_loop(relay: Relay, sock, stop: threading.Event) -> None:
    sock.settimeout(0.2)
    while not stop.is_set():
        try:
            conn, _addr = sock.accept()
        except socket.timeout:
            continue
        except OSError:
            break
        try:
            _http_exchange(relay, conn)
        except Exception:
            pass
        finally:
            try:
                conn.close()
            except OSError:
                pass


def _flags(argv):
    flags = {}
    key = None
    for arg in argv:
        if arg.startswith("--"):
            key = arg[2:]
            flags.setdefault(key, [])
        elif key:
            flags[key].append(arg)
    return flags


def _one(flags, name):
    values = flags.get(name) or []
    if not values:
        raise SystemExit(f"missing --{name}")
    return values[-1]


def _relay_from(flags) -> Relay:
    upstream = os.environ.get("RELAY_UPSTREAM_KEY_FILE") or ""
    attest = os.environ.get("HARNESS_ATTEST_KEY_FILE") or ""
    if upstream == "" or attest == "":
        raise SystemExit("RELAY_UPSTREAM_KEY_FILE and HARNESS_ATTEST_KEY_FILE")
    port = int((flags.get("port") or ["8642"])[-1])
    bind = (flags.get("bind") or [BIND_HOST])[-1]
    upstream_url = (flags.get("upstream") or [None])[-1]
    kwargs = {}
    if upstream_url:
        kwargs["upstream_url"] = upstream_url
    return Relay(port=port, log_root=_one(flags, "log-root"), upstream_key_file=upstream, attest_key_file=attest, bind_host=bind, **kwargs)


def _serve(relay: Relay) -> None:
    sock = relay.bind()
    stop = threading.Event()
    thread = threading.Thread(target=_accept_loop, args=(relay, sock, stop), name="relay-http", daemon=True)
    thread.start()
    try:
        for raw in sys.stdin:
            line = raw.strip()
            if line == "":
                continue
            try:
                msg = json.loads(line)
                op = msg.get("op")
                if op == "open":
                    relay.open_run(msg["runId"], msg["kind"], msg["expectedSha"])
                    out = {"ok": True}
                elif op == "close":
                    relay.close_run(msg["runId"])
                    out = {"ok": True}
                elif op == "shutdown":
                    sys.stdout.write(json.dumps({"ok": True}) + "\n")
                    sys.stdout.flush()
                    return
                else:
                    out = {"ok": False, "error": "unknown"}
            except Exception as exc:
                out = {"ok": False, "error": str(exc)}
            sys.stdout.write(json.dumps(out) + "\n")
            sys.stdout.flush()
    finally:
        stop.set()
        try:
            sock.close()
        except OSError:
            pass
        thread.join(timeout=2)


def main(argv=None):
    argv = list(sys.argv[1:] if argv is None else argv)
    if not argv:
        raise SystemExit("usage: harness_relay.py patch-active|control|open-run|close-run|verify-log")
    cmd = argv[0]
    flags = _flags(argv[1:])
    if cmd == "patch-active":
        from ledger import load, patch_active
        result = patch_active(load(_one(flags, "log")), _one(flags, "sha"))
        print(json.dumps(result))
        raise SystemExit(0 if result["active"] else 2)
    if cmd == "control":
        relay = _relay_from(flags)
        url = (flags.get("upstream") or [UPSTREAM_URL])[-1]
        relay.upstream_url = url
        relay.upstream = _network_upstream(url, relay.upstream_key)
        _serve(relay)
        raise SystemExit(0)
    if cmd == "open-run":
        _relay_from(flags).open_run(_one(flags, "run-id"), _one(flags, "kind"), _one(flags, "expected-sha"))
        print(json.dumps({"ok": True}))
        raise SystemExit(0)
    if cmd == "close-run":
        _relay_from(flags).close_run(_one(flags, "run-id"))
        print(json.dumps({"ok": True}))
        raise SystemExit(0)
    if cmd == "verify-log":
        print(json.dumps(_relay_from(flags).verify_log(_one(flags, "run-id"))))
        raise SystemExit(0)
    raise SystemExit(f"unknown {cmd}")


if __name__ == "__main__":
    main()
