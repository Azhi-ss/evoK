"""Test and dry-run relay rows. The production relay CLI does not plant requests."""
import hashlib
import json
from pathlib import Path

from canon import append_jsonl
from harness_relay import HASH_RE, _stamp, relay_code_sha


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
    append_jsonl(path, {"type": "done", "seq": seq, "ts_resp_end": ts, "ts_iso": iso, "respSha": "0" * 64, "status": 200, "usage": usage, "role": "executor"})
    append_jsonl(path, {"type": "close", "runId": run_id, "ts": ts, "ts_iso": iso})


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
        _rewrite(path, existing)
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
    append_jsonl(path, {"type": "done", "seq": seq, "ts_resp_end": ts, "ts_iso": iso, "respSha": "0" * 64, "status": 200, "usage": {"prompt_tokens": 1, "completion_tokens": 1, "prompt_tokens_details": {"cached_tokens": 0}}, "role": "gap"})
    if conclusion_seq is not None and conclusion_seq != seq:
        append_jsonl(path, {
            "type": "req", "seq": conclusion_seq, "runId": run_id, "ts_recv": ts, "ts_iso": iso, "bootId": "plant-boot",
            "reqSha": "0" * 64, "systemSha": "0" * 64, "systemConfigHashes": [], "stream": False, "streamPatched": False,
            "toolResults": [], "conclusion": True,
        })
        append_jsonl(path, {"type": "done", "seq": conclusion_seq, "ts_resp_end": ts, "ts_iso": iso, "respSha": "0" * 64, "status": 200, "usage": {"prompt_tokens": 1, "completion_tokens": 1, "prompt_tokens_details": {"cached_tokens": 0}}, "role": "gap"})


def plant_role_done(log_path, run_id, seq, resp_sha, role, round=1) -> None:
    """One req/done pair whose respSha is the role conclusion. Tests and dry-run only."""
    path = Path(log_path)
    ts, iso = _stamp()
    if not path.is_file():
        append_jsonl(path, {"type": "relay_start", "bootId": "plant-boot", "pid": 1, "relaySha": relay_code_sha(), "ts": ts, "ts_iso": iso})
        append_jsonl(path, {"type": "open", "runId": run_id, "kind": f"role:{role}", "expectedConfigSha": "", "ts": ts, "ts_iso": iso})
    append_jsonl(path, {
        "type": "req", "seq": seq, "runId": run_id, "ts_recv": ts, "ts_iso": iso, "bootId": "plant-boot",
        "reqSha": resp_sha, "systemSha": "0" * 64, "systemConfigHashes": [], "stream": False,
        "streamPatched": False, "toolResults": [], "role": role, "round": round,
    })
    append_jsonl(path, {
        "type": "done", "seq": seq, "runId": run_id, "ts_resp_end": ts, "ts_iso": iso,
        "respSha": resp_sha, "status": 200, "role": role, "round": round,
        "usage": {"prompt_tokens": 1, "completion_tokens": 1, "prompt_tokens_details": {"cached_tokens": 0}},
    })


def _rewrite(path: Path, rows) -> None:
    path.write_text("".join(json.dumps(row, ensure_ascii=False, separators=(",", ":")) + "\n" for row in rows), encoding="utf-8")


def main(argv=None) -> None:
    import sys
    argv = list(sys.argv[1:] if argv is None else argv)
    if not argv:
        raise SystemExit("usage: plant.py plant-request|plant-read|plant-role ...")
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
    if cmd == "plant-role":
        plant_role_done(one("log"), one("run-id"), int(one("seq")), one("resp-sha"), one("role"), int(one("round")) if flags.get("round") else 1)
        return
    raise SystemExit(f"unknown {cmd}")


if __name__ == "__main__":
    main()
