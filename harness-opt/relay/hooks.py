"""Host hooks around the relay: layout, docker argv, and classify codes.

classify records codes. This module does not rerun pairs or summarize ITT.
"""
import hashlib
import hmac
import json
import os
from pathlib import Path

from canon import append_jsonl, canonical
from ledger import classify

CONTROL_CONFIG_SHA = "3e5d312d252f8f70a7f16f3a37a109f706fe85db59d4515a323828bdac5c192c"
ATTEST_NETWORK = "gateway-only"
DOCKER_NETWORK = "devii-004-int"
RUN_CODES = frozenset({
    "token_cap", "checker_undecided", "client_disconnect", "result_runid_mismatch", "布局违规", "upstream_client_error",
})
INFRA_CODES = frozenset({
    "usage_missing", "relay_restart", "attest_mismatch", "no_requests", "connect_failed", "prerun_layout",
    "docker_daemon_event", "upstream_server_error",
})
POLL_INTERVAL_S = 15
DEFAULT_RELAY_ROOT = "/home/box/.harness-relay"
# Pinned sha256 of the declared round-0 trace. That file is not in this repo.
ROUND0_HOST_COPY_SHA = "6a213acd3b0b84c54609fbcfa492b5b2911926bafebc85b155d8e16d0f5a1e6c"


def _under_home_box(path) -> bool:
    raw = os.path.normpath(str(path))
    if raw == "/home/box" or raw.startswith("/home/box" + os.sep):
        return True
    resolved = os.path.realpath(raw)
    return resolved == "/home/box" or resolved.startswith("/home/box" + os.sep)


def container_argv(*, image, run_id, port, network, env, mounts, command, role_run_ids=()):
    """One serial container. Every run drops NET_RAW. Nothing under /home/box is mounted."""
    if network != DOCKER_NETWORK:
        raise ValueError(f"reject network {network}")
    if any(key == "API_KEY" for key in env):
        raise ValueError("API_KEY")
    argv = [
        "docker", "run", "--rm",
        "--network", DOCKER_NETWORK,
        "--cap-drop", "NET_RAW",
        "-e", f"BASE_URL=http://10.204.0.1:{port}/r/{run_id}/v1",
        "-e", f"HARNESS_RUN_ID={run_id}",
    ]
    for mount in mounts:
        src, dst = (mount["source"], mount["target"]) if isinstance(mount, dict) else mount
        if _under_home_box(src) or _under_home_box(dst):
            raise ValueError("agent container must not mount /home/box")
        if run_id and (run_id in str(src) or run_id in str(dst)):
            raise ValueError("executor run id in a mount")
        argv.extend(["-v", f"{src}:{dst}"])
    argv.append(image)
    argv.extend(list(command))
    blob = "\n".join(argv)
    if "--add-host" in argv or "API_KEY" in blob:
        raise ValueError("forbidden docker argument")
    for role_id in role_run_ids:
        if role_id and role_id in blob:
            raise ValueError("role run id in argv or mount")
    return argv


def _empty_dir(path: Path) -> str:
    if path.is_symlink():
        return "symlink"
    if not path.exists():
        return "absent"
    if not path.is_dir():
        return "not-dir"
    for child in path.iterdir():
        if child.is_symlink():
            return "symlink"
        return "not-empty"
    return "empty"


def pre_run_layout(run_dir, mounts, expected_mounts) -> dict:
    root = Path(run_dir)
    root.mkdir(parents=True, exist_ok=True)
    checks = []
    ok = True

    def add(name, passed, detail):
        nonlocal ok
        checks.append({"name": name, "ok": bool(passed), "detail": detail})
        if not passed:
            ok = False

    for name in ("workspace", "verifier"):
        path = root / name
        state = _empty_dir(path)
        if state == "absent":
            path.mkdir()
            add(name, True, "created")
        else:
            add(name, state == "empty", state)
    for name in ("pin", "runs"):
        path = root / name
        if path.exists() or path.is_symlink():
            add(name, False, "already-exists")
        else:
            path.mkdir()
            add(name, True, "created")
    outputs = root / "outputs"
    state = _empty_dir(outputs)
    if state == "absent":
        add("outputs", True, "absent")
    else:
        add("outputs", state == "empty", state)
    expected = {}
    for mount in expected_mounts:
        src, dst = (mount["source"], mount["target"]) if isinstance(mount, dict) else mount
        expected[dst] = os.path.realpath(src)
    for mount in mounts:
        src, dst = (mount["source"], mount["target"]) if isinstance(mount, dict) else mount
        exists = os.path.exists(src)
        match = exists and expected.get(dst) == os.path.realpath(src)
        add(f"mount:{dst}", match, src)
    sha = hashlib.sha256(canonical({"checks": checks})).hexdigest()
    return {"ok": ok, "checks": checks, "sha": sha}


def seal_layout(layout, key: bytes) -> dict:
    body = {"ok": layout["ok"], "checks": layout["checks"], "sha": layout["sha"]}
    mac = hmac.new(key, canonical(body), hashlib.sha256).hexdigest()
    return {**body, "hmacSha256": mac}


def verify_layout(sealed, key: bytes) -> bool:
    body = {"ok": sealed.get("ok"), "checks": sealed.get("checks"), "sha": sealed.get("sha")}
    mac = hmac.new(key, canonical(body), hashlib.sha256).hexdigest()
    if not hmac.compare_digest(mac, str(sealed.get("hmacSha256") or "")):
        return False
    digest = hashlib.sha256(canonical({"checks": sealed.get("checks")})).hexdigest()
    return digest == sealed.get("sha")


def output_layout_violation(run_dir) -> bool:
    outputs = Path(run_dir) / "outputs"
    if not outputs.exists() and not outputs.is_symlink():
        return False
    if outputs.is_symlink():
        return True
    if not outputs.is_dir():
        return True
    for child in outputs.iterdir():
        if child.is_symlink() or child.is_dir():
            return True
    return False


class _Empty:
    reqs = []
    dones = []
    validation_errors = []


def prepare_container(run_dir, mounts, expected_mounts, launch):
    layout = pre_run_layout(run_dir, mounts, expected_mounts)
    if not layout["ok"]:
        decision = classify(_Empty(), {"prerun_ok": False})
        return {"started": False, "layout": layout, "classify": decision}
    launch()
    return {"started": True, "layout": layout}


def reconcile_first_run(*, task, config_sha, seed, arm, reconcile, already=False):
    ok = task == "i014" and config_sha == CONTROL_CONFIG_SHA and seed == 9 and arm == "control" and reconcile is True and not already
    if not ok:
        return {"accepted": False, "purpose": None, "exclude": False}
    return {"accepted": True, "purpose": "reconcile", "exclude": True}


def exclude_from_statistics(rows):
    return [row for row in rows if row.get("purpose") != "reconcile"]


class OutputWatcher:
    def __init__(self, root, final_rel, events_path):
        self.root = Path(root)
        self.final = final_rel
        self.events_path = Path(events_path)
        self.seen = {}
        self.t_first = None
        self.t_last_write = None

    def poll_once(self, now):
        current = {}
        if self.root.exists():
            for dirpath, dirnames, files in os.walk(self.root, followlinks=False):
                dirnames[:] = [name for name in dirnames if not (Path(dirpath) / name).is_symlink()]
                for name in files:
                    path = Path(dirpath) / name
                    if path.is_symlink():
                        continue
                    rel = str(path.relative_to(self.root))
                    current[rel] = hashlib.sha256(path.read_bytes()).hexdigest()
        for rel in list(self.seen):
            if rel not in current:
                self._event(rel, "delete", None, now)
                del self.seen[rel]
        for rel, sha in sorted(current.items()):
            if rel not in self.seen:
                self._event(rel, "write", sha, now)
                if rel == self.final and self.t_first is None:
                    self.t_first = now
                self.t_last_write = now
            elif self.seen[rel] != sha:
                self._event(rel, "rewrite", sha, now)
                self.t_last_write = now
            self.seen[rel] = sha

    def _event(self, rel, event, sha, now):
        append_jsonl(self.events_path, {"path": rel, "event": event, "sha": sha, "ts": now})


def poll_once(ledger, cap):
    from ledger import tokens
    info = tokens(ledger)
    if info["usage_missing"]:
        return {"action": "stop", "reason": "usage_missing", "tokens": info["observed"]}
    if info["tokens"] > cap:
        return {"action": "kill", "reason": "token_cap", "tokens": info["tokens"]}
    return {"action": "ok", "tokens": info["tokens"]}


def score_from_relay(relay_tokens, trace_tokens, cap):
    """The trace token count is not the verdict."""
    if relay_tokens > cap:
        return {"score_status": "unscored", "unscored_kind": "run", "codes": ["token_cap"], "reward": None, "trace_tokens": trace_tokens}
    return {"score_status": "scored", "unscored_kind": None, "codes": [], "reward": None, "trace_tokens": trace_tokens}


def verify_run_binding(*, expected_run_id, attest_run_id, relay_run_id, result_run_id, network, relay_sha, expected_relay_sha):
    if result_run_id != expected_run_id:
        return {"ok": False, "code": "result_runid_mismatch", "kind": "run"}
    if attest_run_id != expected_run_id or relay_run_id != expected_run_id:
        return {"ok": False, "code": "attest_mismatch", "kind": "infra"}
    if network != ATTEST_NETWORK or relay_sha != expected_relay_sha:
        return {"ok": False, "code": "verify_fail", "kind": "infra"}
    return {"ok": True}


def checker_dest(run_id: str, relay_root=None) -> Path:
    """Host checker directory. The default root is /home/box/.harness-relay, which is not a container mount."""
    if not isinstance(run_id, str) or len(run_id) != 32 or any(char not in "0123456789abcdef" for char in run_id):
        raise ValueError("run id")
    root = Path(DEFAULT_RELAY_ROOT if relay_root is None else relay_root)
    return root / run_id / "checker"


def host_copy_sha(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def assert_round0_host_copy(data: bytes) -> str:
    """The round-0 host copy is accepted only when its sha256 is the pinned snapshot."""
    digest = host_copy_sha(data)
    if digest != ROUND0_HOST_COPY_SHA:
        raise ValueError("round-0 host copy sha")
    return digest


def _write_exact(path: Path, data: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    try:
        os.write(fd, data)
        os.fsync(fd)
    finally:
        os.close(fd)


def copy_checker_before_sign(run_dir, run_id: str, relay_root=None) -> dict:
    """Copy {run}/verifier to <relay>/<runId>/checker. Call this before the host signs.

    devii_docker_v2 writes the checker under {run}/verifier. The agent container
    never receives the relay directory as a mount. A second copy of the same
    bytes is kept. A different second copy is refused.
    """
    dest = checker_dest(run_id, relay_root)
    src = Path(run_dir) / "verifier"
    if src.is_symlink():
        raise ValueError("verifier symlink")
    files = {}
    if src.is_dir():
        for dirpath, dirnames, filenames in os.walk(src, followlinks=False):
            dirnames.sort()
            for name in sorted(filenames):
                path = Path(dirpath) / name
                if path.is_symlink():
                    raise ValueError("verifier symlink")
                if not path.is_file():
                    continue
                rel = path.relative_to(src).as_posix()
                data = path.read_bytes()
                target = dest / rel
                if target.exists():
                    if target.is_symlink() or target.read_bytes() != data:
                        raise ValueError("checker copy changed")
                else:
                    _write_exact(target, data)
                files[rel] = hashlib.sha256(data).hexdigest()
    dest.mkdir(parents=True, exist_ok=True)
    os.chmod(dest, 0o700)
    digest = hashlib.sha256(canonical({"files": files})).hexdigest()
    return {"dest": str(dest), "sha": digest, "files": files}


def checker_tree_sha(checker_dir) -> str:
    root = Path(checker_dir)
    files = {}
    if root.is_dir() and not root.is_symlink():
        for dirpath, dirnames, filenames in os.walk(root, followlinks=False):
            dirnames.sort()
            for name in sorted(filenames):
                path = Path(dirpath) / name
                if path.is_symlink() or not path.is_file():
                    continue
                rel = path.relative_to(root).as_posix()
                files[rel] = hashlib.sha256(path.read_bytes()).hexdigest()
    return hashlib.sha256(canonical({"files": files})).hexdigest()


def parse_reward_text(text: str):
    raw = text.strip()
    if raw == "":
        raise ValueError("reward")
    value = float(raw)
    if value != value:
        raise ValueError("reward")
    if value == int(value):
        return int(value)
    return value


def read_checker_reward(checker_dir):
    file = Path(checker_dir) / "reward.txt"
    if file.is_symlink() or not file.is_file():
        raise ValueError("reward")
    return parse_reward_text(file.read_text(encoding="utf-8"))


def sign_run_record(key: bytes, checker_dir, *, relay_log_sha="", relay_sha="", boot_id="", network="devii-004-int", ewi_version="EWI-relay-v1", expected_run_id="") -> dict:
    """checkerOutputSha and reward enter the run signature. The checker directory is the host copy."""
    body = {
        "type": "run_record",
        "checkerOutputSha": checker_tree_sha(checker_dir),
        "reward": read_checker_reward(checker_dir),
        "relayLogSha": relay_log_sha,
        "relaySha": relay_sha,
        "bootId": boot_id,
        "network": network,
        "ewiVersion": ewi_version,
        "expectedRunId": expected_run_id,
    }
    return {**body, "hmacSha256": hmac.new(key, canonical(body), hashlib.sha256).hexdigest()}


def _same_reward(left, right) -> bool:
    return left == right


def verify_run_record(run_sig, checker_out, reward, key: bytes, container_dir=None) -> dict:
    """Shared by reviewer input and run-notes. A mismatch is attest_mismatch.

    `reward` is the value the caller is about to trust. run-notes may display it,
    and that display is not itself evidence. Container result.json and verifier/reward.txt
    have to match the signed reward when `container_dir` is set.
    """
    if not isinstance(run_sig, dict):
        return {"ok": False, "reason": "attest_mismatch"}
    body = {k: v for k, v in run_sig.items() if k != "hmacSha256"}
    mac = run_sig.get("hmacSha256") or ""
    expected = hmac.new(key, canonical(body), hashlib.sha256).hexdigest()
    if not hmac.compare_digest(str(mac), expected):
        return {"ok": False, "reason": "attest_mismatch"}
    try:
        digest = checker_tree_sha(checker_out)
        disk_reward = read_checker_reward(checker_out)
    except (OSError, ValueError):
        return {"ok": False, "reason": "attest_mismatch"}
    if digest != run_sig.get("checkerOutputSha") or not _same_reward(disk_reward, run_sig.get("reward")):
        return {"ok": False, "reason": "attest_mismatch"}
    if not _same_reward(reward, run_sig.get("reward")):
        return {"ok": False, "reason": "attest_mismatch"}
    if container_dir is not None:
        try:
            container_reward = read_checker_reward(Path(container_dir) / "verifier")
        except (OSError, ValueError):
            return {"ok": False, "reason": "attest_mismatch"}
        if not _same_reward(container_reward, run_sig.get("reward")):
            return {"ok": False, "reason": "attest_mismatch"}
        result = Path(container_dir) / "result.json"
        if result.is_file() and not result.is_symlink():
            try:
                parsed = json.loads(result.read_text(encoding="utf-8"))
            except (OSError, json.JSONDecodeError):
                return {"ok": False, "reason": "attest_mismatch"}
            if "reward" in parsed and not _same_reward(parsed["reward"], run_sig.get("reward")):
                return {"ok": False, "reason": "attest_mismatch"}
    return {"ok": True}


def notes_reward(notes: str):
    for line in notes.splitlines():
        if line.startswith("reward:"):
            return parse_reward_text(line.split(":", 1)[1])
    raise ValueError("reward")


def verify_notes_reward(notes: str, run_sig, checker_out, key: bytes) -> dict:
    """The reward line in run-notes is display. It still has to match the signed record."""
    try:
        shown = notes_reward(notes)
    except ValueError:
        return {"ok": False, "reason": "attest_mismatch"}
    return verify_run_record(run_sig, checker_out, shown, key)


def innovator_check(ledger, gap_file, expected_sha, candidate_sha, post_patch_sha, knob, expected_knob, cited_lines=None):
    from ledger import read_evidence
    evidence = read_evidence(ledger, gap_file, expected_sha, cited_lines)
    if not evidence["ok"]:
        return {"ok": False, "reason": "read"}
    if post_patch_sha != candidate_sha:
        return {"ok": False, "reason": "sha"}
    if knob != expected_knob:
        return {"ok": False, "reason": "knob"}
    return {"ok": True}
