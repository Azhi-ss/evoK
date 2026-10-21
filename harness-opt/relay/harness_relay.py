"""Host logging relay.

Binds only 10.204.0.1. The key scan compares raw request bytes with the raw
key bytes. It does not decode base64, JSON escapes, or split encodings.
"""
import hashlib
import json
import os
import re
import secrets
import stat
import time
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path

from canon import append_jsonl

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
    def __init__(self, *, port, log_root, upstream_key_file, attest_key_file, upstream_url=None, mounts=(), upstream=None):
        if os.path.realpath(upstream_key_file) == os.path.realpath(attest_key_file):
            raise RuntimeError("upstream key and attest key are the same path")
        self.upstream_key = _read_secret(upstream_key_file)
        self.attest_key = _read_secret(attest_key_file)
        if self.upstream_key == self.attest_key:
            raise RuntimeError("upstream key and attest key have the same content")
        self.port = int(port)
        self.host = BIND_HOST
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

    def open_run(self, run_id: str, kind: str, expected_config_sha: str) -> None:
        if not RUN_ID_RE.fullmatch(run_id or ""):
            raise RuntimeError("run id must be 32 hex")
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
        if self.open_id != run_id:
            raise RuntimeError("run is not open")
        ts, iso = _stamp()
        append_jsonl(self.log_path(run_id), {"type": "close", "runId": run_id, "ts": ts, "ts_iso": iso})
        self.open_id = None

    def base_url(self, run_id: str) -> str:
        return f"http://{BIND_HOST}:{self.port}/r/{run_id}/v1"

    def handle(self, method: str, path: str, body: bytes, headers=None, *, client_disconnect=False):
        headers = {str(k).lower(): v for k, v in (headers or {}).items()}
        if self._secret_in_body(body):
            self._reject(method, path, "secret_in_body")
            return 403, b""
        match = COMPLETIONS.fullmatch(path or "")
        if method != "POST" or match is None:
            self._reject(method, path, "path")
            return 403, b""
        run_id = match.group(1)
        if run_id != self.open_id:
            reason = "closed" if self._was_opened(run_id) else "run"
            self._reject(method, path, reason)
            return 403, b""
        expected_host = f"{BIND_HOST}:{self.port}"
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
        import socket
        assert_bind_host(self.host)
        sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        sock.bind((self.host, self.port))
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


def plant_request(log_path, run_id, system_text, *, usage=None, boot_id="plant-boot") -> None:
    """One 2xx request whose system text is the activation evidence. Tests and dry-run only."""
    path = Path(log_path)
    usage = usage or {"prompt_tokens": 4, "completion_tokens": 1, "prompt_tokens_details": {"cached_tokens": 0}}
    ts, iso = _stamp()
    if not path.is_file():
        append_jsonl(path, {"type": "relay_start", "bootId": boot_id, "pid": 1, "relaySha": relay_code_sha(), "ts": ts, "ts_iso": iso})
        append_jsonl(path, {"type": "open", "runId": run_id, "kind": "executor", "expectedConfigSha": "", "ts": ts, "ts_iso": iso})
    seq = 1
    if path.is_file():
        seq = 1 + sum(1 for line in path.read_text(encoding="utf-8").splitlines() if '"type":"req"' in line)
    append_jsonl(path, {
        "type": "req",
        "seq": seq,
        "runId": run_id,
        "ts_recv": ts,
        "ts_iso": iso,
        "bootId": boot_id,
        "reqSha": hashlib.sha256(system_text.encode()).hexdigest(),
        "systemSha": hashlib.sha256(system_text.encode()).hexdigest(),
        "systemConfigHashes": HASH_RE.findall(system_text),
        "stream": False,
        "streamPatched": False,
        "toolResults": [],
    })
    append_jsonl(path, {"type": "done", "seq": seq, "ts_resp_end": ts, "ts_iso": iso, "respSha": "0" * 64, "status": 200, "usage": usage})


def plant_read(log_path, run_id, host_file, *, seq=1, conclusion_seq=None) -> None:
    path = Path(log_path)
    text = Path(host_file).read_text(encoding="utf-8")
    sha = hashlib.sha256(text.encode()).hexdigest()
    tool = path.parent / "tool" / sha
    tool.parent.mkdir(parents=True, exist_ok=True)
    tool.write_text(text, encoding="utf-8")
    ts, iso = _stamp()
    if not path.is_file():
        append_jsonl(path, {"type": "relay_start", "bootId": "plant-boot", "pid": 1, "relaySha": relay_code_sha(), "ts": ts, "ts_iso": iso})
        append_jsonl(path, {"type": "open", "runId": run_id, "kind": "role:gap-finder", "expectedConfigSha": "", "ts": ts, "ts_iso": iso})
    existing = []
    if path.is_file():
        existing = [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]
    reqs = [row for row in existing if row.get("type") == "req"]
    if reqs and reqs[-1].get("seq") == seq and not reqs[-1].get("conclusion"):
        reqs[-1]["toolResults"].append({"sha256": sha, "tool_call_id": f"c{len(reqs[-1]['toolResults'])}", "toolName": "read", "args": {"path": str(Path(host_file).resolve())}})
        _rewrite(path, [reqs[-1] if row is reqs[-1] else row for row in existing])
        return
    append_jsonl(path, {
        "type": "req",
        "seq": seq,
        "runId": run_id,
        "ts_recv": ts,
        "ts_iso": iso,
        "bootId": "plant-boot",
        "reqSha": sha,
        "systemSha": "0" * 64,
        "systemConfigHashes": [],
        "stream": False,
        "streamPatched": False,
        "toolResults": [{"sha256": sha, "tool_call_id": "c0", "toolName": "read", "args": {"path": str(Path(host_file).resolve())}}],
        **({"conclusion": True} if conclusion_seq == seq else {}),
    })
    append_jsonl(path, {"type": "done", "seq": seq, "ts_resp_end": ts, "ts_iso": iso, "respSha": "0" * 64, "status": 200, "usage": {"prompt_tokens": 1, "completion_tokens": 1, "prompt_tokens_details": {"cached_tokens": 0}}})
    if conclusion_seq is not None and conclusion_seq != seq:
        append_jsonl(path, {
            "type": "req", "seq": conclusion_seq, "runId": run_id, "ts_recv": ts, "ts_iso": iso, "bootId": "plant-boot",
            "reqSha": "0" * 64, "systemSha": "0" * 64, "systemConfigHashes": [], "stream": False, "streamPatched": False,
            "toolResults": [], "conclusion": True,
        })
        append_jsonl(path, {"type": "done", "seq": conclusion_seq, "ts_resp_end": ts, "ts_iso": iso, "respSha": "0" * 64, "status": 200, "usage": {"prompt_tokens": 1, "completion_tokens": 1, "prompt_tokens_details": {"cached_tokens": 0}}})


def _rewrite(path: Path, rows) -> None:
    """plant-read grows a toolResults list on the same req. Not used for pair decisions."""
    path.write_text("".join(json.dumps(row, ensure_ascii=False, separators=(",", ":")) + "\n" for row in rows), encoding="utf-8")


def main(argv=None):
    import sys
    argv = list(sys.argv[1:] if argv is None else argv)
    if not argv:
        raise SystemExit("usage: harness_relay.py plant-request|plant-read ...")
    cmd = argv[0]
    flags = {}
    key = None
    for arg in argv[1:]:
        if arg.startswith("--"):
            key = arg[2:]
            flags.setdefault(key, [])
        elif key:
            flags[key].append(arg)
    def one(name):
        values = flags.get(name) or []
        if not values:
            raise SystemExit(f"missing --{name}")
        return values[-1]
    if cmd == "plant-request":
        plant_request(one("log"), one("run-id"), one("system"))
        return
    if cmd == "plant-read":
        files = flags.get("file") or []
        if not files:
            raise SystemExit("missing --file")
        for index, file in enumerate(files, start=1):
            plant_read(one("log"), one("run-id"), file, seq=index)
        return
    if cmd == "patch-active":
        from ledger import load, patch_active
        result = patch_active(load(one("log")), one("sha"))
        print(json.dumps(result))
        raise SystemExit(0 if result["active"] else 2)
    raise SystemExit(f"unknown {cmd}")


if __name__ == "__main__":
    main()
