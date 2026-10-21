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
  devii_docker_v2.py once --task <id> --seed <n> --arm control|candidate --config <file> --run-dir <dir> --harness <file>
The batch execute path requires API_KEY in the host environment and does not pass that value into the container.
`once` does not read the host API_KEY. The agent container receives only hooks.PLACEHOLDER_API_KEY.
The relay replaces Authorization with the key from RELAY_UPSTREAM_KEY_FILE. The container BASE_URL is the relay.
Agent argv comes from hooks.container_argv: network devii-004-int, --cap-drop NET_RAW, relay BASE_URL.
The checker uses the same builder with expose_relay=False, so it has no model access.
Before the agent starts, the task network must exist and the relay must be listening on 10.204.0.1.
`once` mounts harness sha 4d4e12e51958650b5ee6f4768f1bd809202ecec23a4db6ef910bfcc36222fd8c and refuses any other file."""
import fcntl, json, os, secrets, shutil, socket, subprocess, sys, time, hashlib, tomllib
from pathlib import Path
import hooks
IMAGE="registry.bohrium.dp.tech/dptech/dp/native/prod-4721445/4644300/pi-bio-harness@sha256:b87d5c47f5231cc91a71d0ba5e03ea7a1ecbe12d0e4e7685761d91018213ab9c"
DATA=Path("/workspace/contest-data/devii"); LAKE=DATA/"shared/data_lake"
HOME=Path("/workspace/harness-opt-runs"); CFG=HOME/"config"
PATCHED=CFG/"harness.patched.mjs"; PATCHED_SHA="3f4a45ea484a8d645edb8f10e6b57aefeff5a4a7d2938fc95d1870bfa125efd1"
# Box prereq harness. Once refuses any other bytes. There is no allow-override.
HARNESS_SHA="4d4e12e51958650b5ee6f4768f1bd809202ecec23a4db6ef910bfcc36222fd8c"
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
def check_token_cap(task, tokens_used):
  """Return (ok, cap, tokens). ok False => terminate & record unscored (budget guard, not score 0)."""
  cap=token_cap(task)
  return (tokens_used <= cap, cap, tokens_used)
def relay_request_count(relay_root, run_id):
  """How many relay req lines this run wrote. open and done do not count."""
  path=Path(relay_root)/run_id/"relay.jsonl"
  if not isinstance(run_id, str) or run_id.strip()=="" or not path.is_file():
    return 0
  count=0
  for line in path.read_text().splitlines():
    if not line.strip():
      continue
    try:
      row=json.loads(line)
    except json.JSONDecodeError:
      continue
    if isinstance(row, dict) and row.get("type")=="req":
      count+=1
  return count
def _memory_tokens(report):
  """Close-report tokens are the in-memory total. Anything else is null."""
  if not isinstance(report, dict) or "tokens" not in report:
    return None
  value=report.get("tokens")
  if isinstance(value, bool) or not isinstance(value, int):
    return None
  return value
def relay_usage_tokens(relay_root, run_id):
  """i+o+cacheRead from the relay log only. An agent trace is not a token source.

  A missing log or a blank run id is usage_missing, not a zero-token scored run.
  """
  from ledger import load, tokens as relay_tokens
  if not isinstance(run_id, str) or run_id.strip() == "":
    return 0, True
  path=Path(relay_root)/run_id/"relay.jsonl"
  if not path.is_file():
    return 0, True
  info=relay_tokens(load(path))
  if info["usage_missing"]:
    return int(info["observed"] or 0), True
  return int(info["tokens"] or 0), False

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
def agent_mounts(task, run, arm, harness=None, config=None):
    """Existing mounts: this run directory, the harness file, the candidate config, and the tasks2 data lake."""
    run=Path(run)
    harness_src=Path(harness) if harness else PATCHED
    config_src=Path(config) if config else CFG/f"{arm}.json"
    mounts=[
        (str(harness_src), "/opt/harness/src/harness.mjs:ro"),
        (str(run/"public"), "/input/task:ro"),
        (str(run/"workspace"), "/workspace"),
        (str(config_src), "/cfg/candidate.json:ro"),
    ]
    if str(task).startswith("tasks2/"):
        mounts.append((str(LAKE), "/shared/data_lake:ro"))
    return mounts
def agent_cmd(task, run, arm, name, *, run_id, port, harness=None, config=None, model=None):
    """Agent argv comes only from hooks.container_argv, which drops NET_RAW and refuses /home/box."""
    argv=hooks.container_argv(
        image=IMAGE, run_id=run_id, port=port, network="devii-004-int",
        env={
            "HARNESS_WORKSPACE":"/workspace/runs",
            "HARNESS_CANDIDATE_CONFIG":"/cfg/candidate.json",
            "OMP_NUM_THREADS":"4",
            "OPENBLAS_NUM_THREADS":"4",
        },
        mounts=agent_mounts(task, run, arm, harness=harness, config=config),
        command=["/opt/harness/run.sh","--task","/input/task/instruction.md","--model-name", model or MODEL],
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

class OnceError(RuntimeError):
    pass

def resolve_task(task):
    """A config id such as hb003, or the TOKEN_W path tasks3/hb003."""
    raw=str(task).strip().strip("/")
    if raw in TOKEN_W:
        return raw
    matches=[key for key in TOKEN_W if key.split("/")[-1]==raw]
    if len(matches)!=1:
        raise OnceError(f"unknown task {task}")
    return matches[0]

def assert_harness(path):
    """Refuse before docker unless the file is exactly HARNESS_SHA."""
    file=Path(path)
    if file.is_symlink() or not file.is_file():
        raise OnceError("harness sha")
    digest=hashlib.sha256(file.read_bytes()).hexdigest()
    if digest!=HARNESS_SHA:
        raise OnceError("harness sha")
    return digest

def _once_args(argv):
    flags={}
    index=0
    items=list(argv)
    while index<len(items):
        arg=items[index]
        if arg=="--relay-external":
            flags["relay-external"]=True
            index+=1
            continue
        if arg=="--reconcile":
            flags["reconcile"]=True
            index+=1
            continue
        if not arg.startswith("--"):
            raise OnceError(f"unexpected {arg}")
        key=arg[2:]
        if index+1>=len(items) or str(items[index+1]).startswith("--"):
            raise OnceError(f"missing --{key}")
        flags[key]=items[index+1]
        index+=2
    return flags

def _file_sha(path):
    file=Path(path)
    if file.is_symlink() or not file.is_file():
        return None
    return hashlib.sha256(file.read_bytes()).hexdigest()

def _tree_shas(root):
    base=Path(root)
    if base.is_symlink() or not base.is_dir():
        return {}
    out={}
    for dirpath, dirnames, filenames in os.walk(base, followlinks=False):
        kept=[]
        for name in dirnames:
            if not (Path(dirpath)/name).is_symlink():
                kept.append(name)
        dirnames[:] = kept
        for name in filenames:
            path=Path(dirpath)/name
            if path.is_symlink() or not path.is_file():
                continue
            out[path.relative_to(base).as_posix()]=hashlib.sha256(path.read_bytes()).hexdigest()
    return out

def _attest_key():
    import harness_relay
    path=os.environ.get("HARNESS_ATTEST_KEY_FILE") or ""
    if path.strip()=="":
        raise OnceError("HARNESS_ATTEST_KEY_FILE")
    try:
        return harness_relay._read_secret(path)
    except (OSError, RuntimeError) as exc:
        raise OnceError("HARNESS_ATTEST_KEY_FILE") from exc

def write_run_attestation(attest_dir, run, *, key, harness, config, reward, meta):
    """Host attestation outside the run dir. HMAC bytes match canon.canonical."""
    import canon
    attest=Path(attest_dir)
    run_dir=Path(run)
    attest_abs=os.path.abspath(attest)
    run_abs=os.path.abspath(run_dir)
    if attest_abs==run_abs or attest_abs.startswith(run_abs+os.sep) or run_abs.startswith(attest_abs+os.sep):
        raise OnceError("attest dir overlaps the run dir")
    body={
        "schema": "devii-opt-attest/v1",
        "mountedHarnessSha": _file_sha(harness),
        "mountedConfigSha": _file_sha(config),
        "traceSha": _file_sha(run_dir/"trace.jsonl"),
        "piSessionShas": _tree_shas(run_dir/".pi-sessions"),
        "outputShas": _tree_shas(run_dir/"outputs"),
        "reward": reward,
        "rewardFileSha": _file_sha(run_dir/"verifier"/"reward.txt"),
        "resultSha": _file_sha(run_dir/"result.json"),
        "run": meta,
    }
    if not isinstance(body["mountedHarnessSha"], str) or not isinstance(body["mountedConfigSha"], str):
        raise OnceError("attestation sha")
    signed={**body, "hmacSha256": hmac_sha(key, canon.canonical(body))}
    attest.mkdir(parents=True, exist_ok=True)
    (attest/"attestation.json").write_text(json.dumps(signed, indent=2, ensure_ascii=False)+"\n")
    return signed

def hmac_sha(key, payload):
    import hmac as hmac_mod
    return hmac_mod.new(key, payload, hashlib.sha256).hexdigest()

def _standalone_relay(relay_root, port):
    import harness_relay
    attest=os.environ.get("HARNESS_ATTEST_KEY_FILE") or ""
    upstream=os.environ.get("RELAY_UPSTREAM_KEY_FILE") or ""
    if attest.strip()=="" or upstream.strip()=="":
        raise OnceError("HARNESS_ATTEST_KEY_FILE and RELAY_UPSTREAM_KEY_FILE")
    relay = harness_relay.Relay(
        port=port, log_root=str(relay_root), upstream_key_file=upstream, attest_key_file=attest,
        bind_host=harness_relay.BIND_HOST, plant_enabled=False,
    )
    harness_relay.use_network_upstream(relay)
    return relay

def _docker_prefix():
    """`sudo -E docker`, the prefix `_with_run_flags` puts on `hooks.container_argv`."""
    argv=hooks.container_argv(
        image="img", run_id="00"*16, port=1, network="devii-004-int",
        env={}, mounts=[], command=["true"], expose_relay=False,
    )
    if not argv or argv[0]!="docker":
        raise OnceError("docker")
    return ["sudo","-E",argv[0]]

def _kill_container(name, call):
    call(_docker_prefix()+["kill",name], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

def _clear_orphan_container(name, docker, log):
    """Kill and remove a container left under this run's fixed name. The run itself is not a fault."""
    prefix=_docker_prefix()
    found=docker(prefix+["inspect","-f","{{.Id}}",name], stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True)
    if getattr(found, "returncode", 1)!=0:
        return None
    cid=getattr(found, "stdout", "")
    if not isinstance(cid, str):
        return None
    cid=cid.strip()
    if cid=="" or any(ch.isspace() for ch in cid):
        return None
    docker(prefix+["kill",name], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    docker(prefix+["rm","-f",name], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    log.write(f"cleaned orphan container name={name} id={cid}\n")
    log.flush()
    return cid

def run_once(task, seed, arm, config, run, harness, *, run_id=None, relay_root=None, external=False, model=None, token_cap_override=None, attest_dir=None, nonce=None, port=None, listen=None, popen=subprocess.Popen, call=subprocess.run, preflight=None, stage=None, limits_of=None, relay=None, lock_path=None, reconcile=False, expected_task=None, docker=None):
    """One task, one seed, one arm. The host owns the run id and the relay open/close.

    `external` means a relay is already listening and has this run open. This process
    does not bind, open, or close that relay. Tokens come from the relay log only.
    """
    import threading
    import harness_relay
    if arm not in ("control","candidate"):
        raise OnceError("arm")
    if isinstance(seed, bool) or not isinstance(seed, int) or seed<0:
        raise OnceError("seed")
    if reconcile and hooks._task_name(expected_task)=="":
        raise OnceError("expected task")
    if model is not None and model!=MODEL:
        raise OnceError("model")
    chosen=model or MODEL
    resolved=resolve_task(task)
    harness_sha=assert_harness(harness)
    config_path=Path(config)
    if config_path.is_symlink() or not config_path.is_file():
        raise OnceError("config")
    config_sha=hashlib.sha256(config_path.read_bytes()).hexdigest()
    if not isinstance(run_id, str) or len(run_id)!=32:
        run_id=secrets.token_hex(16)
    port=relay_port() if port is None else int(port)
    if relay is not None:
        root=require_relay_log_root(str(relay.log_root))
    else:
        root=require_relay_log_root(str(relay_root if relay_root is not None else os.environ.get("HARNESS_RELAY_LOG_ROOT") or hooks.DEFAULT_RELAY_ROOT))
    cap=token_cap(resolved) if token_cap_override is None else int(token_cap_override)
    if cap<=0:
        raise OnceError("token cap")
    run=Path(run)
    if listen is None:
        listen=relay is None and not external
    log_path=Path(root)/run_id/"relay.jsonl"
    stop=None
    sock=None
    thread=None
    lock_fd=None
    closed=external
    try:
        if external:
            if not log_path.is_file():
                return _once_unscored(run, resolved, seed, arm, run_id, root, harness_sha, cap, "usage_missing", attest_dir, nonce, harness, config_path)
        else:
            if relay is None:
                relay=_standalone_relay(root, port)
            relay.open_run(run_id, "executor", config_sha)
            if listen:
                sock=relay.bind()
                stop=threading.Event()
                thread=threading.Thread(target=harness_relay._accept_loop, args=(relay, sock, stop), name="once-relay", daemon=True)
                thread.start()
        for name in ("workspace","verifier"):
            (run/name).mkdir(parents=True, exist_ok=True)
        (stage or stage_public)(resolved, run/"public")
        lim=(limits_of or limits)(resolved)
        check=preflight or assert_task_network
        check(network="devii-004-int", host="10.204.0.1", port=port)
        lock=lock_path or os.environ.get("HARNESS_RUN_LOCK", str(HOME/".devii-one-run.lock"))
        name=f"devii-once-{resolved.split('/')[-1][:12]}-{seed}-{arm}"
        lock_fd=one_run_lock(lock)
        t0=time.time(); timed_out=False; token_killed=False; rc=None
        tokens_used=0
        docker_call=docker or subprocess.run
        with open(run/"devii_one.log","w") as log:
            _clear_orphan_container(name, docker_call, log)
            argv=agent_cmd(resolved, run, arm, name, run_id=run_id, port=port, harness=harness, config=config_path, model=chosen)
            proc=popen(argv, stdout=log, stderr=subprocess.STDOUT)
            try:
                while True:
                    try:
                        rc=proc.wait(timeout=15)
                        break
                    except subprocess.TimeoutExpired:
                        tokens_used, usage_missing=relay_usage_tokens(root, run_id)
                        if usage_missing:
                            token_killed=True; rc="usage_missing"
                            _kill_container(name, call)
                            try: proc.wait(timeout=60)
                            except subprocess.TimeoutExpired: proc.kill()
                            break
                        if not check_token_cap(resolved, tokens_used)[0] or tokens_used>cap:
                            token_killed=True
                            _kill_container(name, call)
                            try: proc.wait(timeout=60)
                            except subprocess.TimeoutExpired: proc.kill()
                            rc="token_cap"; break
                        if time.time()-t0 >= lim["agent_timeout_sec"]:
                            _kill_container(name, call); timed_out=True; rc="timeout"
                            try: proc.wait(timeout=60)
                            except subprocess.TimeoutExpired: proc.kill()
                            break
            except Exception:
                proc.kill(); raise
        tokens_used, usage_missing=relay_usage_tokens(root, run_id)
        if not token_killed and usage_missing:
            token_killed=True; rc="usage_missing"
        elif not token_killed and (not check_token_cap(resolved, tokens_used)[0] or tokens_used>cap):
            token_killed=True; rc="token_cap"
        res={"task":resolved,"seed":seed,"arm":arm,"exit":rc,"wall_s":round(time.time()-t0,1),"image":IMAGE,"timed_out":timed_out,"token_killed":token_killed,"tokens":tokens_used,"tokens_used":tokens_used,"token_cap":cap,"mountedHarnessSha":harness_sha,"model":chosen,"net":"devii-004-int"}
        checker_dir=Path(root)/run_id/"checker"
        staged=sorted((run/"workspace"/"runs").glob("task-*")) if (run/"workspace"/"runs").is_dir() else []
        if token_killed:
            res["score_status"]="unscored"
            res["reward"]=None
            res["unscored_reason"]="usage_missing" if rc=="usage_missing" else "token_cap"
            res["checker_exit"]="skipped_token_cap"
        elif staged:
            rel=staged[-1].relative_to(run/"workspace")
            with hooks.ScorerWatch(run/"verifier", checker_dir):
                try:
                    with open(run/"checker.log","w") as clog:
                        completed=call(checker_cmd(resolved, run, rel, name+"-chk", run_id=run_id, port=port), stdout=clog, stderr=subprocess.STDOUT, timeout=lim["verifier_timeout_sec"])
                    res["checker_exit"]=completed.returncode
                except subprocess.TimeoutExpired:
                    _kill_container(name+"-chk", call)
                    res["checker_exit"]="timeout"
            res=hooks.apply_score_accounting(res, run/"verifier", checker_dir)
            if res.get("score_status")=="unscored":
                res["reward"]=None
            else:
                try:
                    res["reward"]=hooks.read_checker_reward(run/"verifier")
                    res["score_status"]="scored"
                except ValueError:
                    res["score_status"]="unscored"
                    res["reward"]=None
                    res["unscored_reason"]=res.get("unscored_reason") or "reward-missing"
        else:
            res["score_status"]="unscored"
            res["reward"]=None
            res["unscored_reason"]="checker_missing"
            res["checker_exit"]="skipped"
        recorded=finalize_launch(run, run_id, root, res)
        fault=None
        report={}
        if not external:
            report=relay.close_run(run_id) or {}
            closed=True
            fault=report.get("fault") if isinstance(report, dict) else None
        exit_code=recorded.get("exit")
        bad_exit=isinstance(exit_code, int) and not isinstance(exit_code, bool) and exit_code!=0
        kept_reason=recorded.get("unscored_reason") in ("usage_missing", "token_cap") and recorded.get("checker_exit")=="skipped_token_cap"
        run_fault=None
        if fault in ("attest_mismatch", "usage_missing"):
            run_fault=fault
        elif not kept_reason and relay_request_count(root, run_id)==0:
            run_fault="no_requests"
        elif not kept_reason and bad_exit:
            run_fault="agent_failed"
        elif not kept_reason and not staged:
            run_fault="agent_failed"
        if run_fault:
            recorded["score_status"]="unscored"
            recorded["reward"]=None
            recorded["unscored_reason"]=run_fault
            recorded["relayFault"]=run_fault
            if not external:
                remembered=_memory_tokens(report)
                recorded["tokens"]=remembered
                recorded["tokens_used"]=remembered
        can_reconcile=run_fault is None and recorded.get("score_status")=="scored" and recorded.get("reward") is not None
        if can_reconcile:
            decision=hooks.reconcile_first_run(
                task=resolved,
                expected_task=expected_task if hooks._task_name(expected_task) else task,
                config_sha=config_sha,
                seed=seed,
                arm=arm,
                reconcile=bool(reconcile),
                already=(Path(root)/"reconcile.json").is_file(),
            )
        else:
            decision={"accepted": False, "purpose": None, "exclude": False}
        recorded["reconcile"]=decision
        if decision["accepted"]:
            recorded["purpose"]="reconcile"
            (Path(root)/"reconcile.json").write_text(json.dumps({"task": hooks._task_name(resolved), "seed": seed})+"\n")
        (Path(run)/"result.json").write_text(json.dumps(recorded, indent=1))
        if recorded.get("score_status")=="scored" and recorded.get("reward") is not None and recorded.get("checker_exit")!="skipped_token_cap" and run_fault is None:
            binding=hooks.relay_binding(log_path)
            signed=hooks.sign_run_record(
                _attest_key(), checker_dir,
                relay_log_sha=binding["relayLogSha"], relay_sha=binding["relaySha"], boot_id=binding["bootId"],
                expected_run_id=run_id,
            )
            (Path(root)/run_id/"run-record.json").write_text(json.dumps(signed)+"\n")
            recorded["runRecord"]=signed
        if attest_dir:
            from datetime import datetime, timezone
            meta={
                "arm": arm,
                "at": datetime.now(timezone.utc).isoformat(),
                "exit": recorded.get("exit") if recorded.get("exit") is not None else 0,
                "runDir": os.path.abspath(run),
                "runId": run_id,
                "runPath": os.path.abspath(run),
                "score_status": recorded.get("score_status") or "unscored",
                "seed": seed,
                "task": resolved,
                "tokens": int(recorded.get("tokens") or 0),
            }
            if isinstance(nonce, str) and nonce!="":
                meta["nonce"]=nonce
            write_run_attestation(
                attest_dir, run, key=_attest_key(), harness=harness, config=config_path,
                reward=recorded.get("reward") if recorded.get("score_status")=="scored" else None,
                meta=meta,
            )
        return recorded
    finally:
        if not closed and relay is not None:
            try: relay.close_run(run_id)
            except Exception: pass
        if stop is not None:
            stop.set()
        if sock is not None:
            try: sock.close()
            except OSError: pass
        if thread is not None:
            thread.join(timeout=2)
        if lock_fd is not None:
            release_run_lock(lock_fd)

def _once_unscored(run, task, seed, arm, run_id, root, harness_sha, cap, reason, attest_dir, nonce, harness, config):
    run=Path(run)
    res={"task":task,"seed":seed,"arm":arm,"exit":reason,"wall_s":0,"timed_out":False,"token_killed":True,"tokens":0,"tokens_used":0,"token_cap":cap,"mountedHarnessSha":harness_sha,"score_status":"unscored","reward":None,"unscored_reason":reason,"checker_exit":"skipped_token_cap","net":"devii-004-int"}
    for name in ("workspace","verifier"):
        (run/name).mkdir(parents=True, exist_ok=True)
    recorded=finalize_launch(run, run_id, root, res)
    if attest_dir:
        from datetime import datetime, timezone
        meta={"arm":arm,"at":datetime.now(timezone.utc).isoformat(),"exit":reason,"runDir":os.path.abspath(run),"runId":run_id,"runPath":os.path.abspath(run),"score_status":"unscored","seed":seed,"task":task,"tokens":0}
        if isinstance(nonce, str) and nonce!="":
            meta["nonce"]=nonce
        write_run_attestation(attest_dir, run, key=_attest_key(), harness=harness, config=config, reward=None, meta=meta)
    return recorded

def once_from_flags(argv, **deps):
    flags=_once_args(argv)
    missing=[name for name in ("task","seed","arm","config","run-dir","harness") if name not in flags]
    if missing:
        raise OnceError("once needs "+", ".join("--"+name for name in missing))
    network=flags.get("network")
    if network is not None and network!="devii-004-int":
        raise OnceError("network")
    try:
        seed=int(flags["seed"])
    except (TypeError, ValueError) as exc:
        raise OnceError("seed") from exc
    cap=flags.get("token-cap")
    relay_log=flags.get("relay-log")
    run_id=flags.get("run-id")
    relay_root=None
    if relay_log:
        log=Path(relay_log)
        if log.name!="relay.jsonl":
            raise OnceError("relay log")
        relay_root=str(log.parent.parent)
        if run_id is not None and log.parent.name!=run_id:
            raise OnceError("relay log")
        run_id=run_id or log.parent.name
    if flags.get("reconcile") and hooks._task_name(flags.get("expected-task"))=="":
        raise OnceError("expected task")
    return run_once(
        flags["task"], seed, flags["arm"], flags["config"], flags["run-dir"], flags["harness"],
        run_id=run_id, relay_root=relay_root, external=bool(flags.get("relay-external")),
        model=flags.get("model"), token_cap_override=None if cap is None else int(cap),
        attest_dir=flags.get("attest-dir"), nonce=flags.get("nonce"),
        reconcile=bool(flags.get("reconcile")), expected_task=flags.get("expected-task"), **deps,
    )

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
                                # mid-run token guard: poll the relay log every 15s
                                tokens_used, usage_missing=relay_usage_tokens(relay_root, relay_id)
                                if usage_missing:
                                    token_killed=True; rc="usage_missing"
                                    subprocess.run(["sudo","docker","kill",name],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
                                    try: proc.wait(timeout=60)
                                    except subprocess.TimeoutExpired: proc.kill()
                                    break
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
                tokens_used, usage_missing=relay_usage_tokens(relay_root, relay_id)
                staged=sorted((run/"workspace/runs").glob("task-*"))
                if not token_killed and usage_missing:
                    token_killed=True; rc="usage_missing"
                elif staged and not token_killed and not check_token_cap(t, tokens_used)[0]:
                    token_killed=True; rc="token_cap"
                res={"task":t,"seed":s,"arm":arm,"exit":rc,"wall_s":round(time.time()-t0,1),"image":IMAGE,"timed_out":timed_out,"token_killed":token_killed,"tokens":tokens_used,"tokens_used":tokens_used,"token_cap":cap,**lim,"net":net_mode(t)}
                if token_killed:
                    res["score_status"]="unscored"
                    res["unscored_reason"]="usage_missing" if rc=="usage_missing" else "token_cap_exceeded"
                if staged and not token_killed:
                    rel=staged[-1].relative_to(run/"workspace")
                    checker_dir=Path(relay_root)/relay_id/"checker"
                    # r3 rule 2: after an agent timeout the checker still runs on whatever is in outputs
                    with hooks.ScorerWatch(run/"verifier", checker_dir):
                        try: res["checker_exit"]=subprocess.run(checker_cmd(t,run,rel,name+"-chk",run_id=relay_id,port=port),stdout=open(run/"checker.log","w"),stderr=subprocess.STDOUT,timeout=lim["verifier_timeout_sec"]).returncode
                        except subprocess.TimeoutExpired: subprocess.run(["sudo","docker","kill",name+"-chk"]); res["checker_exit"]="timeout"
                    res=hooks.apply_score_accounting(res, run/"verifier", checker_dir)
                elif token_killed:
                    res["checker_exit"]="skipped_token_cap"
                recorded=finalize_launch(run, relay_id, relay_root, res)
                print(json.dumps(recorded),flush=True)
            finally:
                if lock_fd is not None:
                    release_run_lock(lock_fd)
    elif a[:1]==["once"]:
        try:
            print(json.dumps(once_from_flags(a[1:])), flush=True)
        except OnceError as exc:
            print(str(exc), file=sys.stderr)
            raise SystemExit(1)
    else: print(__doc__)
if __name__=="__main__": main()
