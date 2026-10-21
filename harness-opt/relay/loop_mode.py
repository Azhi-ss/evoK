"""AutoResearch loop mode. Caps are signed before round 1. classify does not rerun."""
import hashlib
import hmac
import json
import sys

from canon import canonical
from ledger import weight

INNOVATOR_CAP = 200_000
MAX_ROUNDS = 10
READ_ONLY_TOKEN_CAP = 30_000_000
READ_ONLY_WALL_S = 48 * 3600
REAL_RUN_WALL_S = 103 * 3600
READ_ONLY_ROLES = frozenset({"innovator", "critic", "ranker"})
BIND_ROLES = frozenset({"critic", "ranker", "reviewer"})

CAPS = {
    "maxRounds": MAX_ROUNDS,
    "readOnlyTokenCap": READ_ONLY_TOKEN_CAP,
    "readOnlyWallCapS": READ_ONLY_WALL_S,
    "realRunWallCapS": REAL_RUN_WALL_S,
}


def _mac(body, key: bytes) -> str:
    return hmac.new(key, canonical(body), hashlib.sha256).hexdigest()


def pre_round1_sign(key: bytes, *, seed: bytes, ranker, critic, round_started: bool = False) -> dict:
    """Seed hash, seed 0, the 200k innovator cap, role config, and the four stop caps."""
    if round_started:
        raise ValueError("pre_round1_sign is before round 1")
    if not isinstance(seed, (bytes, bytearray)) or len(seed) == 0:
        raise ValueError("seed")
    body = {
        "type": "pre_round1",
        "seedSha": hashlib.sha256(bytes(seed)).hexdigest(),
        "seed": 0,
        "innovatorCap": INNOVATOR_CAP,
        "ranker": ranker,
        "critic": critic,
        **CAPS,
    }
    return {**body, "hmacSha256": _mac(body, key)}


def verify_pre_round1(signed, key: bytes) -> bool:
    body = {k: v for k, v in signed.items() if k != "hmacSha256"}
    mac = signed.get("hmacSha256") or ""
    return hmac.compare_digest(str(mac), _mac(body, key))


def read_only_tokens(events, trace=None) -> int:
    """i+o+cacheRead from innovator, critic, and ranker relay usage. A trace is ignored."""
    del trace
    total = 0
    for event in events or []:
        if (event.get("role") or event.get("kind")) not in READ_ONLY_ROLES:
            continue
        if event.get("type") != "done":
            continue
        status = event.get("status", 200)
        if isinstance(status, bool) or status is None or not 200 <= int(status) <= 299:
            continue
        usage = event.get("usage")
        if usage is None:
            continue
        total += weight(usage)
    return total


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


def bind_role_call(role: str, call, relay_events, session_text=None) -> dict:
    """Critic, ranker, and reviewer each need their own relay req/done. respSha matches the stored output."""
    if role not in BIND_ROLES:
        raise ValueError("role kind rejected")
    if not relay_events:
        return {"ok": False, "reason": "missing_relay_record"}
    del session_text
    seq = call["seq"]
    run_id = call["runId"]
    reqs = [row for row in relay_events if row.get("type") == "req" and row.get("seq") == seq]
    mine = [row for row in reqs if row.get("runId") == run_id]
    if not mine:
        if reqs:
            return {"ok": False, "reason": "wrong_runId"}
        return {"ok": False, "reason": "missing_relay_record"}
    dones = [row for row in relay_events if row.get("type") == "done" and row.get("seq") == seq and row.get("role", role) == role]
    if not dones:
        dones = [row for row in relay_events if row.get("type") == "done" and row.get("seq") == seq]
    if not dones:
        return {"ok": False, "reason": "missing_relay_record"}
    if dones[0].get("respSha") != call.get("outputSha"):
        return {"ok": False, "reason": "respSha_mismatch"}
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
        signed = pre_round1_sign(
            bytes.fromhex(payload["key"]),
            seed=bytes.fromhex(payload["seed"]),
            ranker=payload["ranker"],
            critic=payload["critic"],
            round_started=bool(payload.get("roundStarted")),
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
        json.dump({"tokens": read_only_tokens(payload.get("events") or [], payload.get("trace"))}, sys.stdout)
        return
    raise SystemExit(f"unknown {cmd}")


if __name__ == "__main__":
    main()
