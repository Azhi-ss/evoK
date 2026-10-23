#!/usr/bin/env python3
"""Run one dev-II task, one seed, and one arm in a fresh bwrap.

Modelled on the batch runner's namespace, environment, log redaction, and
checker split. This script does not read tests, solution, or private files.
`--dry` prints the planned bwrap argv and does not start a sandbox or a model.

Official limits come from the task directory's task.toml. There is no default
timeout: `[agent].timeout_sec` is the agent wall clock, and the checker phase
uses `[verifier].timeout_sec` (or `[checker].timeout_sec` when the verifier
table has no timeout). A missing file or a missing timeout fails.

Network choice when `[environment].allow_internet = false` (`gateway-only`):

The sandbox gets `--unshare-net`, so it has no route to the internet. Loopback
stays up. A host process listens on a unix socket and dials only the configured
`BASE_URL` host and port. That socket is bind-mounted at `/opt/model-relay.sock`.
`relay_inside.py` listens inside the netns on that same host:port (a DNS name is
pinned to 127.0.0.1 in a private `/etc/hosts`; a non-loopback IPv4 is added to
`lo`) and splices each TCP connection to the unix socket. Bytes are not
rewritten, so TLS to a hostname still sees the real certificate. `/etc/resolv.conf`
is not mounted. `CAP_NET_BIND_SERVICE` lets the sandbox bind port 443;
`CAP_NET_ADMIN` only configures this empty netns and does not add an external
interface. `allow_internet` missing or true keeps the shared network.
"""
from __future__ import annotations

import argparse
from dataclasses import dataclass
import json
import os
from pathlib import Path, PurePosixPath
import signal
import socket
import subprocess
import sys
import threading
import tomllib
from urllib.parse import urlparse

FORBIDDEN = {"tests", "solution", "private", "_control", "__MACOSX"}
KEY_NAMES = ("API_KEY", "BOHR_ACCESS_KEY")
NETWORK_GATEWAY = "gateway-only"
NETWORK_SHARED = "shared"
SANDBOX_RELAY_SOCK = "/opt/model-relay.sock"
SANDBOX_RELAY_SCRIPT = "/opt/model-relay-inside.py"
RELAY_INSIDE = Path(__file__).resolve().with_name("relay_inside.py")
ETC_MOUNTS = (
    "/etc/ssl", "/etc/ca-certificates", "/etc/resolv.conf", "/etc/hosts",
    "/etc/nsswitch.conf", "/etc/passwd", "/etc/group", "/etc/localtime",
)
GATEWAY_ETC_SKIP = {"/etc/resolv.conf", "/etc/hosts"}
DEFAULT_BASE_URL = "https://open.bohrium.com/openapi/model-gateway/v1"


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
        network_mode=NETWORK_SHARED if allow_internet else NETWORK_GATEWAY,
    )


def limits_payload(limits: TaskLimits) -> dict:
    return {
        "agent_timeout_sec": limits.agent_timeout_sec,
        "checker_timeout_sec": limits.checker_timeout_sec,
        "allow_internet": limits.allow_internet,
        "network_mode": limits.network_mode,
    }


def model_base_url() -> str:
    return os.environ.get("BASE_URL") or DEFAULT_BASE_URL


def _is_ipv4(host: str) -> bool:
    try:
        socket.inet_pton(socket.AF_INET, host)
    except OSError:
        return False
    return True


def parse_gateway(base_url: str) -> tuple[str, int]:
    parsed = urlparse(base_url)
    host = parsed.hostname
    if parsed.scheme not in {"http", "https"} or not host:
        raise SystemExit(f"BASE_URL is not a usable model gateway: {base_url}")
    try:
        socket.inet_pton(socket.AF_INET6, host)
        ipv6 = True
    except OSError:
        ipv6 = False
    if ipv6:
        raise SystemExit(f"BASE_URL host must be a DNS name or IPv4 address: {base_url}")
    port = parsed.port or (443 if parsed.scheme == "https" else 80)
    return host, port


def gateway_listen_host(host: str) -> str:
    """Address the in-netns proxy binds. DNS names are reached via /etc/hosts."""
    if host in {"localhost", "127.0.0.1"}:
        return "127.0.0.1"
    if _is_ipv4(host):
        return host
    return "127.0.0.1"


def gateway_hosts_text(host: str) -> str:
    names = ["localhost"]
    if not _is_ipv4(host) and host != "localhost":
        names.append(host)
    return "127.0.0.1 " + " ".join(names) + "\n"


@dataclass(frozen=True)
class GatewaySpec:
    base_url: str
    host: str
    port: int
    listen_host: str
    socket_path: Path
    hosts_path: Path
    script_path: Path

    def payload(self) -> dict:
        return {
            "baseUrl": self.base_url,
            "host": self.host,
            "port": self.port,
            "listenHost": self.listen_host,
            "socket": str(self.socket_path),
            "hosts": str(self.hosts_path),
            "script": str(self.script_path),
        }


def gateway_for(base_url: str, directory: Path) -> GatewaySpec:
    host, port = parse_gateway(base_url)
    if not RELAY_INSIDE.is_file():
        raise SystemExit(f"model relay script is missing: {RELAY_INSIDE}")
    return GatewaySpec(
        base_url=base_url,
        host=host,
        port=port,
        listen_host=gateway_listen_host(host),
        socket_path=directory / "relay.sock",
        hosts_path=directory / "hosts",
        script_path=RELAY_INSIDE,
    )


def gateway_from_payload(payload: dict) -> GatewaySpec:
    return GatewaySpec(
        base_url=payload["baseUrl"],
        host=payload["host"],
        port=int(payload["port"]),
        listen_host=payload["listenHost"],
        socket_path=Path(payload["socket"]),
        hosts_path=Path(payload["hosts"]),
        script_path=Path(payload["script"]),
    )


class HostRelay:
    """Dials only the configured BASE_URL host:port for each unix-socket client."""

    def __init__(self, spec: GatewaySpec):
        self.spec = spec
        self._sock: socket.socket | None = None

    def start(self) -> None:
        spec = self.spec
        spec.socket_path.parent.mkdir(parents=True, exist_ok=True)
        spec.hosts_path.write_text(gateway_hosts_text(spec.host))
        if spec.socket_path.exists():
            spec.socket_path.unlink()
        server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        server.bind(str(spec.socket_path))
        os.chmod(spec.socket_path, 0o600)
        server.listen(128)
        self._sock = server
        threading.Thread(target=self._accept, daemon=True).start()

    def stop(self) -> None:
        sock = self._sock
        self._sock = None
        if sock is not None:
            sock.close()
        if self.spec.socket_path.exists():
            self.spec.socket_path.unlink()

    def _accept(self) -> None:
        sock = self._sock
        if sock is None:
            return
        while True:
            try:
                client, _addr = sock.accept()
            except OSError:
                return
            threading.Thread(target=self._handle, args=(client,), daemon=True).start()

    def _handle(self, client: socket.socket) -> None:
        remote = None
        try:
            remote = socket.create_connection((self.spec.host, self.spec.port), timeout=10)
            remote.settimeout(None)
            left = threading.Thread(target=_pipe_sockets, args=(client, remote), daemon=True)
            right = threading.Thread(target=_pipe_sockets, args=(remote, client), daemon=True)
            left.start()
            right.start()
            left.join()
            right.join()
        except OSError:
            pass
        finally:
            client.close()
            if remote is not None:
                remote.close()


def _pipe_sockets(src: socket.socket, dst: socket.socket) -> None:
    try:
        while True:
            data = src.recv(65536)
            if not data:
                break
            dst.sendall(data)
    except OSError:
        pass
    finally:
        try:
            dst.shutdown(socket.SHUT_WR)
        except OSError:
            pass


def namespace(home, workspace, extra, *, gateway: GatewaySpec | None = None):
    command = ["bwrap", "--die-with-parent", "--unshare-pid", "--unshare-ipc", "--unshare-uts"]
    if gateway is not None:
        # Empty netns plus caps to bind the gateway port. No external interface.
        command += [
            "--unshare-net", "--unshare-user", "--uid", "0", "--gid", "0",
            "--cap-add", "CAP_NET_BIND_SERVICE", "--cap-add", "CAP_NET_ADMIN",
        ]
    for path in ["/usr", "/bin", "/lib", "/lib64"]:
        if Path(path).exists():
            command += ["--ro-bind", path, path]
    for path in ETC_MOUNTS:
        if gateway is not None and path in GATEWAY_ETC_SKIP:
            continue
        if Path(path).exists():
            command += ["--ro-bind", str(Path(path).resolve()), path]
    if gateway is not None:
        command += [
            "--ro-bind", str(gateway.hosts_path), "/etc/hosts",
            "--bind", str(gateway.socket_path), SANDBOX_RELAY_SOCK,
            "--ro-bind", str(gateway.script_path), SANDBOX_RELAY_SCRIPT,
        ]
    command += ["--proc", "/proc", "--dev", "/dev", "--tmpfs", "/tmp", "--dir", "/app",
                "--bind", str(home), "/root", "--bind", str(workspace), "/workspace"]
    packages = Path.home() / ".local/lib/python3.12/site-packages"
    if packages.is_dir():
        command += ["--ro-bind", str(packages), "/opt/python-packages"]
    return command + extra


def wrap_relay(argv: list[str], gateway: GatewaySpec) -> list[str]:
    if "--" not in argv:
        raise SystemExit("sandbox command is missing --")
    split = argv.index("--")
    return [
        *argv[: split + 1],
        "/usr/bin/python3", SANDBOX_RELAY_SCRIPT,
        "--listen", gateway.listen_host,
        "--port", str(gateway.port),
        "--sock", SANDBOX_RELAY_SOCK,
        "--",
        *argv[split + 1 :],
    ]


def sandbox_argv(home, workspace, extra, gateway: GatewaySpec | None):
    argv = namespace(home, workspace, extra, gateway=gateway)
    if gateway is None:
        return argv
    return wrap_relay(argv, gateway)


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
    run = Path(args.run_root) / task_id / str(args.seed) / arm
    base_url = model_base_url()
    gateway = gateway_for(base_url, run / "gateway") if limits.network_mode == NETWORK_GATEWAY else None
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
        BASE_URL=base_url,
        HARNESS_WORKSPACE="/workspace/runs",
        HARNESS_CANDIDATE_CONFIG="/opt/candidate-config.json",
    )
    if memory is not None:
        agent_env["HARNESS_MEMORY_PATH"] = "/opt/memory.jsonl"
    home = run / "home"
    workspace = run / "workspace"
    agent = sandbox_argv(home, workspace, agent_extra, gateway)
    checker = None
    checker_env = None
    if tests is not None:
        # The staged outputs directory is chosen by run.sh after the agent starts.
        # Dry mode prints the bind targets; execute() fills the real host paths.
        checker = sandbox_argv(
            run / "checker-home",
            workspace,
            checker_binds(tests, "<staged-outputs>", "<staged-run>", run / "verifier"),
            gateway,
        )
        checker_env = base_env()
        if gateway is not None:
            checker_env["BASE_URL"] = base_url
    return {
        "dry": True,
        "runDir": str(run),
        "limits": limits_payload(limits),
        "gateway": None if gateway is None else gateway.payload(),
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


def _relay_hooks():
    relay = Path(__file__).resolve().parents[1] / "relay"
    if str(relay) not in sys.path:
        sys.path.insert(0, str(relay))
    import hooks
    return hooks


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
        BASE_URL=model_base_url(),
        HARNESS_WORKSPACE="/workspace/runs",
        HARNESS_CANDIDATE_CONFIG="/opt/candidate-config.json",
    )
    if args.memory:
        agent_env["HARNESS_MEMORY_PATH"] = "/opt/memory.jsonl"
    log = run / "devii_one.log"
    limits = plan["limits"]
    gateway = gateway_from_payload(plan["gateway"]) if plan.get("gateway") else None
    if gateway is not None:
        agent_env["BASE_URL"] = gateway.base_url
    relay = HostRelay(gateway) if gateway is not None else None
    if relay is not None:
        relay.start()
    try:
        exit_code = run_logged(plan["agentArgv"], agent_env, log, limits["agent_timeout_sec"])
        timed_out = exit_code is None
        workspace = run / "workspace"
        actual = staged_run(workspace, log)
        outputs = actual / "outputs" if actual else run / "missing-outputs"
        outputs.mkdir(exist_ok=True)
        checker_exit = None
        if args.tests:
            checker = sandbox_argv(
                run / "checker-home",
                workspace,
                checker_binds(Path(args.tests), outputs, actual, run / "verifier"),
                gateway,
            )
            checker_env = base_env()
            if gateway is not None:
                checker_env["BASE_URL"] = gateway.base_url
            with _relay_hooks().ScorerWatch(run / "verifier", run / "verifier"):
                checker_exit = run_logged(checker, checker_env, run / "checker.log", limits["checker_timeout_sec"])
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
        result = _relay_hooks().apply_score_accounting(result, run / "verifier", run / "verifier")
        (run / "result.json").write_text(json.dumps(result) + "\n")
        return result
    finally:
        if relay is not None:
            relay.stop()


def run_gateway_probe(base_url: str, home: Path, workspace: Path, command: list[str], env: dict[str, str]):
    """Run one command inside the real gateway sandbox. Used by the bwrap test."""
    home.mkdir(parents=True, exist_ok=True)
    workspace.mkdir(parents=True, exist_ok=True)
    gateway = gateway_for(base_url, home.parent / "gateway")
    relay = HostRelay(gateway)
    relay.start()
    guest = dict(env)
    guest["BASE_URL"] = base_url
    try:
        argv = sandbox_argv(home, workspace, ["--chdir", "/root", "--", *command], gateway)
        return subprocess.run(argv, env=guest, text=True, capture_output=True, timeout=30)
    finally:
        relay.stop()


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
