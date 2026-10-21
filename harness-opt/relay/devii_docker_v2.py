#!/usr/bin/env python3
"""dev-II box docker runner v2 (2026-10-21, 平台工程): per-task timeouts from task.toml, allow_internet=false -> gateway-only.
Original devii_docker.py is left untouched.
Original doc: dev-II Round1 box docker runner (env-addendum.json run_spec). No secrets in this file.
Usage:
  devii_docker.py plan                       # print fixed order
  devii_docker.py smoke <task>               # cold smoke, no model call
  devii_docker.py run <runId> <batch> --execute   # real runs (needs API_KEY in the host env; NOT used by smoke)
  devii_docker_v2.py limits <task>...        # print parsed timeouts/network, no docker, no model
  devii_docker_v2.py groups                    # print probe/heldout/minloop task lists
  devii_docker_v2.py plan <probe|heldout|minloop|all> [k]
The host execute path requires API_KEY in the environment and does not pass it into the container.
Agent argv comes from hooks.container_argv: network devii-004-int, --cap-drop NET_RAW, relay BASE_URL.
The checker uses the same builder with expose_relay=False, so it has no model access.
Before the agent starts, the task network must exist and the relay must be listening on 10.204.0.1."""
import fcntl, json, os, secrets, shutil, socket, subprocess, sys, time, hashlib, tomllib
from pathlib import Path
import hooks
IMAGE="registry.bohrium.dp.tech/dptech/dp/native/prod-4721445/4644300/pi-bio-harness@sha256:b87d5c47f5231cc91a71d0ba5e03ea7a1ecbe12d0e4e7685761d91018213ab9c"
DATA=Path("/workspace/contest-data/devii"); LAKE=DATA/"shared/data_lake"
HOME=Path("/workspace/harness-opt-runs"); CFG=HOME/"config"
PATCHED=CFG/"harness.patched.mjs"; PATCHED_SHA="3f4a45ea484a8d645edb8f10e6b57aefeff5a4a7d2938fc95d1870bfa125efd1"
MODEL="deepseek-v4-1-flash-261017"
TASKS=["tasks1/003-tsa-seq-robust-domain-discovery","tasks2/i006","tasks3/hb008","tasks1/004-dims-pqn-batch-qc","tasks2/i028"]  # prereg tasks.selected order
BATCH={"1":["tasks1/003-tsa-seq-robust-domain-discovery","tasks3/hb008","tasks1/004-dims-pqn-batch-qc"],"2":["tasks2/i006","tasks2/i028"]}
ARM_ORDER={0:["control","treatment"],1:["treatment","control"]}
NET={"tasks1/004-dims-pqn-batch-qc":"gateway-only","tasks1/002-bigwig-h3k27ac-igg-peak-audit":"gateway-only"}  # 002 fixed gateway-only (method-r5); allow_internet=false also forces gateway-only

# Groups (method-r5): probe excludes env-restricted 001; held-out unchanged; minloop = i006+hb008.
GROUPS={
  "probe": ["tasks2/i014","tasks3/hb002","tasks3/hb016"],
  "heldout": ["tasks1/002-bigwig-h3k27ac-igg-peak-audit","tasks2/i030","tasks3/hb003"],
  "minloop": ["tasks2/i006","tasks3/hb008"],
}
# W = max WSL tokens (i+o+cR) per plan §9.2; single-run token cap = 6*W (method-r3).
TOKEN_W={
  "tasks2/i014": 1_625_811,
  "tasks3/hb002": 2_010_611,
  "tasks3/hb016": 5_776_521,
  "tasks2/i006": 564_229,
  "tasks3/hb008": 488_365,
  "tasks1/002-bigwig-h3k27ac-igg-peak-audit": 2_383_647,
  "tasks2/i030": 4_876_782,
  "tasks3/hb003": 9_024_166,
  # 001 env-restricted (method-r5); kept for documentation only, not in GROUPS
  "tasks1/001-cnvnator-read-depth-cnv": 2_648_108,
}
def token_cap(task):
  if task not in TOKEN_W: raise KeyError(f"no TOKEN_W for {task}")
  return 6 * TOKEN_W[task]
def tokens_from_usage(usage):
  """usage: dict with input/output/cacheRead (and optional cacheWrite, ignored for cap)."""
  u=usage or {}
  return int(u.get("input") or 0)+int(u.get("output") or 0)+int(u.get("cacheRead") or 0)
def tokens_from_trace(path):
  total=0
  p=Path(path)
  if not p.is_file(): return 0
  for line in p.read_text(errors="replace").splitlines():
    line=line.strip()
    if not line: continue
    try: j=json.loads(line)
    except Exception: continue
    if j.get("type")=="assistant_message":
      total += tokens_from_usage(j.get("usage"))
  return total
def check_token_cap(task, tokens_used):
  """Return (ok, cap, tokens). ok False => terminate & record unscored (budget guard, not score 0)."""
  cap=token_cap(task)
  return (tokens_used <= cap, cap, tokens_used)

TOML_MIRROR=Path("/workspace/company/evidence/2026-10-21-devii-task-toml")  # read-only copies from WSL zip, SHA256SUMS checked
def task_toml_path(task):
    for p in (DATA/task/"task.toml", DATA/task/"task"/"task.toml"):
        if p.is_file(): return p
    for rel in (Path(task)/"task.toml", Path(task)/"task"/"task.toml"):
        p=TOML_MIRROR/rel
        if p.is_file():
            sums={l.split()[1].lstrip("./"):l.split()[0] for l in (TOML_MIRROR/"SHA256SUMS").read_text().splitlines() if l.strip()}
            assert sums.get(str(rel))==hashlib.sha256(p.read_bytes()).hexdigest(), f"task.toml mirror sha mismatch: {rel}"
            return p
    raise FileNotFoundError(f"task.toml missing for {task} (r3 rule 4: do not run, record 缺材料)")
def limits(task):
    """agent/verifier timeout_sec and allow_internet from the official task.toml. No default: missing -> error."""
    d=tomllib.loads(task_toml_path(task).read_text())
    a=d["agent"]["timeout_sec"]; v=d["verifier"]["timeout_sec"]
    assert isinstance(a,(int,float)) and a>0 and isinstance(v,(int,float)) and v>0, f"bad timeout in {task}"
    return {"agent_timeout_sec":int(a),"verifier_timeout_sec":int(v),"allow_internet":bool(d.get("environment",{}).get("allow_internet",True))}
def net_mode(task):
    if NET.get(task)=="gateway-only" or not limits(task)["allow_internet"]: return "gateway-only"
    return "open"
def order(tasks):
    return [(s,t,a) for s in (0,1) for t in TASKS if t in tasks for a in ARM_ORDER[s]]
def relay_port():
    port=int(os.environ.get("HARNESS_RELAY_PORT","8642"))
    if port<=0: raise ValueError("relay port")
    return port
def require_relay_log_root(value):
    """Scored mode copies and signs the checker. A missing relay log root is not a skip."""
    if not isinstance(value, str) or value.strip()=="":
        raise RuntimeError("scored run needs relayLogRoot")
    return value
def one_run_lock(path):
    """Exclusive host lock. A second process gets RuntimeError instead of a second container."""
    dest=Path(path)
    dest.parent.mkdir(parents=True, exist_ok=True)
    fd=os.open(dest, os.O_CREAT|os.O_RDWR, 0o600)
    try:
        fcntl.flock(fd, fcntl.LOCK_EX|fcntl.LOCK_NB)
    except OSError as exc:
        os.close(fd)
        raise RuntimeError("one run at a time") from exc
    return fd
def release_run_lock(fd):
    fcntl.flock(fd, fcntl.LOCK_UN)
    os.close(fd)
def _with_run_flags(argv, name, *, workdir, entrypoint, extra=()):
    """Keep container_argv's network, cap-drop, env, and mounts. Operational flags go in front of them."""
    return ["sudo","-E",*argv[:3],"--name",name,*extra,"-w",workdir,"--entrypoint",entrypoint,*argv[3:]]
def agent_mounts(task, run, arm):
    """Existing mounts: this run directory, CFG, and the tasks2 data lake under contest-data."""
    run=Path(run)
    mounts=[
        (str(PATCHED), "/opt/harness/src/harness.mjs:ro"),
        (str(run/"public"), "/input/task:ro"),
        (str(run/"workspace"), "/workspace"),
        (str(CFG/f"{arm}.json"), "/cfg/candidate.json:ro"),
    ]
    if str(task).startswith("tasks2/"):
        mounts.append((str(LAKE), "/shared/data_lake:ro"))
    return mounts
def agent_cmd(task, run, arm, name, *, run_id, port):
    """Agent argv comes only from hooks.container_argv, which drops NET_RAW and refuses /home/box."""
    argv=hooks.container_argv(
        image=IMAGE, run_id=run_id, port=port, network="devii-004-int",
        env={
            "HARNESS_WORKSPACE":"/workspace/runs",
            "HARNESS_CANDIDATE_CONFIG":"/cfg/candidate.json",
            "OMP_NUM_THREADS":"4",
            "OPENBLAS_NUM_THREADS":"4",
        },
        mounts=agent_mounts(task, run, arm),
        command=["/opt/harness/run.sh","--task","/input/task/instruction.md","--model-name",MODEL],
    )
    return _with_run_flags(argv, name, workdir="/root", entrypoint="bash", extra=("--cpus","4","--memory","8g"))
def stage_public(task, dst):
    src=DATA/task
    if dst.exists(): shutil.rmtree(dst)
    dst.mkdir(parents=True)
    shutil.copy2(src/"instruction.md", dst/"instruction.md")
    shutil.copytree(src/"environment", dst/"environment", symlinks=True)
    if task.startswith("tasks2/"):
        link=dst/"environment/data/data_lake"
        if not link.is_symlink(): link.symlink_to("/shared/data_lake")
def check_inputs():
    assert hashlib.sha256(PATCHED.read_bytes()).hexdigest()==PATCHED_SHA, "patched harness sha mismatch"
    r=subprocess.run(["sha256sum","-c","--quiet","/workspace/company/evidence/2026-10-19-harness-opt-devii-round1/data-SHA256SUMS"],cwd=DATA)
    assert r.returncode==0, "data-SHA256SUMS mismatch"
def checker_cmd(task, run, actual_rel, name, *, run_id, port):
    run=Path(run)
    mounts=[
        (str(DATA/task/"tests"), "/tests:ro"),
        (str(run/"workspace"/actual_rel/"outputs"), "/app/outputs:ro"),
        (str(run/"verifier"), "/logs/verifier"),
        (str(run/"workspace"/actual_rel), "/root/code:ro"),
    ]
    if str(task).startswith("tasks2/"):
        mounts.append((str(LAKE), "/shared/data_lake:ro"))
    argv=hooks.container_argv(
        image=IMAGE, run_id=run_id, port=port, network="devii-004-int", env={},
        mounts=mounts, command=["/tests/test.sh"], expose_relay=False,
    )
    return _with_run_flags(argv, name, workdir="/root/code", entrypoint="bash")
def _docker_network_present(network):
    completed=subprocess.run(["sudo","docker","network","inspect",network],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
    return completed.returncode==0
def _relay_reachable(host, port):
    with socket.create_connection((host, int(port)), timeout=2):
        return None
def assert_task_network(network="devii-004-int", host="10.204.0.1", port=8642, *, inspect=None, connect=None):
    """Fail before docker when the task network is missing or the relay is not listening."""
    present=(inspect or _docker_network_present)(network)
    if not present:
        raise RuntimeError(f"docker network {network} is missing")
    try:
        (connect or _relay_reachable)(host, int(port))
    except OSError as exc:
        raise RuntimeError(f"relay is not listening on {host}:{port}") from exc
def start_agent_container(task, run, arm, name, *, run_id, port, relay_log_root, lock_path, popen=subprocess.Popen, popen_kwargs=None, preflight=None):
    """Production launch: refuse a scored run without a relay log root, check the network, hold the host lock, then build argv via container_argv."""
    require_relay_log_root(relay_log_root)
    check=preflight or assert_task_network
    check(network="devii-004-int", host="10.204.0.1", port=port)
    fd=one_run_lock(lock_path)
    try:
        argv=agent_cmd(task, run, arm, name, run_id=run_id, port=port)
        proc=popen(argv, **(popen_kwargs or {}))
    except BaseException:
        release_run_lock(fd)
        raise
    return proc, fd
def finalize_launch(run, relay_id, relay_log_root, res):
    """Record the host run id and copy checker output under that id before result.json is written."""
    root=require_relay_log_root(relay_log_root)
    if not isinstance(relay_id, str) or len(relay_id)!=32:
        raise ValueError("run id")
    recorded=dict(res)
    recorded["relay_id"]=relay_id
    recorded["runId"]=relay_id
    recorded["relayLogRoot"]=root
    if "checker_exit" in recorded and recorded["checker_exit"]!="skipped_token_cap":
        copied=hooks.copy_checker_before_sign(run, relay_id, relay_root=root)
        recorded["checkerOutputSha"]=copied["sha"]
        recorded["checkerDest"]=copied["dest"]
    path=Path(run)/"result.json"
    path.write_text(json.dumps(recorded, indent=1))
    return recorded
def main():
    a=sys.argv[1:]
    if a[:1]==["groups"]:
        print(json.dumps(GROUPS, indent=2))
    elif a[:1]==["plan"]:
        # plan <probe|heldout|minloop|all> [k]  OR  legacy plan <1|2>
        if len(a)>=2 and a[1] in ("probe","heldout","minloop","all"):
            name=a[1]; k=int(a[2]) if len(a)>2 else 3
            if name=="all":
                items=[("probe",t,k) for t in GROUPS["probe"]]+[("heldout",t,k) for t in GROUPS["heldout"]]+[("minloop",t,3) for t in GROUPS["minloop"]]
            elif name=="minloop":
                items=[("minloop",t,3) for t in GROUPS["minloop"]]
            else:
                items=[(name,t,k) for t in GROUPS[name]]
            n=0
            for g,t,kk in items:
                for seed in range(kk):
                    n+=1
                    print(n, g, f"seed{seed}", t, "cap", token_cap(t), "net", net_mode(t))
        else:
            tasks=BATCH[a[1]] if len(a)>1 else TASKS
            for i,(s,t,arm) in enumerate(order(tasks),1): print(i,f"seed{s}",t,arm)
    elif a[:1]==["limits"]:
        for t in a[1:]: print(json.dumps({"task":t,**limits(t),"net":net_mode(t),"token_cap":token_cap(t),"W":TOKEN_W[t]}))
    elif a[:1]==["run"] and "--execute" in a:
        assert os.environ.get("API_KEY"), "API_KEY not in env"
        relay_root=require_relay_log_root(os.environ.get("HARNESS_RELAY_LOG_ROOT",""))
        port=relay_port(); lock_path=os.environ.get("HARNESS_RUN_LOCK", str(HOME/".devii-one-run.lock"))
        check_inputs(); batch,b=a[1],a[2]
        for s,t,arm in order(BATCH[b]):
            run=HOME/f"round1-{batch}"/t.split("/")[1]/f"seed{s}"/arm
            for d in ["workspace","verifier"]: (run/d).mkdir(parents=True,exist_ok=True)
            stage_public(t, run/"public"); name=f"devii-{batch}-{t.split('/')[1][:12]}-{s}-{arm}"
            lim=limits(t); t0=time.time(); timed_out=False; token_killed=False
            tokens_used=0; cap=token_cap(t)
            relay_id=secrets.token_hex(16)
            lock_fd=None
            try:
                with open(run/"devii_one.log","w") as log:
                    proc, lock_fd=start_agent_container(
                        t, run, arm, name, run_id=relay_id, port=port, relay_log_root=relay_root, lock_path=lock_path,
                        popen_kwargs={"stdout":log,"stderr":subprocess.STDOUT},
                    )
                    try:
                        while True:
                            try:
                                rc=proc.wait(timeout=15)
                                break
                            except subprocess.TimeoutExpired:
                                # mid-run token guard: poll newest trace.jsonl every 15s
                                staged_live=sorted((run/"workspace/runs").glob("task-*"))
                                if staged_live:
                                    tokens_used=tokens_from_trace(staged_live[-1]/"trace.jsonl")
                                    if not check_token_cap(t, tokens_used)[0]:
                                        token_killed=True; subprocess.run(["sudo","docker","kill",name],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
                                        try: proc.wait(timeout=60)
                                        except subprocess.TimeoutExpired: proc.kill()
                                        rc="token_cap"; break
                                if time.time()-t0 >= lim["agent_timeout_sec"]:
                                    subprocess.run(["sudo","docker","kill",name]); timed_out=True; rc="timeout"
                                    try: proc.wait(timeout=60)
                                    except subprocess.TimeoutExpired: proc.kill()
                                    break
                    except Exception:
                        proc.kill(); raise
                staged=sorted((run/"workspace/runs").glob("task-*"))
                if staged and not token_killed:
                    tokens_used=tokens_from_trace(staged[-1]/"trace.jsonl")
                    if not check_token_cap(t, tokens_used)[0]:
                        token_killed=True; rc="token_cap"
                res={"task":t,"seed":s,"arm":arm,"exit":rc,"wall_s":round(time.time()-t0,1),"image":IMAGE,"timed_out":timed_out,"token_killed":token_killed,"tokens_used":tokens_used,"token_cap":cap,**lim,"net":net_mode(t)}
                if token_killed:
                    res["score_status"]="unscored"; res["unscored_reason"]="token_cap_exceeded"
                if staged and not token_killed:
                    rel=staged[-1].relative_to(run/"workspace")
                    # r3 rule 2: after an agent timeout the checker still runs on whatever is in outputs
                    try: res["checker_exit"]=subprocess.run(checker_cmd(t,run,rel,name+"-chk",run_id=relay_id,port=port),stdout=open(run/"checker.log","w"),stderr=subprocess.STDOUT,timeout=lim["verifier_timeout_sec"]).returncode
                    except subprocess.TimeoutExpired: subprocess.run(["sudo","docker","kill",name+"-chk"]); res["checker_exit"]="timeout"
                elif token_killed:
                    res["checker_exit"]="skipped_token_cap"
                recorded=finalize_launch(run, relay_id, relay_root, res)
                print(json.dumps(recorded),flush=True)
            finally:
                if lock_fd is not None:
                    release_run_lock(lock_fd)
    else: print(__doc__)
if __name__=="__main__": main()
