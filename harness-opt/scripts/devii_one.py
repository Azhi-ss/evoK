#!/usr/bin/env python3
"""Run one dev-II task, one seed, and one arm in a fresh bwrap.

Modelled on the batch runner's namespace, environment, log redaction, and
checker split. This script does not read tests, solution, or private files.
`--dry` prints the planned bwrap argv and does not start a sandbox or a model.
"""
from __future__ import annotations

import argparse
import json
import os
from pathlib import Path, PurePosixPath
import subprocess
import sys

FORBIDDEN = {"tests", "solution", "private", "_control", "__MACOSX"}
KEY_NAMES = ("API_KEY", "BOHR_ACCESS_KEY")


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


def namespace(home, workspace, extra):
    command = ["bwrap", "--die-with-parent", "--unshare-pid", "--unshare-ipc", "--unshare-uts"]
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
    agent = namespace(home, workspace, agent_extra)
    checker = None
    checker_env = None
    if tests is not None:
        # The staged outputs directory is chosen by run.sh after the agent starts.
        # Dry mode prints the bind targets; execute() fills the real host paths.
        checker = namespace(
            run / "checker-home",
            workspace,
            checker_binds(tests, "<staged-outputs>", "<staged-run>", run / "verifier"),
        )
        checker_env = base_env()
    return {
        "dry": True,
        "runDir": str(run),
        "agentArgv": agent,
        "agentEnv": redact_env(agent_env),
        "checkerArgv": checker,
        "checkerEnv": redact_env(checker_env) if checker_env is not None else None,
    }


def run_logged(command, env, log):
    log.parent.mkdir(parents=True, exist_ok=True)
    with log.open("w") as output:
        process = subprocess.Popen(
            command, env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
            text=True, errors="replace", start_new_session=True,
        )
        assert process.stdout is not None
        for line in process.stdout:
            output.write(clean(line))
            output.flush()
        return process.wait()


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
    exit_code = run_logged(plan["agentArgv"], agent_env, log)
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
        )
        checker_exit = run_logged(checker, base_env(), run / "checker.log")
    trace_src = actual / "trace.jsonl" if actual else None
    if trace_src and trace_src.is_file():
        with trace_src.open() as source, (run / "trace.jsonl").open("w") as target:
            for line in source:
                target.write(clean(line))
    return exit_code, checker_exit


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
    args = parse_args(sys.argv[1:] if argv is None else argv)
    plan = build_plan(args)
    if args.dry:
        print(clean(json.dumps(plan, indent=2)))
        return 0
    execute(args, plan)
    return 0


if __name__ == "__main__":
    sys.exit(main())
