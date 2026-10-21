import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { driveCappedLoop, LOOP_CAPS } from "./loop-driver";

const RELAY = fileURLToPath(new URL("../../relay", import.meta.url));
const ROUND0 = "6a213acd3b0b84c54609fbcfa492b5b2911926bafebc85b155d8e16d0f5a1e6c";

function python(code: string): string {
  const proc = spawnSync("python3", ["-c", code], { encoding: "utf8", cwd: RELAY });
  if (proc.status !== 0) throw new Error((proc.stderr || proc.stdout || "python failed").trim());
  return proc.stdout.trim();
}

describe("tests 1-14", () => {
  test("1 pre_round1 signs the four caps before round 1", () => {
    const text = python(`
import hashlib, json
import loop_mode
key = b"k" * 32
seed = bytes.fromhex("ab" * 32)
signed = loop_mode.pre_round1_sign(key, seed=seed, ranker={"tools": ["read"]}, critic={"tools": ["read"]})
assert signed["seed"] == 0
assert signed["innovatorCap"] == 200000
assert signed["maxRounds"] == 10
assert signed["readOnlyTokenCap"] == 30000000
assert signed["readOnlyWallCapS"] == 48 * 3600
assert signed["realRunWallCapS"] == 103 * 3600
assert signed["seedSha"] == hashlib.sha256(seed).hexdigest()
assert loop_mode.verify_pre_round1(signed, key)
try:
    loop_mode.pre_round1_sign(key, seed=seed, ranker={}, critic={}, round_started=True)
    raise SystemExit("started")
except ValueError:
    pass
print("ok")
`);
    expect(text).toBe("ok");
    expect(LOOP_CAPS.maxRounds).toBe(10);
    expect(LOOP_CAPS.readOnlyTokenCap).toBe(30_000_000);
    expect(LOOP_CAPS.readOnlyWallCapS).toBe(48 * 3600);
    expect(LOOP_CAPS.realRunWallCapS).toBe(103 * 3600);
    expect(LOOP_CAPS.innovatorCap).toBe(200_000);
  });

  test("2 maxRounds stops on its own", () => {
    const report = driveCappedLoop(Array.from({ length: 11 }, () => ({})));
    expect(report.reason).toBe("maxRounds");
    expect(report.calls).toContain("role:10");
    expect(report.calls).toContain("real:10");
    expect(report.calls).not.toContain("role:11");
    expect(report.calls).not.toContain("real:11");
  });

  test("3 readOnlyTokenCap stops on its own", () => {
    const report = driveCappedLoop([{}], { readOnlyTokens: 30_000_000 });
    expect(report.reason).toBe("readOnlyTokenCap");
    expect(report.calls).toEqual([]);
  });

  test("4 readOnlyWallCap stops on its own", () => {
    const report = driveCappedLoop([{}], { readOnlyWallS: 48 * 3600 });
    expect(report.reason).toBe("readOnlyWallCap");
    expect(report.calls).toEqual([]);
  });

  test("5 realRunWallCap logs the run already in progress", () => {
    const report = driveCappedLoop([{ realRunWallS: 103 * 3600 }, {}]);
    expect(report.calls).toEqual(["role:1", "real:1"]);
    expect(report.loggedRuns).toEqual([1]);
    expect(report.reason).toBe("realRunWallCap");
  });

  test("6 a forged trace cannot change the read-only totals", () => {
    const text = python(`
import loop_mode
usage = {"prompt_tokens": 4, "completion_tokens": 1, "prompt_tokens_details": {"cached_tokens": 0}}
huge = {"prompt_tokens": 10 ** 9, "completion_tokens": 1, "prompt_tokens_details": {"cached_tokens": 0}}
events = [
    {"type": "done", "role": "critic", "status": 200, "usage": usage},
    {"type": "done", "role": "executor", "status": 200, "usage": huge},
]
print(loop_mode.read_only_tokens(events, {"tokens": 10 ** 9}))
`);
    expect(text).toBe("5");
  });

  test("7 fault rounds and reviewer rejects are counted apart", () => {
    const report = driveCappedLoop([{ hostFault: true }, { reviewerReject: true }]);
    expect(report.faultRounds).toBe(1);
    expect(report.reviewerRejectRounds).toBe(1);
    expect(report.reason).toBeNull();
    for (const kind of ["attest_mismatch", "reward", "round0Record"]) {
      const stopped = driveCappedLoop([{ antiForgery: kind }, {}]);
      expect(stopped.reason).toBe("anti_forgery");
      expect(stopped.calls).toEqual(["role:1", "real:1"]);
      expect(stopped.loggedRuns).toEqual([1]);
    }
    const budget = python(`
import loop_mode
critic = {"type": "done", "role": "critic", "status": 200, "round": 1, "usage": {"prompt_tokens": 3000000, "completion_tokens": 0, "prompt_tokens_details": {"cached_tokens": 0}}}
innovator = {"type": "done", "role": "innovator", "status": 200, "round": 1, "usage": {"prompt_tokens": 30000000, "completion_tokens": 0, "prompt_tokens_details": {"cached_tokens": 0}}}
rank = loop_mode.budget_status([critic])
wide = loop_mode.budget_status([innovator])
assert rank["ranking"]["capHit"] and rank["ranking"]["reason"] == "no_winner:cap_hit" and not rank["readOnlyCapHit"]
assert not wide["ranking"]["capHit"] and wide["readOnlyCapHit"]
print("ok")
`);
    expect(budget).toBe("ok");
  });

  test("8 bind_role_call requires the role's own relay record", () => {
    const text = python(`
import loop_mode
run_id = "ab" * 16
call = {"seq": 1, "runId": run_id, "outputSha": "aa" * 32}
events = [
    {"type": "req", "seq": 1, "runId": run_id},
    {"type": "done", "seq": 1, "role": "critic", "respSha": "aa" * 32},
]
assert loop_mode.bind_role_call("critic", call, events, session_text="forged")["ok"]
assert loop_mode.bind_role_call("ranker", call, [], "session only")["reason"] == "missing_relay_record"
wrong = loop_mode.bind_role_call("reviewer", call, [
    {"type": "req", "seq": 1, "runId": "cd" * 16},
    {"type": "done", "seq": 1, "respSha": "aa" * 32},
])
assert wrong["reason"] == "wrong_runId"
mismatch = loop_mode.bind_role_call("critic", call, [
    {"type": "req", "seq": 1, "runId": run_id},
    {"type": "done", "seq": 1, "respSha": "bb" * 32},
])
assert mismatch["reason"] == "respSha_mismatch"
try:
    loop_mode.bind_role_call("gap", call, events)
    raise SystemExit("gap")
except ValueError:
    pass
print("ok")
`);
    expect(text).toBe("ok");
  });

  test("9 exclusion recomputes and an empty set is ranker_invalid", () => {
    const text = python(`
import json, loop_mode
one = loop_mode.exclude_and_recompute(
    [{"id": "a", "changedKeys": 2, "configSha": "s"}, {"id": "b", "changedKeys": 1, "configSha": "t"}],
    ["a"],
)
none = loop_mode.exclude_and_recompute([{"id": "a"}, {"id": "b"}], ["a", "b"])
assert one["status"] == "winner" and one["winner"] == "b"
assert none == {"status": "no_winner", "reason": "ranker_invalid"}
print("ok")
`);
    expect(text).toBe("ok");
  });

  test("10 the agent container does not mount /home/box", () => {
    const text = python(`
import hooks
from harness_relay import new_run_id
run_id = new_run_id()
try:
    hooks.container_argv(
        image="img", run_id=run_id, port=1, network="devii-004-int", env={},
        mounts=[("/home/box/.harness-relay/abc", "/relay")], command=["run"],
    )
    raise SystemExit("mounted")
except ValueError as exc:
    assert "home/box" in str(exc)
argv = hooks.container_argv(
    image="img", run_id=run_id, port=1, network="devii-004-int", env={},
    mounts=[("/src/config", "/config")], command=["run"],
)
assert "/home/box" not in "\\n".join(argv)
print("ok")
`);
    expect(text).toBe("ok");
  });

  test("11 serial runs keep --cap-drop NET_RAW", () => {
    const text = python(`
import hooks
from harness_relay import new_run_id
for _ in range(2):
    argv = hooks.container_argv(
        image="img", run_id=new_run_id(), port=1, network="devii-004-int", env={},
        mounts=[("/src/a", "/a")], command=["run"],
    )
    assert argv[argv.index("--cap-drop") + 1] == "NET_RAW"
    assert "/home/box" not in "\\n".join(argv)
print("ok")
`);
    expect(text).toBe("ok");
  });

  test("12 the host copies verifier to the relay checker dir before the copy sha is returned", () => {
    const text = python(`
import tempfile
from pathlib import Path
import hooks
root = Path(tempfile.mkdtemp())
run = root / "run"
verifier = run / "verifier"
verifier.mkdir(parents=True)
(verifier / "reward.txt").write_bytes(b"1\\n")
run_id = "ab" * 16
copied = hooks.copy_checker_before_sign(run, run_id, relay_root=root / "relay")
dest = Path(copied["dest"])
assert dest == root / "relay" / run_id / "checker"
assert (dest / "reward.txt").read_bytes() == b"1\\n"
print(copied["sha"])
`);
    expect(text).toMatch(/^[0-9a-f]{64}$/);
  });

  test("13 a signed round-0 copy passes and a changed copy stops", () => {
    const text = python(`
import hashlib, os, stat, tempfile
from pathlib import Path
import plant, loop_mode
from ledger import read_evidence
key = b"k" * 32
root = Path(tempfile.mkdtemp())
body = b"alpha\\nbeta\\ngamma\\n"
src = root / "trace.jsonl"
src.write_bytes(body)
dest = root / "private" / "round0-trace.jsonl"
signed = loop_mode.pre_round1_sign(key, seed=b"s" * 32, ranker={"tools": ["read"]}, critic={"tools": ["read"]}, round0_src=src, host_copy_path=dest)
assert loop_mode.verify_pre_round1(signed, key)
record = signed["round0Record"]
assert record["srcSha256"] == hashlib.sha256(body).hexdigest()
assert Path(record["hostCopyPath"]).read_bytes() == body
assert stat.S_IMODE(dest.parent.stat().st_mode) == 0o700
log = root / "gap.jsonl"
run_id = "ab" * 16
plant.plant_read(log, run_id, record["hostCopyPath"])
assert read_evidence(log, record["hostCopyPath"], record["srcSha256"])["ok"]
other = root / "unsigned.jsonl"
other.write_bytes(body)
ulog = root / "unsigned-log.jsonl"
plant.plant_read(ulog, run_id, other)
assert read_evidence(ulog, record["hostCopyPath"], record["srcSha256"])["ok"] is False
flipped = bytearray(Path(record["hostCopyPath"]).read_bytes())
flipped[0] ^= 1
Path(record["hostCopyPath"]).write_bytes(bytes(flipped))
assert read_evidence(log, record["hostCopyPath"], record["srcSha256"])["reason"] == "file_sha"
forged = dict(signed)
forged["round0Record"] = dict(record)
forged["round0Record"]["srcSha256"] = "0" * 64
assert loop_mode.verify_pre_round1(forged, key) is False
stopped = loop_mode.drive([{"anti_forgery": "round0Record"}, {}])
assert stopped["reason"] == "anti_forgery" and "role:2" not in stopped["calls"]
declared = loop_mode.declared_round0()
assert declared["srcSha256"] == "${ROUND0}"
assert declared["hostCopyPath"] == ""
print("ok")
`);
    expect(text).toBe("ok");
  });

  test("14 tampered reward or checker output stops and the checker path is not mounted", () => {
    const text = python(`
import json, stat, tempfile
from pathlib import Path
import hooks, loop_mode
key = b"k" * 32
root = Path(tempfile.mkdtemp())
run = root / "run"
verifier = run / "verifier"
verifier.mkdir(parents=True)
(verifier / "reward.txt").write_text("1\\n", encoding="utf-8")
(run / "result.json").write_text(json.dumps({"reward": 1}) + "\\n", encoding="utf-8")
run_id = "ab" * 16
copied = hooks.copy_checker_before_sign(run, run_id, relay_root=root / "relay")
dest = Path(copied["dest"])
assert stat.S_IMODE(dest.stat().st_mode) == 0o700
sig = hooks.sign_run_record(key, dest, expected_run_id=run_id)
assert hooks.verify_run_record(sig, dest, 1, key, container_dir=run)["ok"]
assert hooks.verify_notes_reward("reward: 1\\n", sig, dest, key)["ok"]
(verifier / "reward.txt").write_text("0\\n", encoding="utf-8")
assert hooks.verify_run_record(sig, dest, sig["reward"], key, container_dir=run)["reason"] == "attest_mismatch"
(verifier / "reward.txt").write_text("1\\n", encoding="utf-8")
(run / "result.json").write_text(json.dumps({"reward": 0}) + "\\n", encoding="utf-8")
assert hooks.verify_run_record(sig, dest, sig["reward"], key, container_dir=run)["reason"] == "attest_mismatch"
(run / "result.json").write_text(json.dumps({"reward": 1}) + "\\n", encoding="utf-8")
(dest / "reward.txt").write_text("0\\n", encoding="utf-8")
assert hooks.verify_run_record(sig, dest, sig["reward"], key, container_dir=run)["reason"] == "attest_mismatch"
(dest / "reward.txt").write_text("1\\n", encoding="utf-8")
assert hooks.verify_notes_reward("reward: 0\\n", sig, dest, key)["reason"] == "attest_mismatch"
assert hooks.verify_run_record(sig, dest, 1, key, container_dir=run)["ok"]
stopped = loop_mode.drive([{"anti_forgery": "attest_mismatch"}, {}])
assert stopped["reason"] == "anti_forgery" and stopped["calls"] == ["role:1", "real:1"]
default = str(hooks.checker_dest(run_id))
assert default == "/home/box/.harness-relay/%s/checker" % run_id
try:
    hooks.container_argv(image="img", run_id=run_id, port=1, network="devii-004-int", env={}, mounts=[(default, "/checker")], command=["run"])
    raise SystemExit("mounted")
except ValueError as exc:
    assert "home/box" in str(exc)
argv = hooks.container_argv(image="img", run_id=run_id, port=1, network="devii-004-int", env={}, mounts=[("/src/config", "/config")], command=["run"])
blob = "\\n".join(argv)
assert "/home/box" not in blob and default not in blob
print("ok")
`);
    expect(text).toBe("ok");
  });
});
