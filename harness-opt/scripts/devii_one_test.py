"""devii_one limits. Unit tests mock subprocess. The bwrap test runs only when bwrap exists."""
from __future__ import annotations

import argparse
import io
import json
import os
import shutil
import subprocess
import sys
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent))
import devii_one


def write_task(root: Path, body: str) -> Path:
    task = root / "task"
    task.mkdir(parents=True)
    (task / "instruction.md").write_text("public\n")
    (task / "task.toml").write_text(body)
    return task


def args_for(task: Path, run_root: Path, tests: Path) -> argparse.Namespace:
    config = task.parent / "config.json"
    config.write_text("{}\n")
    harness = task.parent / "harness"
    harness.mkdir(exist_ok=True)
    return devii_one.parse_args([
        "--task-id", "tasks2/i006",
        "--task-dir", str(task),
        "--seed", "0",
        "--arm", "default",
        "--config", str(config),
        "--run-root", str(run_root),
        "--harness", str(harness),
        "--tests", str(tests),
    ])


class TaskLimitsTest(unittest.TestCase):
    def test_reads_agent_and_checker_timeouts(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            task = write_task(Path(tmp), """
[agent]
timeout_sec = 90

[verifier]
timeout_sec = 12.5

[environment]
allow_internet = true
""")
            limits = devii_one.load_task_limits(task)
            self.assertEqual(limits.agent_timeout_sec, 90)
            self.assertEqual(limits.checker_timeout_sec, 12.5)
            self.assertTrue(limits.allow_internet)
            self.assertEqual(limits.network_mode, "shared")
            stdout = io.StringIO()
            with mock.patch("sys.stdout", stdout):
                code = devii_one.main(["--dump-limits", "--task-dir", str(task)])
            self.assertEqual(code, 0)
            self.assertEqual(json.loads(stdout.getvalue()), {
                "agent_timeout_sec": 90,
                "checker_timeout_sec": 12.5,
                "allow_internet": True,
                "network_mode": "shared",
            })

    def test_missing_task_toml_fails(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            empty = Path(tmp) / "task"
            empty.mkdir()
            with self.assertRaises(SystemExit) as caught:
                devii_one.load_task_limits(empty)
            self.assertIn("task.toml is missing", str(caught.exception))
            with self.assertRaises(SystemExit) as dumped:
                devii_one.main(["--dump-limits", "--task-dir", str(empty)])
            self.assertIn("task.toml is missing", str(dumped.exception))

    def test_missing_timeout_fails_without_a_default(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            no_agent = write_task(root / "a", """
[verifier]
timeout_sec = 30
""")
            with self.assertRaises(SystemExit) as caught:
                devii_one.load_task_limits(no_agent)
            self.assertIn("[agent].timeout_sec", str(caught.exception))

            no_checker = write_task(root / "b", """
[agent]
timeout_sec = 30
timeout_sec_default_should_not_apply = 600
""")
            with self.assertRaises(SystemExit) as caught:
                devii_one.load_task_limits(no_checker)
            message = str(caught.exception)
            self.assertIn("[verifier].timeout_sec", message)
            self.assertNotIn("600", message)

            zero = write_task(root / "c", """
[agent]
timeout_sec = 0

[verifier]
timeout_sec = 30
""")
            with self.assertRaises(SystemExit) as caught:
                devii_one.load_task_limits(zero)
            self.assertIn("positive", str(caught.exception))

            checker_table = write_task(root / "d", """
[agent]
timeout_sec = 15

[checker]
timeout_sec = 7
""")
            limits = devii_one.load_task_limits(checker_table)
            self.assertEqual(limits.checker_timeout_sec, 7)
            self.assertEqual(limits.agent_timeout_sec, 15)

    def test_agent_timeout_still_runs_checker_and_records_timed_out(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            task = write_task(root, """
[agent]
timeout_sec = 11

[verifier]
timeout_sec = 4

[environment]
allow_internet = false
""")
            tests = root / "tests"
            tests.mkdir()
            (tests / "test.sh").write_text("#!/bin/bash\nexit 0\n")
            run_root = root / "runs"
            args = args_for(task, run_root, tests)
            with mock.patch.dict(os.environ, {"BASE_URL": "http://127.0.0.1:9/v1"}):
                plan = devii_one.build_plan(args)
            calls: list[list[str]] = []
            timeouts: list[float | None] = []

            class FakeProcess:
                def __init__(self, command: list[str]) -> None:
                    self.command = command
                    self.pid = 4_000_000 + len(calls)
                    self.returncode = None
                    self.args = command

                def poll(self):
                    return self.returncode

                def communicate(self, timeout=None):
                    timeouts.append(timeout)
                    if self.command is calls[0] and timeout is not None:
                        raise subprocess.TimeoutExpired(self.args, timeout)
                    self.returncode = 0
                    return ("", None)

                def kill(self) -> None:
                    self.returncode = -9

            def fake_popen(command, **_kwargs):
                calls.append(list(command))
                return FakeProcess(calls[-1])

            with mock.patch("devii_one.subprocess.Popen", side_effect=fake_popen), \
                    mock.patch("devii_one.os.killpg") as killpg:
                result = devii_one.execute(args, plan)

            self.assertEqual(len(calls), 2)
            self.assertNotIn(str(tests), calls[0])
            self.assertIn(str(tests), calls[1])
            for command in calls:
                self.assertIn("--unshare-net", command)
                self.assertIn(devii_one.SANDBOX_RELAY_SOCK, command)
                self.assertIn(devii_one.SANDBOX_RELAY_SCRIPT, command)
                self.assertIn("CAP_NET_BIND_SERVICE", command)
                self.assertNotIn("/etc/resolv.conf", command)
            self.assertIn(11, timeouts)
            self.assertIn(4, timeouts)
            self.assertEqual(result["timed_out"], True)
            killpg.assert_called()
            recorded = json.loads((Path(plan["runDir"]) / "result.json").read_text())
            self.assertEqual(recorded["timed_out"], True)
            self.assertEqual(recorded["agent_timeout_sec"], 11)
            self.assertEqual(recorded["checker_timeout_sec"], 4)
            self.assertEqual(recorded["network_mode"], "gateway-only")

    def test_network_flag_follows_allow_internet(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            cases = {
                "off": ("allow_internet = false\n", True),
                "on": ("allow_internet = true\n", False),
                "absent": ("", False),
            }
            for name, (env_line, expect_unshare) in cases.items():
                task = write_task(root / name, f"""
[agent]
timeout_sec = 90

[verifier]
timeout_sec = 30

[environment]
{env_line}
""")
                tests = root / name / "tests"
                tests.mkdir()
                real_popen = subprocess.Popen

                def reject_bwrap(command, *popen_args, **popen_kwargs):
                    argv = list(command)
                    if argv and argv[0] == "bwrap":
                        raise AssertionError("bwrap was started")
                    return real_popen(command, *popen_args, **popen_kwargs)

                with mock.patch.dict(os.environ, {"BASE_URL": "http://127.0.0.1:9/v1"}), \
                        mock.patch("devii_one.subprocess.Popen", side_effect=reject_bwrap):
                    plan = devii_one.build_plan(args_for(task, root / name / "runs", tests))
                for argv in (plan["agentArgv"], plan["checkerArgv"]):
                    self.assertEqual("--unshare-net" in argv, expect_unshare, name)
                    self.assertEqual(devii_one.SANDBOX_RELAY_SOCK in argv, expect_unshare, name)
                    self.assertEqual(devii_one.SANDBOX_RELAY_SCRIPT in argv, expect_unshare, name)
                    if expect_unshare:
                        self.assertNotIn("/etc/resolv.conf", argv)
                        self.assertEqual(plan["limits"]["network_mode"], "gateway-only")
                        self.assertEqual(plan["gateway"]["port"], 9)
                        self.assertEqual(plan["gateway"]["host"], "127.0.0.1")

    def test_gateway_hosts_pin_only_the_model_name(self) -> None:
        self.assertEqual(
            devii_one.gateway_hosts_text("open.bohrium.com"),
            "127.0.0.1 localhost open.bohrium.com\n",
        )
        self.assertNotIn("pypi.org", devii_one.gateway_hosts_text("open.bohrium.com"))
        self.assertEqual(
            devii_one.parse_gateway("https://open.bohrium.com/openapi/model-gateway/v1"),
            ("open.bohrium.com", 443),
        )
        self.assertEqual(devii_one.gateway_listen_host("open.bohrium.com"), "127.0.0.1")
        self.assertEqual(devii_one.parse_gateway("http://127.0.0.1:9/v1"), ("127.0.0.1", 9))
        self.assertEqual(devii_one.gateway_listen_host("10.1.2.3"), "10.1.2.3")

    @unittest.skipUnless(sys.platform.startswith("linux") and shutil.which("bwrap"), "bwrap is unavailable")
    def test_bwrap_gateway_reaches_stub_and_blocks_other_hosts(self) -> None:
        body = b"gateway-ok"

        class Handler(BaseHTTPRequestHandler):
            def do_GET(self):
                self.send_response(200)
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def log_message(self, fmt, *args):
                return

        server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        port = server.server_address[1]
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        guest = """
import json, os, socket, urllib.request
out = {}
try:
    with urllib.request.urlopen(os.environ["BASE_URL"] + "/ping", timeout=5) as resp:
        out["body"] = resp.read().decode()
        out["status"] = resp.status
except Exception as exc:
    out["gateway_error"] = type(exc).__name__ + ": " + str(exc)
try:
    socket.getaddrinfo("pypi.org", 443)
    out["pypi"] = True
except Exception as exc:
    out["pypi"] = False
    out["pypi_error"] = type(exc).__name__
sock = socket.socket()
sock.settimeout(2)
try:
    sock.connect(("1.1.1.1", 443))
    out["external_ip"] = True
except Exception as exc:
    out["external_ip"] = False
    out["external_error"] = type(exc).__name__
print(json.dumps(out))
"""
        try:
            with tempfile.TemporaryDirectory() as tmp:
                root = Path(tmp)
                proc = devii_one.run_gateway_probe(
                    f"http://127.0.0.1:{port}/v1",
                    root / "home",
                    root / "ws",
                    ["/usr/bin/python3", "-c", guest],
                    {"PATH": "/usr/bin:/bin", "HOME": "/root", "LANG": "C.UTF-8", "PYTHONUNBUFFERED": "1"},
                )
                self.assertEqual(proc.returncode, 0, proc.stderr + proc.stdout)
                payload = json.loads(proc.stdout)
                self.assertEqual(payload.get("body"), "gateway-ok", payload)
                self.assertEqual(payload.get("status"), 200, payload)
                self.assertIs(payload.get("pypi"), False, payload)
                self.assertIs(payload.get("external_ip"), False, payload)
                hosts = devii_one.run_gateway_probe(
                    "https://open.bohrium.com/openapi/model-gateway/v1",
                    root / "home-name",
                    root / "ws-name",
                    ["/bin/cat", "/etc/hosts"],
                    {"PATH": "/usr/bin:/bin", "HOME": "/root"},
                )
                self.assertEqual(hosts.returncode, 0, hosts.stderr)
                self.assertIn("127.0.0.1 localhost open.bohrium.com", hosts.stdout)
                self.assertNotIn("pypi.org", hosts.stdout)
        finally:
            server.shutdown()
            server.server_close()


if __name__ == "__main__":
    unittest.main()
