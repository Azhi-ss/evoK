"""AutoResearch loop mode. Caps are signed before round 1. classify does not rerun."""
import hashlib
import hmac
import json
import os
import sys
from pathlib import Path

from canon import canonical
from ledger import Ledger, tokens

INNOVATOR_CAP = 200_000
MAX_ROUNDS = 10
READ_ONLY_TOKEN_CAP = 30_000_000
READ_ONLY_WALL_S = 48 * 3600
REAL_RUN_WALL_S = 103 * 3600
READ_ONLY_ROLES = frozenset({"innovator", "critic", "ranker"})
RANKING_ROLES = frozenset({"critic", "ranker"})
BIND_ROLES = frozenset({"critic", "ranker", "reviewer"})
RANKING_ROUND_CAP = 3_000_000
# seedSha is retained and is not used to order anything.
ANTI_FORGERY = frozenset({"attest_mismatch", "reward", "round0Record"})

CAPS = {
    "maxRounds": MAX_ROUNDS,
    "readOnlyTokenCap": READ_ONLY_TOKEN_CAP,
    "readOnlyWallCapS": READ_ONLY_WALL_S,
    "realRunWallCapS": REAL_RUN_WALL_S,
}


def _mac(body, key: bytes) -> str:
    return hmac.new(key, canonical(body), hashlib.sha256).hexdigest()


def _write_private(path, data: bytes) -> None:
    dest = Path(path)
    dest.parent.mkdir(parents=True, exist_ok=True)
    os.chmod(dest.parent, 0o700)
    fd = os.open(dest, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    try:
        os.write(fd, data)
        os.fsync(fd)
    finally:
        os.close(fd)


def copy_round0(src_path, host_copy_path, *, mounts=()) -> dict:
    """Copy the round-0 trace onto a host-private path and return the signed record fields."""
    src = Path(src_path)
    if src.is_symlink() or not src.is_file():
        raise ValueError("round0Record missing")
    data = src.read_bytes()
    digest = hashlib.sha256(data).hexdigest()
    dest = Path(host_copy_path)
    for mount in mounts:
        source = mount["source"] if isinstance(mount, dict) else mount[0]
        if _path_inside(dest, source) or _path_inside(src, source):
            raise ValueError("round0Record is inside a mount")
    _write_private(dest, data)
    copied = dest.read_bytes()
    if hashlib.sha256(copied).hexdigest() != digest:
        raise ValueError("round0Record sha")
    return {"srcPath": str(src), "srcSha256": digest, "hostCopyPath": str(dest)}


def _path_inside(path, root) -> bool:
    child = os.path.realpath(path)
    base = os.path.realpath(root)
    return child == base or child.startswith(base + os.sep)


def _round0_sha(value) -> str:
    if not isinstance(value, str) or len(value) != 64 or any(char not in "0123456789abcdef" for char in value):
        raise ValueError("round0Record sha")
    return value


def declared_round0(path, sha) -> dict:
    """Caller-supplied source identity. hostCopyPath stays empty until the host copies the file."""
    if not isinstance(path, str) or path.strip() == "":
        raise ValueError("round0Record srcPath")
    return {"srcPath": path, "srcSha256": _round0_sha(sha), "hostCopyPath": ""}


def gate_rule_sha() -> str:
    """sha256 of a canonical manifest of the rule text and the gate implementation.

    The manifest is UTF-8. Two lines, in this order, each ending in ``\\n``::

        docs/reviewer-gate-rules.md <sha256 of that file>
        src/modules/reviewer-gates.ts <sha256 of that file>

    Paths are relative to the harness-opt directory. This digest is gateRuleSha.
    """
    root = Path(__file__).resolve().parents[1]
    files = (
        "docs/reviewer-gate-rules.md",
        "src/modules/reviewer-gates.ts",
    )
    lines = []
    for rel in files:
        digest = hashlib.sha256((root / rel).read_bytes()).hexdigest()
        lines.append(f"{rel} {digest}\n")
    return hashlib.sha256("".join(lines).encode("utf-8")).hexdigest()


def pre_round1_sign(key: bytes, *, seed: bytes, ranker, critic, round0_path=None, round0_sha=None, round_started: bool = False, round0_src=None, host_copy_path=None, mounts=(), campaign_nonce=None, search_tree_from_round=None) -> dict:
    """Sign the caps, an inert seedSha, and round0Record before round 1.

    round0_path and round0_sha are required. There is no built-in trace.
    seedSha is not used to shuffle comparison order. It stays in the signed body only.
    """
    if round_started:
        raise ValueError("pre_round1_sign is before round 1")
    if not isinstance(seed, (bytes, bytearray)) or len(seed) == 0:
        raise ValueError("seed")
    if not isinstance(round0_path, str) or round0_path.strip() == "":
        raise ValueError("round0Record srcPath")
    expected = _round0_sha(round0_sha)
    if round0_src:
        if not host_copy_path:
            raise ValueError("round0Record hostCopyPath")
        src = Path(round0_src)
        if str(src) != round0_path:
            raise ValueError("round0Record srcPath")
        if src.is_symlink() or not src.is_file():
            raise ValueError("round0Record missing")
        if hashlib.sha256(src.read_bytes()).hexdigest() != expected:
            raise ValueError("round0Record sha")
        record = copy_round0(round0_src, host_copy_path, mounts=mounts)
        if record["srcSha256"] != expected:
            raise ValueError("round0Record sha")
    else:
        record = declared_round0(round0_path, expected)
    body = {
        "type": "pre_round1",
        "round0Record": record,
        "seedSha": hashlib.sha256(bytes(seed)).hexdigest(),
        "seed": 0,
        "innovatorCap": INNOVATOR_CAP,
        "gateRuleSha": gate_rule_sha(),
        "ranker": ranker,
        "critic": critic,
        **CAPS,
    }
    # Campaign nonce is part of this out dir's signed root. A later campaign.json
    # has to match it. Omitting the field keeps a pre-campaign signature valid.
    if campaign_nonce is not None:
        if not isinstance(campaign_nonce, str) or len(campaign_nonce) != 32 or any(char not in "0123456789abcdef" for char in campaign_nonce):
            raise ValueError("campaignNonce")
        body["campaignNonce"] = campaign_nonce
    # Optional pin. Absent keeps every existing pre-round1 body unchanged.
    if search_tree_from_round is not None:
        if isinstance(search_tree_from_round, bool) or not isinstance(search_tree_from_round, int) or search_tree_from_round < 1:
            raise ValueError("searchTreeFromRound")
        body["searchTreeFromRound"] = search_tree_from_round
    return {**body, "hmacSha256": _mac(body, key)}


def verify_pre_round1(signed, key: bytes) -> bool:
    body = {k: v for k, v in signed.items() if k != "hmacSha256"}
    mac = signed.get("hmacSha256") or ""
    return hmac.compare_digest(str(mac), _mac(body, key))


def call_usage(events) -> dict:
    """One relay record through ledger.tokens. No done line is usage_missing, not zero."""
    ledger = Ledger()
    for event in events or []:
        if not isinstance(event, dict):
            continue
        ledger.events.append(event)
        if event.get("type") == "req":
            ledger.reqs.append(event)
        if event.get("type") == "done":
            ledger.dones.append(event)
    if not ledger.dones:
        return {"tokens": None, "usage_missing": True, "observed": 0}
    return tokens(ledger)


def read_only_tokens(events, trace=None) -> dict:
    """Innovator+critic+ranker usage via ledger.tokens. A trace is ignored.

    An empty role set is zero. A 2xx done with null usage, or a req with no done, is usage_missing.
    """
    del trace
    rows = []
    for event in events or []:
        if not isinstance(event, dict):
            continue
        if (event.get("role") or event.get("kind")) not in READ_ONLY_ROLES:
            continue
        rows.append(event)
    if not rows:
        return {"tokens": 0, "usage_missing": False, "observed": 0}
    return call_usage(rows)


def ranking_budget(events) -> dict:
    """Per-round critic+ranker sub-cap. Innovator tokens are not part of this sub-cap."""
    grouped = {}
    for event in events or []:
        if not isinstance(event, dict):
            continue
        if (event.get("role") or event.get("kind")) not in RANKING_ROLES:
            continue
        rnd = event.get("round", 1)
        grouped.setdefault(rnd, []).append(event)
    per_round = {}
    missing = False
    for rnd, rows in grouped.items():
        info = call_usage(rows)
        if info["usage_missing"]:
            missing = True
            continue
        per_round[rnd] = info["tokens"] or 0
    hit = any(total >= RANKING_ROUND_CAP for total in per_round.values())
    return {
        "perRound": per_round,
        "cap": RANKING_ROUND_CAP,
        "capHit": hit,
        "reason": "no_winner:cap_hit" if hit else None,
        "usageMissing": missing,
    }


def budget_status(events) -> dict:
    """The 3M sub-cap and the 30M cumulative cap are decided independently."""
    ranking = ranking_budget(events)
    info = read_only_tokens(events)
    total = 0 if info["tokens"] is None else info["tokens"]
    return {
        "ranking": ranking,
        "readOnlyTokens": total,
        "usageMissing": info["usage_missing"],
        "readOnlyCapHit": (not info["usage_missing"]) and total >= READ_ONLY_TOKEN_CAP,
    }


def cap_hit(*, started_rounds, read_only_tokens_n, read_only_wall_s, real_run_wall_s, caps=None) -> str | None:
    limits = caps or CAPS
    if started_rounds >= limits["maxRounds"]:
        return "maxRounds"
    if read_only_tokens_n >= limits["readOnlyTokenCap"]:
        return "readOnlyTokenCap"
    if read_only_wall_s >= limits["readOnlyWallCapS"]:
        return "readOnlyWallCap"
    if real_run_wall_s >= limits["realRunWallCapS"]:
        return "realRunWallCap"
    return None


def drive(rounds, *, caps=None, read_only_tokens_n=0, read_only_wall_s=0, real_run_wall_s=0) -> dict:
    """Stop at the first cap. An in-progress real run finishes and is logged. No new call starts after that."""
    limits = caps or CAPS
    calls = []
    logged = []
    reason = None
    fault_rounds = 0
    reviewer_reject_rounds = 0
    tokens = read_only_tokens_n
    read_wall = read_only_wall_s
    real_wall = real_run_wall_s
    for index, rnd in enumerate(rounds, start=1):
        hit = cap_hit(started_rounds=index - 1, read_only_tokens_n=tokens, read_only_wall_s=read_wall, real_run_wall_s=real_wall, caps=limits)
        if hit:
            reason = hit
            break
        calls.append(f"role:{index}")
        tokens = rnd.get("read_only_tokens", tokens)
        read_wall = rnd.get("read_only_wall_s", read_wall)
        hit = cap_hit(started_rounds=index - 1, read_only_tokens_n=tokens, read_only_wall_s=read_wall, real_run_wall_s=real_wall, caps=limits)
        if hit:
            reason = hit
            break
        calls.append(f"real:{index}")
        real_wall = rnd.get("real_run_wall_s", real_wall)
        logged.append(index)
        if rnd.get("host_fault"):
            fault_rounds += 1
        if rnd.get("reviewer_reject"):
            reviewer_reject_rounds += 1
        if rnd.get("anti_forgery"):
            reason = "anti_forgery"
            break
        hit = cap_hit(started_rounds=index, read_only_tokens_n=tokens, read_only_wall_s=read_wall, real_run_wall_s=real_wall, caps=limits)
        if hit:
            reason = hit
            break
    return {
        "reason": reason,
        "calls": calls,
        "loggedRuns": logged,
        "faultRounds": fault_rounds,
        "reviewerRejectRounds": reviewer_reject_rounds,
        "readOnlyTokens": tokens,
    }


def _json_objects(text: str):
    found = []
    start = None
    depth = 0
    in_str = False
    esc = False
    for index, ch in enumerate(text):
        if in_str:
            if esc:
                esc = False
            elif ch == "\\":
                esc = True
            elif ch == '"':
                in_str = False
            continue
        if ch == '"':
            in_str = True
        elif ch == "{":
            if depth == 0:
                start = index
            depth += 1
        elif ch == "}" and depth:
            depth -= 1
            if depth == 0 and start is not None:
                try:
                    obj = json.loads(text[start:index + 1])
                except json.JSONDecodeError:
                    obj = None
                if isinstance(obj, dict):
                    found.append(obj)
                start = None
    return found


def _conclusion_shape(role: str, obj):
    if not isinstance(obj, dict):
        return None
    if role == "critic" and isinstance(obj.get("excluded"), list) and all(isinstance(item, str) for item in obj["excluded"]):
        return {"excluded": list(obj["excluded"])}
    if role == "ranker" and isinstance(obj.get("winnerId"), str):
        return {"winnerId": obj["winnerId"]}
    if role == "reviewer" and set(obj) == {"reason"} and isinstance(obj.get("reason"), str):
        return {"reason": obj["reason"]}
    return None


def _conclusion_in_text(role: str, text: str):
    found = None
    for obj in _json_objects(text):
        shaped = _conclusion_shape(role, obj)
        if shaped is not None:
            found = shaped
    return found


def bind_role_call(role: str, call, relay_events, session_text=None) -> dict:
    """Critic, ranker, and reviewer bind to the conclusion in the run's last done.

    The relay stores the assistant text. The host parses that text and accepts
    only when it equals the conclusion the role reported. Session text is ignored.
    """
    if role not in BIND_ROLES:
        raise ValueError("role kind rejected")
    if not relay_events:
        return {"ok": False, "reason": "missing_relay_record"}
    del session_text
    run_id = call.get("runId")
    reqs = [row for row in relay_events if row.get("type") == "req" and row.get("runId") == run_id]
    if not reqs:
        if any(row.get("type") == "req" for row in relay_events):
            return {"ok": False, "reason": "wrong_runId"}
        return {"ok": False, "reason": "missing_relay_record"}
    seqs = {row.get("seq") for row in reqs}
    dones = [row for row in relay_events if row.get("type") == "done" and row.get("seq") in seqs]
    if not dones:
        return {"ok": False, "reason": "missing_relay_record"}
    text = dones[-1].get("assistant")
    recorded = _conclusion_in_text(role, text) if isinstance(text, str) else None
    reported = _conclusion_shape(role, call.get("conclusion"))
    if recorded is None or reported is None or recorded != reported:
        return {"ok": False, "reason": "conclusion_mismatch"}
    return {"ok": True}


def exclude_and_recompute(candidates, excluded) -> dict:
    """Drop excluded candidates and recompute. One left wins. None left is no_winner:ranker_invalid."""
    blocked = set(excluded)
    left = [item for item in candidates if item["id"] not in blocked]
    if not left:
        return {"status": "no_winner", "reason": "ranker_invalid"}
    ordered = sorted(left, key=lambda item: (item.get("changedKeys", 0), item["id"]))
    winner = ordered[0]
    return {"status": "winner", "winner": winner["id"], "winnerSha": winner.get("configSha"), "ranking": [item["id"] for item in ordered]}


def main(argv=None) -> None:
    argv = list(sys.argv[1:] if argv is None else argv)
    payload = json.load(sys.stdin)
    cmd = argv[0] if argv else ""
    if cmd == "pre-round1":
        key_path = os.environ.get("HARNESS_ATTEST_KEY_FILE") or ""
        if key_path == "":
            raise SystemExit("HARNESS_ATTEST_KEY_FILE")
        key_bytes = Path(key_path).read_bytes()
        round0_path = payload.get("round0Path")
        round0_sha = payload.get("round0Sha")
        if not isinstance(round0_path, str) or round0_path.strip() == "" or not isinstance(round0_sha, str) or round0_sha.strip() == "":
            raise SystemExit("round0Path and round0Sha are required")
        signed = pre_round1_sign(
            key_bytes,
            seed=bytes.fromhex(payload["seed"]),
            ranker=payload["ranker"],
            critic=payload["critic"],
            round0_path=round0_path,
            round0_sha=round0_sha,
            round_started=bool(payload.get("roundStarted")),
            round0_src=payload.get("round0Src"),
            host_copy_path=payload.get("hostCopyPath"),
            mounts=payload.get("mounts") or (),
            campaign_nonce=payload.get("campaignNonce"),
            search_tree_from_round=payload.get("searchTreeFromRound"),
        )
        json.dump(signed, sys.stdout)
        return
    if cmd == "cap-hit":
        json.dump({"reason": cap_hit(
            started_rounds=payload["startedRounds"],
            read_only_tokens_n=payload["readOnlyTokens"],
            read_only_wall_s=payload["readOnlyWallS"],
            real_run_wall_s=payload["realRunWallS"],
        )}, sys.stdout)
        return
    if cmd == "read-only-tokens":
        json.dump(read_only_tokens(payload.get("events") or [], payload.get("trace")), sys.stdout)
        return
    if cmd == "call-usage":
        json.dump(call_usage(payload.get("events") or []), sys.stdout)
        return
    if cmd == "ranking-budget":
        json.dump(ranking_budget(payload.get("events") or []), sys.stdout)
        return
    if cmd == "bind-role":
        json.dump(bind_role_call(payload["role"], payload["call"], payload.get("events") or [], payload.get("session")), sys.stdout)
        return
    if cmd == "rank":
        json.dump(exclude_and_recompute(payload["candidates"], payload.get("excluded") or []), sys.stdout)
        return
    raise SystemExit(f"unknown {cmd}")


if __name__ == "__main__":
    main()
