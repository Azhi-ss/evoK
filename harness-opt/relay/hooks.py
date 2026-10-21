"""Host hooks around the relay: layout, docker argv, ITT, and pair reruns."""
import hashlib
import hmac
import json
import os
import re
from pathlib import Path

from canon import append_jsonl, canonical
from ewi_relay import ewi_relay_v1
from ledger import classify

CONTROL_CONFIG_SHA = "3e5d312d252f8f70a7f16f3a37a109f706fe85db59d4515a323828bdac5c192c"
ATTEST_NETWORK = "gateway-only"
DOCKER_NETWORK = "devii-004-int"
RERUN_CODES = frozenset({"relay_restart", "docker_daemon_event", "usage_missing"})
RUN_CODES = frozenset({
    "token_cap", "checker_undecided", "client_disconnect", "result_runid_mismatch", "布局违规", "upstream_client_error",
})
INFRA_CODES = frozenset({
    "usage_missing", "relay_restart", "attest_mismatch", "no_requests", "connect_failed", "prerun_layout",
    "docker_daemon_event", "upstream_server_error",
})
POLL_INTERVAL_S = 15
SHA_RE = re.compile(r"scheduleSha:\s*([0-9a-f]{64})")


def container_argv(*, image, run_id, port, network, env, mounts, command, role_run_ids=()):
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


def _flat_codes(codes):
    if isinstance(codes, dict):
        flat = []
        for value in codes.values():
            flat.extend(value)
        return flat
    return list(codes)


def _evidence_ok(codes, host_evidence) -> bool:
    for code in codes:
        evidence = host_evidence.get(code) if isinstance(host_evidence, dict) else None
        if evidence not in (True, "host"):
            return False
    return True


def pair_rerun_decision(block, pair_index, codes, host_evidence, sealed_checker_sha=None):
    """Rerun only for host-proven relay_restart, docker_daemon_event, or usage_missing.

    The signature takes no reward, EWI, or checker payload. A checker that already
    ran may pass sealedCheckerSha, which is only the sha.
    """
    if sealed_checker_sha is not None and not isinstance(sealed_checker_sha, str):
        raise TypeError("sealedCheckerSha only")
    flat = _flat_codes(codes)
    order = list(block.get("order") or [])
    base = {"pair_index": pair_index, "seed": block.get("seed"), "order": order, "voided": False}
    if block.get("kind") == "held-out":
        return {**base, "action": "reject", "reason": "held-out"}
    if block.get("counter") != 0:
        return {**base, "action": "stop", "reason": "cap"}
    if block.get("kind") not in ("final", "dev"):
        return {**base, "action": "reject", "reason": "block"}
    if any(code in RUN_CODES for code in flat):
        return {**base, "action": "reject", "reason": "run_code"}
    if not flat or any(code not in RERUN_CODES for code in flat):
        return {**base, "action": "reject", "reason": "codes"}
    if not _evidence_ok(flat, host_evidence):
        return {**base, "action": "reject", "reason": "evidence"}
    return {**base, "action": "rerun", "reason": None, "voided": True, "excluded_from_itt": True}


class PairOrchestrator:
    """Call pair_rerun_decision before any reward read. Records are append-only and signed."""

    def __init__(self, key: bytes, path):
        self.key = key
        self.path = path
        self.decided = False
        self.reran = False
        self.order = []

    def begin_pair(self):
        self.decided = False

    def read_reward(self, fn):
        if not self.decided:
            raise RuntimeError("reward read before pair_rerun_decision")
        self.order.append("reward")
        return fn()

    def decide(self, block, pair_index, codes, host_evidence, sealed_checker_sha=None):
        self.order.append("decide")
        preview = pair_rerun_decision(block, pair_index, codes, host_evidence, sealed_checker_sha=sealed_checker_sha)
        if self.reran and preview.get("action") == "rerun":
            decision = {
                "action": "no",
                "reason": "block_cap",
                "pair_index": pair_index,
                "seed": block.get("seed"),
                "order": list(block.get("order") or []),
                "voided": False,
            }
        else:
            decision = preview
            if decision.get("action") == "rerun":
                self.reran = True
        inputs = {
            "block": block,
            "pairIndex": pair_index,
            "codes": codes,
            "hostEvidence": host_evidence,
            "sealedCheckerSha": sealed_checker_sha,
        }
        _append_decision(self.path, self.key, inputs, decision)
        self.decided = True
        return decision


def orchestrate_pairs(block, pairs, key, path, reward_reader=None):
    orch = PairOrchestrator(key, path)
    decisions = []
    for pair in pairs:
        orch.begin_pair()
        decisions.append(orch.decide(
            block,
            pair["pair_index"],
            pair["codes"],
            pair["host_evidence"],
            pair.get("sealed_checker_sha"),
        ))
        if reward_reader is not None:
            orch.read_reward(lambda pair=pair: reward_reader(pair))
    return {"decisions": decisions, "events": list(orch.order)}


def _append_decision(path, key, inputs, decision):
    body = {"type": "pair_decision", "inputs": inputs, "decision": decision}
    mac = hmac.new(key, canonical(body), hashlib.sha256).hexdigest()
    append_jsonl(path, {**body, "hmacSha256": mac})


def verify_pair_decisions(path, key: bytes) -> bool:
    file = Path(path)
    if not file.is_file():
        return False
    lines = [line for line in file.read_text(encoding="utf-8").splitlines() if line.strip()]
    if not lines:
        return False
    for line in lines:
        try:
            obj = json.loads(line)
        except json.JSONDecodeError:
            return False
        mac = obj.pop("hmacSha256", "")
        if not hmac.compare_digest(str(mac), hmac.new(key, canonical(obj), hashlib.sha256).hexdigest()):
            return False
    return True


def sign_schedule(slots, key: bytes) -> dict:
    for slot in slots:
        for field in ("arm", "seed", "order"):
            if field not in slot:
                raise ValueError("schedule slot needs arm, seed, and order")
    body = {"slots": slots}
    raw = canonical(body)
    return {
        "slots": slots,
        "signed": True,
        "scheduleSha": hashlib.sha256(raw).hexdigest(),
        "hmacSha256": hmac.new(key, raw, hashlib.sha256).hexdigest(),
    }


def _notes_sha(run_notes):
    if isinstance(run_notes, dict):
        return run_notes.get("scheduleSha")
    match = SHA_RE.search(str(run_notes))
    return match.group(1) if match else None


def _require_schedule(schedule, run_notes, key: bytes) -> str:
    slots = schedule.get("slots")
    if not isinstance(slots, list) or not slots:
        raise ValueError("schedule signature failed")
    for slot in slots:
        for field in ("arm", "seed", "order"):
            if field not in slot:
                raise ValueError("schedule signature failed")
    digest = hashlib.sha256(canonical({"slots": slots})).hexdigest()
    mac = hmac.new(key, canonical({"slots": slots}), hashlib.sha256).hexdigest()
    if not hmac.compare_digest(mac, str(schedule.get("hmacSha256") or "")):
        raise ValueError("schedule signature failed")
    if _notes_sha(run_notes) != digest:
        raise ValueError("schedule sha does not match run-notes")
    return digest


def _has_infra(row) -> bool:
    return any(code in INFRA_CODES for code in (row.get("codes") or []))


def _itt_reward(row):
    if row.get("score_status") == "unscored" or row.get("unscored_kind"):
        return 0.0
    reward = row.get("reward", None)
    if reward is None:
        return None
    return float(reward)


def _itt_ewi(row) -> bool:
    if row.get("score_status") == "unscored" or row.get("unscored_kind"):
        return True
    return bool(row.get("ewi"))


def _arm_stats(rows):
    out = {}
    for row in rows:
        arm = row["arm"]
        bucket = out.setdefault(arm, {"n": 0, "reward_sum": 0.0, "reward_n": 0, "ewi_hits": 0})
        bucket["n"] += 1
        reward = _itt_reward(row)
        if reward is not None:
            bucket["reward_sum"] += reward
            bucket["reward_n"] += 1
        if _itt_ewi(row):
            bucket["ewi_hits"] += 1
    return {
        arm: {
            "n": bucket["n"],
            "reward_mean": (bucket["reward_sum"] / bucket["reward_n"]) if bucket["reward_n"] else None,
            "ewi_hits": bucket["ewi_hits"],
        }
        for arm, bucket in out.items()
    }


def itt_summary(schedule, results, run_notes, key: bytes) -> dict:
    """ITT over the signed schedule. Throws if the signature or run-notes sha fails."""
    _require_schedule(schedule, run_notes, key)
    by_id = {row["id"]: row for row in results}
    joined = []
    for slot in schedule["slots"]:
        found = by_id.get(slot["id"], {
            "id": slot["id"],
            "score_status": "unscored",
            "unscored_kind": "infra",
            "codes": ["no_requests"],
            "reward": None,
            "ewi": None,
        })
        joined.append({**slot, **found, "arm": slot["arm"]})
    active = [row for row in joined if not row.get("voided")]
    infra_counts = {}
    for row in active:
        if _has_infra(row):
            infra_counts[row["arm"]] = infra_counts.get(row["arm"], 0) + 1
    server = [
        {"id": row["id"], "arm": row["arm"], "seed": row.get("seed"), "codes": list(row.get("codes") or [])}
        for row in joined if "upstream_server_error" in (row.get("codes") or [])
    ]
    detail = []
    for row in joined:
        if row.get("voided") or row.get("score_status") == "unscored" or row.get("codes"):
            if row.get("voided") or row.get("score_status") == "unscored":
                detail.append({
                    "id": row["id"],
                    "arm": row["arm"],
                    "codes": list(row.get("codes") or []),
                    "voided": bool(row.get("voided")),
                    "unscored_kind": row.get("unscored_kind"),
                })
    missing = 0
    for row in active:
        if row.get("missing_continuous") or ("idle_s" in row and row.get("idle_s") is None) or ("gap_max_s" in row and row.get("gap_max_s") is None):
            missing += 1
    return {
        "denominator": len(active),
        "primary": {"by_arm": _arm_stats(active)},
        "sensitivity_infra_excluded": {"by_arm": _arm_stats([row for row in active if not _has_infra(row)])},
        "infra_counts": infra_counts,
        "upstream_server_error": {"count": len(server), "runs": server},
        "unscored_detail": detail,
        "n_缺失": missing,
        "no_claim": any(_has_infra(row) for row in active),
    }


def run_notes_for(schedule) -> str:
    return f"scheduleSha: {schedule['scheduleSha']}\n"
