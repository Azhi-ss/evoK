#!/usr/bin/env python3
"""Run one dev-II task, one seed, and one arm in a fresh bwrap.

Modelled on the batch runner's namespace, environment, log redaction, and
checker split. This script does not read tests, solution, or private files.
`--dry` prints the planned bwrap argv and does not start a sandbox or a model.

Official limits come from the task directory's task.toml. There is no default
timeout: `[agent].timeout_sec` is the agent wall clock, and the checker phase
uses `[verifier].timeout_sec` (or `[checker].timeout_sec` when the verifier
table has no timeout). A missing file or a missing timeout fails.

Network choice: `[environment].allow_internet = false` adds `--unshare-net` to
both bwrap commands (a new netns with only loopback). This script does not run
a relay that would keep the model gateway (`BASE_URL`) reachable, so that
endpoint is isolated with the rest of the network.
"""
from __future__ import annotations

import argparse
from dataclasses import dataclass
import json
import os
from pathlib import Path, PurePosixPath
import signal
import subprocess
import sys
import tomllib

FORBIDDEN = {"tests", "solution", "private", "_control", "__MACOSX"}
KEY_NAMES = ("API_KEY", "BOHR_ACCESS_KEY")
NETWORK_UNSHARED = "unshare-net"
NETWORK_SHARED = "shared"


def secrets():
    return [value for name in KEY_NAMES if (value := os.environ.get(name))]


def clean(text):
    out = text
    for secret in secrets():
        out = out.replace(secret, "[REDACTED]")
    return out


def assert_safe_id(value, label):
    path = PurePosixPath(value)
    if path.is_absolute() or ".." in path.parts or value.strip() == "":
        raise SystemExit(f"unsafe {label}")
    return value


@dataclass(frozen=True)
class TaskLimits:
    agent_timeout_sec: int | float
    checker_timeout_sec: int | float
    allow_internet: bool
    network_mode: str


def _positive_timeout(value, label, path: Path):
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise SystemExit(f"task.toml {label} must be a positive number: {path}")
    number = float(value)
    if number != number or number in (float("inf"), float("-inf")) or number <= 0:
        raise SystemExit(f"task.toml {label} must be a positive number: {path}")
    return int(number) if number.is_integer() else number


def _checker_timeout(data: dict, path: Path):
    """The checker is the official verifier. A `[checker]` table is the fallback."""
    verifier = data.get("verifier")
    checker = data.get("checker")
    if isinstance(verifier, dict) and "timeout_sec" in verifier:
        return verifier["timeout_sec"], "[verifier].timeout_sec"
    if isinstance(checker, dict) and "timeout_sec" in checker:
        return checker["timeout_sec"], "[checker].timeout_sec"
    raise SystemExit(f"task.toml is missing [verifier].timeout_sec: {path}")


def load_task_limits(task_dir: Path) -> TaskLimits:
    """Read official agent and checker timeouts. Missing values are an error."""
    path = task_dir / "task.toml"
    if not path.is_file():
        raise SystemExit(f"task.toml is missing: {path}")
    try:
        with path.open("rb") as handle:
            data = tomllib.load(handle)
    except tomllib.TOMLDecodeError as exc:
        raise SystemExit(f"task.toml is invalid: {path}: {exc}") from exc
    if not isinstance(data, dict):
        raise SystemExit(f"task.toml is invalid: {path}")
    agent = data.get("agent")
    if not isinstance(agent, dict) or "timeout_sec" not in agent:
        raise SystemExit(f"task.toml is missing [agent].timeout_sec: {path}")
    checker_timeout, checker_label = _checker_timeout(data, path)
    environment = data.get("environment")
    allow_internet = True
    if isinstance(environment, dict) and "allow_internet" in environment:
        allow_internet = environment["allow_internet"]
        if not isinstance(allow_internet, bool):
            raise SystemExit(f"task.toml [environment].allow_internet must be a boolean: {path}")
    return TaskLimits(
        agent_timeout_sec=_positive_timeout(agent["timeout_sec"], "[agent].timeout_sec", path),
        checker_timeout_sec=_positive_timeout(checker_timeout, checker_label, path),
        allow_internet=allow_internet,
        network_mode=NETWORK_SHARED if allow_internet else NETWORK_UNSHARED,
    )


def limits_payload(limits: TaskLimits) -> dict:
    return {
        "agent_timeout_sec": limits.agent_timeout_sec,
        "checker_timeout_sec": limits.checker_timeout_sec,
        "allow_internet": limits.allow_internet,
        "network_mode": limits.network_mode,
    }


def namespace(home, workspace, extra, *, unshare_net=False):
    command = ["bwrap", "--die-with-parent", "--unshare-pid", "--unshare-ipc", "--unshare-uts"]
    if unshare_net:
        command.append("--unshare-net")
    for path in ["/usr", "/bin", "/lib", "/lib64"]:
        if Path(path).exists():
            command += ["--ro-bind", path, path]
    for path in ["/etc/ssl", "/etc/ca-certificates", "/etc/resolv.conf", "/etc/hosts", "/etc/nsswitch.conf", "/etc/passwd", "/etc/group", "/etc/localtime"]:
        if Path(path).exists():
            command += ["--ro-bind", str(Path(path).resolve()), path]
    command += ["--proc", "/proc", "--dev", "/dev", "--tmpfs", "/tmp", "--dir", "/app",
                "--bind", str(home), "/root", "--bind", str(workspace), "/workspace"]
    packages = Path.home() / ".local/lib/python3.12/site-packages"
    if packages.is_dir():
        command += ["--ro-bind", str(packages), "/opt/python-packages"]
    return command + extra


def base_env():
    return {
        "PATH": "/opt/node/bin:/root/.local/bin:/usr/local/bin:/usr/bin:/bin",
        "HOME": "/root",
        "LANG": "C.UTF-8",
        "PYTHONPATH": "/opt/python-packages",
        "PYTHONUNBUFFERED": "1",
        "OMP_NUM_THREADS": "4",
        "OPENBLAS_NUM_THREADS": "4",
    }


def redact_env(env):
    hidden = set(KEY_NAMES)
    return {key: ("[REDACTED]" if key in hidden and value else value) for key, value in env.items()}


def node_prefix():
    executable = subprocess.check_output(["node", "-p", "process.execPath"], text=True).strip()
    return Path(executable).parent.parent


def assert_public_task(task_dir: Path):
    if not task_dir.is_dir():
        raise SystemExit(f"task directory is missing: {task_dir}")
    for child in task_dir.iterdir():
        if child.name in FORBIDDEN:
            raise SystemExit(f"task directory contains non-public material: {child.name}")


def checker_binds(tests, outputs, code, verifier):
    """Checker phase only. tests stay off the agent command."""
    extra = [
        "--ro-bind", str(tests), "/tests",
        "--ro-bind", str(outputs), "/app/outputs",
        "--bind", str(verifier), "/logs/verifier",
    ]
    if code is not None:
        extra += ["--ro-bind", str(code), "/root/code"]
    extra += ["--chdir", "/root/code" if code is not None else "/root", "--", "bash", "/tests/test.sh"]
    return extra


def staged_run(workspace, log):
    runs = workspace / "runs"
    staged = sorted(runs.glob("task-*"), key=lambda path: path.stat().st_mtime) if runs.is_dir() else []
    actual = None
    if log.is_file():
        for line in log.read_text().splitlines():
            if line.startswith("run_dir="):
                candidate = workspace / Path(line.split("=", 1)[1].strip()).relative_to("/workspace")
                if candidate.is_dir():
                    actual = candidate
                break
    return actual if actual is not None else (staged[-1] if staged else None)


def build_plan(args):
    task_id = assert_safe_id(args.task_id, "task id")
    arm = assert_safe_id(args.arm, "arm")
    if not str(args.seed).isdigit():
        raise SystemExit("unsafe seed")
    limits = load_task_limits(Path(args.task_dir))
    unshare_net = limits.network_mode == NETWORK_UNSHARED
    run = Path(args.run_root) / task_id / str(args.seed) / arm
    config = Path(args.config)
    memory = Path(args.memory) if args.memory else None
    tests = Path(args.tests) if args.tests else None
    node = node_prefix()
    agent_extra = [
        "--ro-bind", str(node), "/opt/node",
        "--ro-bind", str(Path(args.harness)), "/opt/harness",
        "--ro-bind", str(Path(args.task_dir)), "/input/task",
        "--ro-bind", str(config), "/opt/candidate-config.json",
    ]
    if args.data_lake:
        agent_extra += ["--ro-bind", str(Path(args.data_lake)), "/shared/data_lake"]
    if memory is not None:
        agent_extra += ["--ro-bind", str(memory), "/opt/memory.jsonl"]
    agent_extra += ["--chdir", "/root", "--", "bash", "/opt/harness/run.sh",
                    "--task", "/input/task/instruction.md", "--model-name", args.model_name]
    agent_env = base_env()
    agent_env.update(
        API_KEY=os.environ.get("API_KEY") or os.environ.get("BOHR_ACCESS_KEY") or "",
        BASE_URL=os.environ.get("BASE_URL") or "https://open.bohrium.com/openapi/model-gateway/v1",
        HARNESS_WORKSPACE="/workspace/runs",
        HARNESS_CANDIDATE_CONFIG="/opt/candidate-config.json",
    )
    if memory is not None:
        agent_env["HARNESS_MEMORY_PATH"] = "/opt/memory.jsonl"
    home = run / "home"
    workspace = run / "workspace"
    agent = namespace(home, workspace, agent_extra, unshare_net=unshare_net)
    checker = None
    checker_env = None
    if tests is not None:
        # The staged outputs directory is chosen by run.sh after the agent starts.
        # Dry mode prints the bind targets; execute() fills the real host paths.
        checker = namespace(
            run / "checker-home",
            workspace,
            checker_binds(tests, "<staged-outputs>", "<staged-run>", run / "verifier"),
            unshare_net=unshare_net,
        )
        checker_env = base_env()
    return {
        "dry": True,
        "runDir": str(run),
        "limits": limits_payload(limits),
        "agentArgv": agent,
        "agentEnv": redact_env(agent_env),
        "checkerArgv": checker,
        "checkerEnv": redact_env(checker_env) if checker_env is not None else None,
    }


def _kill_process_group(process: subprocess.Popen) -> None:
    """The child is a session leader. Kill the whole group on timeout."""
    if process.poll() is not None:
        return
    try:
        os.killpg(process.pid, signal.SIGKILL)
    except ProcessLookupError:
        process.kill()


def _write_log(log: Path, text: str, timed_out: bool) -> None:
    body = clean(text or "")
    if timed_out:
        if body and not body.endswith("\n"):
            body += "\n"
        body += "[timed out]\n"
    log.write_text(body)


def run_logged(command, env, log, timeout_sec):
    if isinstance(timeout_sec, bool) or not isinstance(timeout_sec, (int, float)) or timeout_sec <= 0:
        raise SystemExit(f"timeout_sec is missing or not positive: {timeout_sec!r}")
    log.parent.mkdir(parents=True, exist_ok=True)
    process = subprocess.Popen(
        command, env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
        text=True, errors="replace", start_new_session=True,
    )
    try:
        stdout, _stderr = process.communicate(timeout=timeout_sec)
    except subprocess.TimeoutExpired:
        _kill_process_group(process)
        try:
            stdout, _stderr = process.communicate()
        except Exception:
            stdout = ""
        _write_log(log, stdout or "", timed_out=True)
        return None
    _write_log(log, stdout or "", timed_out=False)
    return process.returncode


def execute(args, plan):
    run = Path(plan["runDir"])
    if run.exists():
        raise SystemExit(f"run dir already exists: {run}")
    assert_public_task(Path(args.task_dir))
    for directory in [run / "home", run / "workspace", run / "verifier", run / "checker-home"]:
        directory.mkdir(parents=True)
    agent_env = base_env()
    agent_env.update(
        API_KEY=os.environ.get("API_KEY") or os.environ.get("BOHR_ACCESS_KEY") or "",
        BASE_URL=os.environ.get("BASE_URL") or "https://open.bohrium.com/openapi/model-gateway/v1",
        HARNESS_WORKSPACE="/workspace/runs",
        HARNESS_CANDIDATE_CONFIG="/opt/candidate-config.json",
    )
    if args.memory:
        agent_env["HARNESS_MEMORY_PATH"] = "/opt/memory.jsonl"
    log = run / "devii_one.log"
    limits = plan["limits"]
    unshare_net = limits["network_mode"] == NETWORK_UNSHARED
    exit_code = run_logged(plan["agentArgv"], agent_env, log, limits["agent_timeout_sec"])
    timed_out = exit_code is None
    workspace = run / "workspace"
    actual = staged_run(workspace, log)
    outputs = actual / "outputs" if actual else run / "missing-outputs"
    outputs.mkdir(exist_ok=True)
    checker_exit = None
    if args.tests:
        checker = namespace(
            run / "checker-home",
            workspace,
            checker_binds(Path(args.tests), outputs, actual, run / "verifier"),
            unshare_net=unshare_net,
        )
        checker_exit = run_logged(checker, base_env(), run / "checker.log", limits["checker_timeout_sec"])
    trace_src = actual / "trace.jsonl" if actual else None
    if trace_src and trace_src.is_file():
        with trace_src.open() as source, (run / "trace.jsonl").open("w") as target:
            for line in source:
                target.write(clean(line))
    result = {
        "timed_out": timed_out,
        "agent_timeout_sec": limits["agent_timeout_sec"],
        "checker_timeout_sec": limits["checker_timeout_sec"],
        "allow_internet": limits["allow_internet"],
        "network_mode": limits["network_mode"],
        "agent_exit": exit_code,
        "checker_exit": checker_exit,
    }
    (run / "result.json").write_text(json.dumps(result) + "\n")
    return result


def parse_args(argv):
    parser = argparse.ArgumentParser(description="Run one dev-II task in a fresh bwrap")
    parser.add_argument("--task-id", required=True)
    parser.add_argument("--task-dir", required=True)
    parser.add_argument("--seed", required=True)
    parser.add_argument("--arm", default="default")
    parser.add_argument("--config", required=True)
    parser.add_argument("--memory")
    parser.add_argument("--run-root", required=True)
    parser.add_argument("--harness", required=True)
    parser.add_argument("--tests")
    parser.add_argument("--data-lake")
    parser.add_argument("--model-name", default="deepseek-v4.1-flash")
    parser.add_argument("--dry", action="store_true")
    return parser.parse_args(argv)


def main(argv=None):
    raw = list(sys.argv[1:] if argv is None else argv)
    if "--dump-limits" in raw:
        parser = argparse.ArgumentParser(description="Print one task's official limits")
        parser.add_argument("--dump-limits", action="store_true")
        parser.add_argument("--task-dir", required=True)
        dumped = parser.parse_args(raw)
        print(json.dumps(limits_payload(load_task_limits(Path(dumped.task_dir)))))
        return 0
    args = parse_args(raw)
    plan = build_plan(args)
    if args.dry:
        print(clean(json.dumps(plan, indent=2)))
        return 0
    execute(args, plan)
    return 0


if __name__ == "__main__":
    sys.exit(main())
