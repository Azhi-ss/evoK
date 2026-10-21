"""Relay, ledger, and loop-mode tests. classify records codes and does not rerun."""
import base64
import hashlib
import json
import os
import stat
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

import canon
import ewi_relay
import harness_relay
import plant
import hooks
import loop_mode
from harness_relay import Relay, UpstreamNetworkError, assert_bind_host, new_run_id
from ledger import Ledger, classify, load, patch_active, read_evidence, strip_line_prefixes, tokens

USAGE = {"prompt_tokens": 10, "completion_tokens": 2, "prompt_tokens_details": {"cached_tokens": 1}}
HERE = Path(__file__).resolve().parent
EWI_SCRIPT = HERE.parent / "scripts" / "ewi_idle.py"
DIFF_TABLE = HERE / "ewi_diff_table.md"


def write_key(path: Path, body: bytes) -> None:
    path.write_bytes(body)
    os.chmod(path, 0o600)


def assert_network_post(test, relay, url):
    """The callable is the real client: it POSTs to `url` with the upstream key and returns that response."""
    import urllib.request
    captured = {}

    class Resp:
        status = 200

        def read(self):
            return b'{"choices":[{"message":{"role":"assistant","content":"pong"}}],"usage":{"prompt_tokens":4,"completion_tokens":5,"prompt_tokens_details":{"cached_tokens":0}}}'

        def __enter__(self):
            return self

        def __exit__(self, *args):
            return False

    def urlopen(req, timeout=None):
        captured["url"] = req.full_url
        captured["auth"] = req.get_header("Authorization")
        captured["ua"] = req.get_header("User-agent")
        return Resp()

    original = urllib.request.urlopen
    urllib.request.urlopen = urlopen
    try:
        status, raw, usage = relay.upstream(b"{}", False)
    finally:
        urllib.request.urlopen = original
    test.assertEqual(status, 200)
    test.assertEqual(captured["url"], url)
    token = relay.upstream_key.rstrip(b"\r\n").decode()
    test.assertEqual(captured["auth"], f"Bearer {token}")
    test.assertEqual(captured["ua"], "Mozilla/5.0")
    test.assertGreater(len(json.loads(raw)["choices"]), 0)
    test.assertEqual(usage["prompt_tokens"], 4)
    test.assertEqual(usage["completion_tokens"], 5)
    test.assertIsNot(relay.upstream, harness_relay._default_upstream)
    test.assertTrue(getattr(relay.upstream, "production_upstream", False))


class RelayCase(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.up = self.root / "up.key"
        self.att = self.root / "att.key"
        write_key(self.up, b"upstream-key-0123456789abcdef")
        write_key(self.att, b"attest-key-0123456789abcdef!!")
        self.calls = []

        def upstream(body, stream):
            self.calls.append((body, stream))
            return 200, b'{"usage":true}', dict(USAGE)

        self.upstream = upstream
        self.relay = Relay(port=9, log_root=self.root / "logs", upstream_key_file=self.up, attest_key_file=self.att, upstream=upstream, allow_fake_upstream=True)
        self.run = new_run_id()
        self.relay.open_run(self.run, "executor", "abc")

    def tearDown(self):
        self.tmp.cleanup()

    def post(self, body, headers=None, run=None, **kw):
        rid = run or self.run
        host = headers or {"host": f"10.204.0.1:9"}
        return self.relay.handle("POST", f"/r/{rid}/v1/chat/completions", body, host, **kw)

    def log_text(self, run=None):
        return (self.relay.log_path(run or self.run)).read_text(encoding="utf-8")

    def test_01_requests_are_counted_and_tokens_only_increase(self):
        body = json.dumps({"messages": [{"role": "user", "content": "a"}]}).encode()
        self.assertEqual(self.post(body)[0], 200)
        first = tokens(load(self.relay.log_path(self.run)))["tokens"]
        self.upstream_more = True

        def bigger(body, stream):
            self.calls.append((body, stream))
            return 200, b"{}", {"prompt_tokens": 30, "completion_tokens": 4, "prompt_tokens_details": {"cached_tokens": 2}}

        self.relay.upstream = bigger
        self.post(body)
        second = tokens(load(self.relay.log_path(self.run)))["tokens"]
        self.assertGreater(second, first)
        self.assertEqual(len(load(self.relay.log_path(self.run)).reqs), 2)

    def test_forward_uses_the_upstream_key_not_the_placeholder(self):
        import urllib.request
        captured = {}

        class Resp:
            status = 200

            def read(self):
                return b'{"usage":{"prompt_tokens":1,"completion_tokens":1,"prompt_tokens_details":{"cached_tokens":0}}}'

            def __enter__(self):
                return self

            def __exit__(self, *args):
                return False

        def urlopen(req, timeout=None):
            captured["auth"] = req.get_header("Authorization")
            captured["ua"] = req.get_header("User-agent")
            captured["data"] = req.data
            return Resp()

        original = urllib.request.urlopen
        urllib.request.urlopen = urlopen
        try:
            self.relay.upstream = harness_relay._network_upstream("http://127.0.0.1:9/v1/chat/completions", self.relay.upstream_key)
            body = json.dumps({"messages": [{"role": "user", "content": "hi"}]}).encode()
            status, _resp = self.post(body, headers={
                "host": "10.204.0.1:9",
                "authorization": f"Bearer {hooks.PLACEHOLDER_API_KEY}",
            })
        finally:
            urllib.request.urlopen = original
        self.assertEqual(status, 200)
        token = self.relay.upstream_key.rstrip(b"\r\n").decode()
        self.assertEqual(captured["auth"], f"Bearer {token}")
        self.assertEqual(captured["ua"], "Mozilla/5.0")
        self.assertNotIn(hooks.PLACEHOLDER_API_KEY, captured["auth"])
        self.assertNotIn(hooks.PLACEHOLDER_API_KEY.encode(), captured["data"])

    def test_02_other_run_and_closed_run_are_forbidden(self):
        other = new_run_id()
        status, _ = self.post(b"{}", run=other)
        self.assertEqual(status, 403)
        self.relay.close_run(self.run)
        status, _ = self.post(b"{}")
        self.assertEqual(status, 403)
        self.assertEqual(self.calls, [])

    def test_close_seals_the_log_and_a_later_edit_mismatches(self):
        self.relay.close_run(self.run)
        sig = self.relay.log_path(self.run).with_name("relay.jsonl.sig")
        self.assertTrue(sig.is_file())
        self.assertFalse(sig.is_symlink())
        self.assertEqual(stat.S_IMODE(sig.stat().st_mode), 0o600)
        self.assertTrue(self.relay.verify_log(self.run)["ok"])
        before = sig.read_bytes()
        with self.relay.log_path(self.run).open("a", encoding="utf-8") as handle:
            handle.write('{"type":"tamper"}\n')
        mismatch = self.relay.verify_log(self.run)
        self.assertFalse(mismatch["ok"])
        self.assertEqual(mismatch["reason"], "attest_mismatch")
        self.relay.close_run(self.run)
        self.assertEqual(sig.read_bytes(), before)
        self.assertFalse(self.relay.verify_log(self.run)["ok"])

    def test_editing_jsonl_is_detected(self):
        def fault_after(mutate):
            path = self.relay.log_path(self.run)
            mutate(path)
            report = self.relay.close_run(self.run)
            self.assertEqual(report["fault"], "attest_mismatch")
            self.assertFalse(path.with_name("relay.jsonl.sig").exists())
            self.assertTrue(path.is_file())
            self.assertIn('"fault":"attest_mismatch"', path.read_text(encoding="utf-8"))

        fault_after(lambda path: path.write_text(path.read_text(encoding="utf-8").replace('"pid":', '"pid":0,'), encoding="utf-8"))
        self.run = new_run_id()
        self.relay.open_run(self.run, "role:innovator", "abc")
        fault_after(lambda path: path.write_text(path.read_text(encoding="utf-8") + '{"type":"done"}\n', encoding="utf-8"))
        self.run = new_run_id()
        self.relay.open_run(self.run, "role:innovator", "abc")
        fault_after(lambda path: path.write_bytes(path.read_bytes()[:8]))

    def test_over_limit_is_refused_by_relay(self):
        self.relay.close_run(self.run)
        run = new_run_id()
        self.relay.open_run(run, "role:innovator", "abc")

        def at_innovator_cap(body, stream):
            usage = {"prompt_tokens": 200_000, "completion_tokens": 0, "prompt_tokens_details": {"cached_tokens": 0}}
            return 200, b"{}", usage

        self.relay.upstream = at_innovator_cap
        status, body = self.post(b'{"messages":[]}', run=run)
        self.assertEqual(status, 429)
        self.assertEqual(json.loads(body.decode())["error"], "innovatorCap")
        self.assertEqual(self.relay.loop_tokens, 200_000)
        report = self.relay.close_run(run)
        self.assertIsNone(report["fault"])
        self.assertEqual(report["refused"], "innovatorCap")
        self.assertEqual(report["tokens"], 200_000)
        self.assertFalse(report["usageMissing"])
        self.assertEqual(report["loopTokens"], 200_000)

        run = new_run_id()
        self.relay.open_run(run, "role:critic", "abc")
        forwarded = []

        def at_loop_cap(body, stream):
            forwarded.append(body)
            usage = {"prompt_tokens": 30_000_000, "completion_tokens": 0, "prompt_tokens_details": {"cached_tokens": 0}}
            return 200, b"{}", usage

        self.relay.upstream = at_loop_cap
        status, body = self.post(b'{"messages":[]}', run=run)
        self.assertEqual(status, 429)
        self.assertEqual(json.loads(body.decode())["error"], "readOnlyTokenCap")
        self.assertEqual(len(forwarded), 1)
        self.assertEqual(self.relay.loop_tokens, 200_000 + 30_000_000)
        report = self.relay.close_run(run)
        self.assertEqual(report["refused"], "readOnlyTokenCap")
        self.assertEqual(report["tokens"], 30_000_000)
        self.assertEqual(report["loopTokens"], 200_000 + 30_000_000)

        later = new_run_id()
        self.relay.open_run(later, "role:innovator", "abc")
        self.relay.upstream = lambda body, stream: forwarded.append(body) or (200, b"{}", {"prompt_tokens": 1, "completion_tokens": 0, "prompt_tokens_details": {"cached_tokens": 0}})
        status, body = self.post(b'{"messages":[]}', run=later)
        self.assertEqual(status, 429)
        self.assertEqual(json.loads(body.decode())["error"], "readOnlyTokenCap")
        self.assertEqual(len(forwarded), 1)
        self.assertEqual(self.relay.loop_tokens, 200_000 + 30_000_000)

    def test_missing_cached_field_is_usage_missing(self):
        ledger = Ledger()
        ledger.reqs = [{"seq": 1, "toolResults": []}]
        ledger.dones = [{"seq": 1, "status": 200, "usage": {"prompt_tokens": 3, "completion_tokens": 1}}]
        counted = tokens(ledger)
        self.assertTrue(counted["usage_missing"])
        self.assertIsNone(counted["tokens"])
        decision = classify(ledger)
        self.assertIn("usage_missing", decision["codes"])

        def bare(body, stream):
            return 200, b"{}", {"prompt_tokens": 3, "completion_tokens": 1}

        self.relay.upstream = bare
        status, _ = self.post(b'{"messages":[]}')
        self.assertEqual(status, 200)
        report = self.relay.report(self.run)
        self.assertIsNone(report["fault"])
        self.assertTrue(report["usageMissing"])
        self.assertEqual(report["tokens"], 0)
        self.assertEqual(self.relay.loop_tokens, 0)

    def test_mismatch_close_lets_the_next_run_open(self):
        path = self.relay.log_path(self.run)
        original = path.read_bytes()
        path.write_bytes(original + b'{"type":"tamper"}\n')
        report = self.relay.close_run(self.run)
        self.assertEqual(report["fault"], "attest_mismatch")
        kept = path.read_bytes()
        self.assertTrue(path.is_file())
        self.assertTrue(kept.startswith(original + b'{"type":"tamper"}\n'))
        self.assertIn(b'"fault":"attest_mismatch"', kept)
        nxt = new_run_id()
        self.relay.open_run(nxt, "role:innovator", "abc")
        self.assertIsNone(self.relay.close_run(nxt)["fault"])
        restarted = Relay(port=9, log_root=self.root / "logs", upstream_key_file=self.up, attest_key_file=self.att, upstream=self.upstream, allow_fake_upstream=True)
        again = new_run_id()
        restarted.open_run(again, "executor", "abc")
        self.assertIsNone(restarted.close_run(again)["fault"])
        self.assertEqual(path.read_bytes(), kept)

    def test_midline_truncate_close_is_its_own_line(self):
        path = self.relay.log_path(self.run)
        original = path.read_bytes()
        self.assertTrue(original.endswith(b"\n"))
        partial = b'{"type":"done","usage":{"prompt_tokens":12'
        path.write_bytes(original + partial)
        report = self.relay.close_run(self.run)
        self.assertEqual(report["fault"], "attest_mismatch")
        self.assertTrue(path.is_file())
        kept = path.read_bytes()
        self.assertTrue(kept.startswith(original + partial + b"\n"))
        close = kept[len(original + partial) + 1:]
        self.assertEqual(close.count(b"\n"), 1)
        row = json.loads(close.decode())
        self.assertEqual(row["type"], "close")
        self.assertEqual(row["fault"], "attest_mismatch")
        nxt = new_run_id()
        self.relay.open_run(nxt, "role:innovator", "abc")
        self.assertIsNone(self.relay.close_run(nxt)["fault"])

        killed_id = new_run_id()
        self.relay.open_run(killed_id, "role:critic", "abc")
        killed = self.relay.log_path(killed_id)
        raw = killed.read_bytes()
        chopped = raw + partial
        killed.write_bytes(chopped)
        restarted = Relay(port=9, log_root=self.root / "logs", upstream_key_file=self.up, attest_key_file=self.att, upstream=self.upstream, allow_fake_upstream=True)
        fresh = new_run_id()
        restarted.open_run(fresh, "executor", "abc")
        self.assertTrue(killed.is_file())
        after = killed.read_bytes()
        self.assertTrue(after.startswith(chopped + b"\n"))
        parsed = json.loads(after[len(chopped) + 1:].decode())
        self.assertEqual(parsed["type"], "close")
        self.assertEqual(parsed["fault"], "attest_mismatch")
        self.assertIsNone(restarted.close_run(fresh)["fault"])

    def test_restart_recounts_loop_tokens_including_red_runs(self):
        self.relay.close_run(self.run)
        exe = new_run_id()
        self.relay.open_run(exe, "executor", "abc")

        def usage_of(prompt):
            def upstream(body, stream):
                return 200, b"{}", {"prompt_tokens": prompt, "completion_tokens": 0, "prompt_tokens_details": {"cached_tokens": 0}}
            return upstream

        self.relay.upstream = usage_of(99999)
        self.assertEqual(self.post(b'{"messages":[]}', run=exe)[0], 200)
        self.assertIsNone(self.relay.close_run(exe)["fault"])

        innov = new_run_id()
        self.relay.open_run(innov, "role:innovator", "abc")
        self.relay.upstream = usage_of(1000)
        self.assertEqual(self.post(b'{"messages":[]}', run=innov)[0], 200)
        self.assertIsNone(self.relay.close_run(innov)["fault"])

        critic = new_run_id()
        self.relay.open_run(critic, "role:critic", "abc")
        self.relay.upstream = usage_of(500)
        self.assertEqual(self.post(b'{"messages":[]}', run=critic)[0], 200)
        path = self.relay.log_path(critic)
        path.write_bytes(path.read_bytes() + b'{"type":"tamper"}\n')
        self.assertEqual(self.relay.close_run(critic)["fault"], "attest_mismatch")

        restarted = Relay(port=9, log_root=self.root / "logs", upstream_key_file=self.up, attest_key_file=self.att, upstream=self.upstream, allow_fake_upstream=True)
        self.assertEqual(restarted.loop_tokens, 1500)
        nxt = new_run_id()
        restarted.open_run(nxt, "role:innovator", "abc")
        span = loop_mode.READ_ONLY_TOKEN_CAP - 1500
        restarted.upstream = usage_of(span)
        status, body = restarted.handle(
            "POST", f"/r/{nxt}/v1/chat/completions", b'{"messages":[]}', {"host": "10.204.0.1:9"},
        )
        self.assertEqual(status, 429)
        self.assertEqual(json.loads(body.decode())["error"], "readOnlyTokenCap")

    def test_execute_mode_disables_plant_ops(self):
        self.relay.plant_enabled = False
        with self.assertRaises(RuntimeError):
            self.relay.record(self.run, {"type": "req", "role": "innovator"})
        with self.assertRaises(RuntimeError):
            self.relay.plant_role(self.run, "innovator", 1, "{\"summary\":\"x\"}")
        with self.assertRaises(RuntimeError):
            self.relay.plant_reads(self.run, [])
        self.assertFalse(b'"role":"innovator"' in self.relay.log_path(self.run).read_bytes())

    def test_control_requires_mode(self):
        env = os.environ.copy()
        env["HARNESS_ATTEST_KEY_FILE"] = str(self.att)
        env["RELAY_UPSTREAM_KEY_FILE"] = str(self.up)
        script = str(HERE / "harness_relay.py")
        proc = subprocess.run(
            [sys.executable, script, "control", "--log-root", str(self.root / "mode-logs")],
            cwd=HERE, env=env, capture_output=True, text=True,
        )
        self.assertNotEqual(proc.returncode, 0)
        self.assertIn("--mode", proc.stderr + proc.stdout)
        saved_att = os.environ.get("HARNESS_ATTEST_KEY_FILE")
        saved_up = os.environ.get("RELAY_UPSTREAM_KEY_FILE")
        os.environ["HARNESS_ATTEST_KEY_FILE"] = str(self.att)
        os.environ["RELAY_UPSTREAM_KEY_FILE"] = str(self.up)
        try:
            bare = harness_relay._relay_from({"log-root": [str(self.root / "mode-logs")]})
            self.assertFalse(bare.plant_enabled)
            dry = harness_relay._relay_from({"log-root": [str(self.root / "mode-logs")], "mode": ["dry-run"]})
            self.assertTrue(dry.plant_enabled)
            execute = harness_relay._relay_from({"log-root": [str(self.root / "mode-logs")], "mode": ["execute"]})
            self.assertFalse(execute.plant_enabled)
        finally:
            if saved_att is None:
                os.environ.pop("HARNESS_ATTEST_KEY_FILE", None)
            else:
                os.environ["HARNESS_ATTEST_KEY_FILE"] = saved_att
            if saved_up is None:
                os.environ.pop("RELAY_UPSTREAM_KEY_FILE", None)
            else:
                os.environ["RELAY_UPSTREAM_KEY_FILE"] = saved_up

    def test_control_listens_forwards_and_seals(self):
        import threading
        import urllib.request
        from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

        usage = {"prompt_tokens": 11, "completion_tokens": 7, "prompt_tokens_details": {"cached_tokens": 1}}
        seen = []

        class Handler(BaseHTTPRequestHandler):
            def do_POST(self):
                length = int(self.headers.get("Content-Length") or 0)
                seen.append(self.rfile.read(length))
                raw = json.dumps({
                    "choices": [{"message": {"role": "assistant", "content": "{\"winnerId\":\"c0\"}"}}],
                    "usage": usage,
                }).encode()
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(raw)))
                self.end_headers()
                self.wfile.write(raw)

            def log_message(self, fmt, *args):
                return

        upstream = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        upstream_port = upstream.server_address[1]
        threading.Thread(target=upstream.serve_forever, daemon=True).start()
        relay_sock = __import__("socket").socket()
        relay_sock.bind(("127.0.0.1", 0))
        relay_port = relay_sock.getsockname()[1]
        relay_sock.close()
        run = new_run_id()
        root = self.root / "cli-logs"
        env = os.environ.copy()
        env["HARNESS_ATTEST_KEY_FILE"] = str(self.att)
        env["RELAY_UPSTREAM_KEY_FILE"] = str(self.up)
        script = str(HERE / "harness_relay.py")
        proc = subprocess.Popen(
            [sys.executable, script, "control", "--mode", "dry-run", "--log-root", str(root), "--port", str(relay_port), "--bind", "127.0.0.1", "--upstream", f"http://127.0.0.1:{upstream_port}/v1/chat/completions"],
            cwd=HERE, env=env, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
        )

        def rpc(msg):
            proc.stdin.write(json.dumps(msg) + "\n")
            proc.stdin.flush()
            line = proc.stdout.readline()
            self.assertNotEqual(line, "")
            return json.loads(line)

        try:
            self.assertTrue(rpc({"op": "open", "runId": run, "kind": "role:innovator", "expectedSha": "abc"})["ok"])
            refused = rpc({"op": "complete", "runId": run, "response": "{}", "usage": usage})
            self.assertFalse(refused["ok"])
            body = json.dumps({"messages": [{"role": "user", "content": "hi"}]}).encode()
            req = urllib.request.Request(
                f"http://127.0.0.1:{relay_port}/r/{run}/v1/chat/completions",
                data=body,
                method="POST",
                headers={"Content-Type": "application/json"},
            )
            with urllib.request.urlopen(req, timeout=5) as resp:
                self.assertEqual(resp.status, 200)
                self.assertEqual(json.loads(resp.read().decode())["usage"], usage)
            self.assertEqual(len(seen), 1)
            self.assertNotIn(self.up.read_bytes(), seen[0])
            self.assertTrue(rpc({"op": "close", "runId": run})["ok"])
            self.assertTrue(rpc({"op": "shutdown"})["ok"])
            proc.wait(timeout=5)
        finally:
            upstream.shutdown()
            upstream.server_close()
            if proc.poll() is None:
                proc.kill()
                proc.wait(timeout=5)
            err = ""
            if proc.stderr is not None and not proc.stderr.closed:
                err = proc.stderr.read()
            for pipe in (proc.stdin, proc.stdout, proc.stderr):
                if pipe is not None and not pipe.closed:
                    pipe.close()

        self.assertEqual(proc.returncode, 0, err)
        text = (root / run / "relay.jsonl").read_text(encoding="utf-8")
        self.assertIn('"type":"req"', text)
        self.assertIn('"type":"done"', text)
        self.assertIn('"type":"open"', text)
        self.assertIn('"prompt_tokens":11', text)
        self.assertIn('"assistant":"{\\"winnerId\\":\\"c0\\"}"', text)
        self.assertNotIn("plant-boot", text)
        self.assertNotIn(self.up.read_bytes().decode(), text)

        def run_cmd(args):
            return subprocess.run([sys.executable, script, *args], cwd=HERE, env=env, check=True, text=True, capture_output=True)

        verified = json.loads(run_cmd(["verify-log", "--log-root", str(root), "--run-id", run, "--port", str(relay_port), "--bind", "127.0.0.1"]).stdout)
        self.assertTrue(verified["ok"])
        gone = subprocess.run([sys.executable, script, "complete"], cwd=HERE, env=env, text=True, capture_output=True)
        self.assertNotEqual(gone.returncode, 0)

    def test_03_stream_without_usage_is_usage_missing(self):
        def bare(body, stream):
            self.calls.append(body)
            return 200, b"data: {\"choices\":[]}\n\n", None

        self.relay.upstream = bare
        body = json.dumps({"stream": True, "messages": [{"role": "user", "content": "a"}]}).encode()
        self.assertEqual(self.post(body)[0], 200)
        ledger = load(self.relay.log_path(self.run))
        self.assertTrue(ledger.reqs[0]["streamPatched"])
        self.assertTrue(tokens(ledger)["usage_missing"])
        decision = classify(ledger)
        self.assertEqual(decision["unscored_kind"], "infra")
        self.assertIn("usage_missing", decision["codes"])
        self.assertIsNone(decision["reward"])

    def test_04_disconnect_and_restart(self):
        before = canon.fsync_count
        status, _ = self.post(b'{"messages":[]}', client_disconnect=True)
        self.assertEqual(status, 499)
        self.assertGreater(canon.fsync_count, before)
        ledger = load(self.relay.log_path(self.run))
        done = ledger.dones[0]
        self.assertEqual(done["error"], "client_disconnect")
        decision = classify(ledger)
        self.assertIn("client_disconnect", decision["codes"])
        self.assertEqual(decision["unscored_kind"], "run")
        path = self.relay.log_path(self.run)
        canon.append_jsonl(path, {"type": "req", "seq": 2, "runId": self.run, "bootId": "other-boot", "toolResults": []})
        restarted = classify(load(path), {"expected_boot_id": self.relay.boot_id})
        self.assertIn("relay_restart", restarted["codes"])
        self.assertIn("client_disconnect", restarted["codes"])
        self.assertEqual(restarted["unscored_kind"], "run")
        pure = Ledger()
        pure.reqs = [{"seq": 1, "bootId": "other", "toolResults": []}]
        pure.dones = [{"seq": 1, "status": 200, "usage": dict(USAGE)}]
        alone = classify(pure, {"expected_boot_id": "boot"})
        self.assertEqual(alone["codes"], ["relay_restart"])
        self.assertEqual(alone["unscored_kind"], "infra")

    def test_05_bad_path_and_host_are_rejected_without_headers(self):
        self.relay.handle("POST", "/v1/files", b"{}", {"host": "10.204.0.1:9", "authorization": "Bearer incoming-secret"})
        self.relay.handle("GET", f"/r/{self.run}/v1/chat/completions", b"{}", {"host": "evil.example", "x-secret": "header-secret"})
        self.post(b'{"messages":[]}', {"host": "10.204.0.2:9", "authorization": "Bearer incoming-secret"})
        text = self.log_text()
        rejects = [json.loads(line) for line in text.splitlines() if '"type":"reject"' in line]
        self.assertGreaterEqual(len(rejects), 3)
        self.assertNotIn("incoming-secret", text)
        self.assertNotIn("header-secret", text)
        self.assertNotIn("authorization", text.lower())
        self.assertTrue(all(set(row) <= {"type", "ts", "ts_iso", "method", "path", "reason"} for row in rejects))

    def test_12_raw_key_in_body_is_rejected_and_encodings_are_not(self):
        secret = self.up.read_bytes()
        body = b'{"messages":[{"role":"user","content":"' + secret + b'"}]}'
        before = len(self.calls)
        status, _ = self.post(body)
        self.assertEqual(status, 403)
        self.assertEqual(len(self.calls), before)
        text = self.log_text()
        self.assertIn("secret_in_body", text)
        self.assertNotIn(secret.decode(), text)
        self.assertNotIn('"type":"req"', text)
        self.assertFalse((self.relay.log_path(self.run).parent / "tool").exists())
        encoded = base64.b64encode(secret)
        self.assertNotIn(secret, encoded)
        status, _ = self.post(b'{"messages":[{"role":"user","content":"' + encoded + b'"}]}')
        self.assertEqual(status, 200)
        self.assertEqual(len(self.calls), before + 1)

    def test_tool_results_come_from_the_assistant_call(self):
        body = json.dumps({
            "messages": [
                {"role": "assistant", "tool_calls": [{"id": "call_1", "type": "function", "function": {"name": "read", "arguments": json.dumps({"path": "/tmp/host"})}}]},
                {"role": "tool", "tool_call_id": "call_1", "content": "file-body"},
            ],
        }).encode()
        self.post(body)
        req = load(self.relay.log_path(self.run)).reqs[0]
        tool = req["toolResults"][0]
        self.assertEqual(tool["toolName"], "read")
        self.assertEqual(tool["args"]["path"], "/tmp/host")
        self.assertEqual(tool["tool_call_id"], "call_1")
        stored = (self.relay.log_path(self.run).parent / "tool" / tool["sha256"]).read_text(encoding="utf-8")
        self.assertEqual(stored, "file-body")

    def test_upstream_error_rows_carry_status_and_class(self):
        def fail(body, stream):
            return 400, b"context overflow", None

        self.relay.upstream = fail
        self.post(b'{"messages":[]}')
        done = load(self.relay.log_path(self.run)).dones[0]
        self.assertEqual(done["status"], 400)
        self.assertEqual(done["errClass"], "4xx")
        self.relay.upstream = lambda body, stream: (500, b"nope", None)
        self.post(b'{"messages":[]}')
        def down(body, stream):
            raise UpstreamNetworkError()

        self.relay.upstream = down
        self.post(b'{"messages":[]}')
        dones = load(self.relay.log_path(self.run)).dones
        self.assertEqual(dones[1]["errClass"], "5xx")
        self.assertEqual(dones[1]["status"], 500)
        self.assertEqual(dones[2]["errClass"], "network")
        self.assertIsNone(dones[2]["status"])

    def test_bind_policy_and_key_refusal(self):
        for host in ("0.0.0.0", "10.204.0.2", "127.0.0.1"):
            with self.assertRaises(RuntimeError):
                assert_bind_host(host)
        assert_bind_host("10.204.0.1")
        self.assertEqual(self.relay.host, "10.204.0.1")
        with self.assertRaises(RuntimeError):
            Relay(port=9, log_root=self.root / "bad-bind", upstream_key_file=self.up, attest_key_file=self.att, bind_host="0.0.0.0")
        loopback = Relay(
            port=9, log_root=self.root / "loopback", upstream_key_file=self.up, attest_key_file=self.att,
            bind_host="127.0.0.1", upstream=harness_relay._default_upstream, allow_fake_upstream=True,
        )
        self.assertEqual(loopback.host, "127.0.0.1")
        loop_run = new_run_id()
        loopback.open_run(loop_run, "executor", "abc")
        denied, _ = loopback.handle("POST", f"/r/{loop_run}/v1/chat/completions", b'{"messages":[]}', {"host": "10.204.0.1:9"})
        self.assertEqual(denied, 403)
        allowed, _ = loopback.handle("POST", f"/r/{loop_run}/v1/chat/completions", b'{"messages":[]}', {"host": "127.0.0.1:9"})
        self.assertEqual(allowed, 200)
        with self.assertRaises(RuntimeError):
            Relay(port=9, log_root=self.root / "a", upstream_key_file=self.att, attest_key_file=self.att)
        same = self.root / "same.key"
        write_key(same, self.att.read_bytes())
        with self.assertRaises(RuntimeError):
            Relay(port=9, log_root=self.root / "b", upstream_key_file=same, attest_key_file=self.att)
        self.assertEqual(self.relay.status()["relaySha"], harness_relay.relay_code_sha())
        self.assertEqual(len(new_run_id()), 32)
        with self.assertRaises(RuntimeError):
            self.relay.open_run(new_run_id(), "executor", "x")

    def test_production_relay_rejects_a_fake_upstream(self):
        root = self.root / "fake-upstream"
        with self.assertRaises(RuntimeError) as caught:
            Relay(port=9, log_root=root, upstream_key_file=self.up, attest_key_file=self.att, upstream=harness_relay._default_upstream)
        self.assertIn("fake upstream", str(caught.exception))
        fault = json.loads((root / "reject.jsonl").read_text(encoding="utf-8").splitlines()[-1])
        self.assertEqual(fault["type"], "fault")
        self.assertEqual(fault["fault"], "fake_upstream")
        with self.assertRaises(RuntimeError) as other:
            Relay(
                port=9, log_root=self.root / "lambda-upstream", upstream_key_file=self.up, attest_key_file=self.att,
                upstream=lambda body, stream: (200, b"{}", {}),
            )
        self.assertIn("fake upstream", str(other.exception))
        production = Relay(port=9, log_root=self.root / "real-upstream", upstream_key_file=self.up, attest_key_file=self.att, bind_host="127.0.0.1")
        self.assertTrue(harness_relay._is_production_upstream(production.upstream))
        production.upstream = harness_relay._default_upstream
        with self.assertRaises(RuntimeError) as swapped:
            production.open_run(new_run_id(), "executor", "abc")
        self.assertIn("fake upstream", str(swapped.exception))
        self.assertIsNone(production.open_id)
        again = json.loads((self.root / "real-upstream" / "reject.jsonl").read_text(encoding="utf-8").splitlines()[-1])
        self.assertEqual(again["fault"], "fake_upstream")

    def test_loop_control_uses_the_network_upstream(self):
        saved_att = os.environ.get("HARNESS_ATTEST_KEY_FILE")
        saved_up = os.environ.get("RELAY_UPSTREAM_KEY_FILE")
        os.environ["HARNESS_ATTEST_KEY_FILE"] = str(self.att)
        os.environ["RELAY_UPSTREAM_KEY_FILE"] = str(self.up)
        try:
            flags = harness_relay._flags(["--log-root", str(self.root / "loop-wire"), "--port", "8642", "--bind", "127.0.0.1", "--mode", "execute"])
            relay = harness_relay.prepare_control(flags)
            self.assertEqual(relay.upstream_url, harness_relay.UPSTREAM_URL)
            assert_network_post(self, relay, harness_relay.UPSTREAM_URL)
            local = "http://127.0.0.1:9/v1/chat/completions"
            overridden = harness_relay.prepare_control(harness_relay._flags([
                "--log-root", str(self.root / "loop-override"), "--port", "8642", "--bind", "127.0.0.1",
                "--mode", "dry-run", "--upstream", local,
            ]))
            self.assertEqual(overridden.upstream_url, local)
            assert_network_post(self, overridden, local)
            self.assertIsNot(overridden.upstream, harness_relay._default_upstream)
        finally:
            if saved_att is None:
                os.environ.pop("HARNESS_ATTEST_KEY_FILE", None)
            else:
                os.environ["HARNESS_ATTEST_KEY_FILE"] = saved_att
            if saved_up is None:
                os.environ.pop("RELAY_UPSTREAM_KEY_FILE", None)
            else:
                os.environ["RELAY_UPSTREAM_KEY_FILE"] = saved_up

        import socket
        relay_sock = socket.socket()
        relay_sock.bind(("127.0.0.1", 0))
        relay_port = relay_sock.getsockname()[1]
        relay_sock.close()
        root = self.root / "loop-cli"
        env = os.environ.copy()
        env["HARNESS_ATTEST_KEY_FILE"] = str(self.att)
        env["RELAY_UPSTREAM_KEY_FILE"] = str(self.up)
        proc = subprocess.Popen(
            [sys.executable, str(HERE / "harness_relay.py"), "control", "--mode", "execute", "--log-root", str(root), "--port", str(relay_port), "--bind", "127.0.0.1"],
            cwd=HERE, env=env, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
        )

        def rpc(msg):
            proc.stdin.write(json.dumps(msg) + "\n")
            proc.stdin.flush()
            line = proc.stdout.readline()
            self.assertNotEqual(line, "")
            return json.loads(line)

        err = ""
        try:
            opened = rpc({"op": "open", "runId": new_run_id(), "kind": "executor", "expectedSha": "abc"})
            self.assertTrue(opened["ok"], opened)
            self.assertTrue(rpc({"op": "shutdown"})["ok"])
            proc.wait(timeout=5)
        finally:
            if proc.poll() is None:
                proc.kill()
                proc.wait(timeout=5)
            if proc.stderr is not None and not proc.stderr.closed:
                err = proc.stderr.read()
            for pipe in (proc.stdin, proc.stdout, proc.stderr):
                if pipe is not None and not pipe.closed:
                    pipe.close()
        self.assertEqual(proc.returncode, 0, err)
        self.assertFalse((root / "reject.jsonl").exists())

    def test_tokens_usage_missing_is_only_2xx(self):
        ledger = Ledger()
        ledger.dones = [
            {"seq": 1, "status": 400, "errClass": "4xx", "usage": None},
            {"seq": 2, "status": 200, "usage": USAGE},
        ]
        self.assertFalse(tokens(ledger)["usage_missing"])
        ledger.dones.append({"seq": 3, "status": 200, "usage": None})
        self.assertTrue(tokens(ledger)["usage_missing"])
        bad = Ledger()
        bad.dones = [{"seq": 1, "status": 200, "usage": {"prompt_tokens": 1, "completion_tokens": 1}}]
        missing = tokens(bad)
        self.assertTrue(missing["usage_missing"])
        self.assertIsNone(missing["tokens"])
        self.assertIn("usage_missing", classify(bad)["codes"])


def _req(seq, boot="boot", usage=USAGE, status=200, error=None, err=None, run="r" * 32):
    return (
        {"type": "req", "seq": seq, "runId": run, "bootId": boot, "toolResults": [], "systemConfigHashes": []},
        {"type": "done", "seq": seq, "status": status, "usage": usage, "error": error, "errClass": err},
    )


def ledger_of(rows, *, errors=None, run=None):
    ledger = Ledger()
    ledger.run_id = run
    ledger.validation_errors = list(errors or [])
    for row in rows:
        if row["type"] == "req":
            ledger.reqs.append(row)
            if row.get("conclusion") is True and ledger.conclusion_seq is None:
                ledger.conclusion_seq = row["seq"]
        elif row["type"] == "done":
            cleaned = {k: v for k, v in row.items() if v is not None or k in ("status", "usage")}
            ledger.dones.append(cleaned)
    return ledger


class ClassifyCase(unittest.TestCase):
    def test_08c_zero_requests_are_recorded_and_not_rerun(self):
        decision = classify(Ledger())
        self.assertEqual(decision["codes"], ["no_requests"])
        self.assertEqual(decision["unscored_kind"], "infra")
        self.assertIsNone(decision["reward"])
        self.assertNotIn("action", decision)
        self.assertNotIn("rerun", decision)

    def test_08d_disconnect_result_and_cooccurrence(self):
        rid = "ab" * 16
        echoed = ledger_of([
            {"type": "req", "seq": 1, "runId": rid, "bootId": "b", "toolResults": []},
            {"type": "done", "seq": 1, "status": 200, "usage": USAGE},
        ])
        refused = classify(echoed, {"container_text": "connection refused"})
        self.assertNotIn("connect_failed", refused["codes"])
        killed = ledger_of([
            {"type": "req", "seq": 1, "runId": rid, "bootId": "b", "toolResults": []},
            {"type": "done", "seq": 1, "status": None, "usage": None, "error": "client_disconnect"},
        ])
        death = classify(killed)
        self.assertIn("client_disconnect", death["codes"])
        self.assertEqual(death["unscored_kind"], "run")
        edited = classify(echoed, {"expected_run_id": rid, "result_run_id": "ff" * 16})
        self.assertEqual(edited["codes"], ["result_runid_mismatch"])
        self.assertEqual(edited["unscored_kind"], "run")
        both = classify(ledger_of([
            {"type": "req", "seq": 1, "runId": rid, "bootId": "b", "toolResults": []},
            {"type": "done", "seq": 1, "status": 200, "usage": None},
        ]), {"token_cap": True})
        self.assertEqual(both["unscored_kind"], "run")
        self.assertIn("usage_missing", both["codes"])
        self.assertIn("token_cap", both["codes"])
        self.assertIsNone(both["reward"])

    def test_upstream_classes_and_docker_events(self):
        rid = "cd" * 16
        client = classify(ledger_of([
            {"type": "req", "seq": 1, "runId": rid, "bootId": "b", "toolResults": []},
            {"type": "done", "seq": 1, "status": 400, "usage": None, "error": "upstream_http", "errClass": "4xx"},
        ]))
        self.assertEqual(client["codes"], ["upstream_client_error"])
        self.assertNotIn("usage_missing", client["codes"])
        self.assertEqual(client["unscored_kind"], "run")
        server = classify(ledger_of([
            {"type": "req", "seq": 1, "runId": rid, "bootId": "b", "toolResults": []},
            {"type": "done", "seq": 1, "status": 500, "usage": None, "error": "upstream_http", "errClass": "5xx"},
        ]))
        self.assertEqual(server["codes"], ["upstream_server_error"])
        self.assertEqual(server["unscored_kind"], "infra")
        network = classify(ledger_of([
            {"type": "req", "seq": 1, "runId": rid, "bootId": "b", "toolResults": []},
            {"type": "done", "seq": 1, "status": None, "usage": None, "error": "upstream_network", "errClass": "network"},
        ]))
        self.assertIn("upstream_server_error", network["codes"])
        own = classify(ledger_of([
            {"type": "req", "seq": 1, "runId": rid, "bootId": "b", "toolResults": []},
            {"type": "done", "seq": 1, "status": 200, "usage": USAGE},
        ]), {"docker_event": "oom"})
        self.assertNotIn("docker_daemon_event", own["codes"])
        for event in ("die", "kill", "exit"):
            decision = classify(ledger_of([
                {"type": "req", "seq": 1, "runId": rid, "bootId": "b", "toolResults": []},
                {"type": "done", "seq": 1, "status": 200, "usage": USAGE},
            ]), {"docker_event": event})
            self.assertNotIn("docker_daemon_event", decision["codes"])
        daemon = classify(ledger_of([
            {"type": "req", "seq": 1, "runId": rid, "bootId": "b", "toolResults": []},
            {"type": "done", "seq": 1, "status": 200, "usage": USAGE},
        ]), {"docker_event": "dockerd_restart"})
        self.assertIn("docker_daemon_event", daemon["codes"])
        self.assertEqual(daemon["unscored_kind"], "infra")

    def test_connect_failed_needs_zero_requests_and_host_evidence(self):
        empty = classify(Ledger(), {"connect_evidence": "host"})
        self.assertEqual(empty["codes"], ["connect_failed"])
        text_only = classify(Ledger(), {"container_text": "connection refused"})
        self.assertEqual(text_only["codes"], ["no_requests"])
        self.assertNotIn("connect_failed", text_only["codes"])


def _file(path: Path, text: str) -> str:
    path.write_text(text, encoding="utf-8")
    return hashlib.sha256(text.encode()).hexdigest()


_PI_TRUNCATE = (
    Path(__file__).resolve().parents[2]
    / "node_modules/@earendil-works/pi-coding-agent/dist/core/tools/truncate.js"
)
# Same assembly as pi-coding-agent dist/core/tools/read.js (truncation notice).
_PI_READ_CHUNK_JS = r"""
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
const { truncateHead, formatSize, DEFAULT_MAX_BYTES } = await import(pathToFileURL(process.env.PI_TRUNCATE).href);
const textContent = readFileSync(0, "utf8");
const offset = process.env.OFFSET ? Number(process.env.OFFSET) : undefined;
const allLines = textContent.split("\n");
const totalFileLines = allLines.length;
const startLine = offset ? Math.max(0, offset - 1) : 0;
const startLineDisplay = startLine + 1;
const selectedContent = allLines.slice(startLine).join("\n");
const truncation = truncateHead(selectedContent);
if (!truncation.truncated || truncation.firstLineExceedsLimit) {
  throw new Error("expected a truncated read");
}
const endLineDisplay = startLineDisplay + truncation.outputLines - 1;
const nextOffset = endLineDisplay + 1;
let outputText = truncation.content;
if (truncation.truncatedBy === "lines") {
  outputText += `\n\n[Showing lines ${startLineDisplay}-${endLineDisplay} of ${totalFileLines}. Use offset=${nextOffset} to continue.]`;
} else {
  outputText += `\n\n[Showing lines ${startLineDisplay}-${endLineDisplay} of ${totalFileLines} (${formatSize(DEFAULT_MAX_BYTES)} limit). Use offset=${nextOffset} to continue.]`;
}
process.stdout.write(JSON.stringify({
  outputText,
  startLine: startLineDisplay,
  endLine: endLineDisplay,
  truncatedBy: truncation.truncatedBy,
}));
"""


def _pi_read_chunk(text: str, offset: int | None = None) -> dict:
    if not _PI_TRUNCATE.is_file():
        raise AssertionError(f"pi truncate.js missing: {_PI_TRUNCATE}")
    env = os.environ.copy()
    env["PI_TRUNCATE"] = str(_PI_TRUNCATE)
    if offset is None:
        env.pop("OFFSET", None)
    else:
        env["OFFSET"] = str(offset)
    proc = subprocess.run(
        ["node", "--input-type=module", "-e", _PI_READ_CHUNK_JS],
        input=text.encode(),
        env=env,
        check=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )
    return json.loads(proc.stdout)


def _read_ledger(path: Path, body: str, *, tool="read", seq=1, conclusion=None, run="ee" * 16):
    ledger = Ledger()
    ledger.run_id = run
    sha = hashlib.sha256(body.encode()).hexdigest()
    ledger.tool_bodies[sha] = body
    req = {
        "type": "req", "seq": seq, "runId": run, "toolResults": [{
            "sha256": sha, "tool_call_id": "c0", "toolName": tool, "args": {"path": str(path)},
        }],
    }
    ledger.reqs.append(req)
    if conclusion is not None:
        ledger.conclusion_seq = conclusion
        if conclusion == seq:
            req["conclusion"] = True
        else:
            ledger.reqs.append({"type": "req", "seq": conclusion, "runId": run, "toolResults": [], "conclusion": True})
    return ledger


class EvidenceCase(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)

    def tearDown(self):
        self.tmp.cleanup()

    def test_10b_segment_rules(self):
        lines = [f"L{i:02d}-" + ("x" * 70) for i in range(6)]
        text = "\n".join(lines) + "\n"
        host = self.root / "host.txt"
        digest = _file(host, text)
        segment = "\n".join(lines[1:4]) + "\n"
        self.assertGreaterEqual(len(segment.encode()), 200)
        ok = read_evidence(_read_ledger(host, segment), host, digest)
        self.assertTrue(ok["ok"])
        self.assertEqual((ok["startLine"], ok["endLine"]), (2, 4))
        brace = read_evidence(_read_ledger(host, "{"), host, digest)
        self.assertFalse(brace["ok"])
        twice = "\n".join(lines[0:3]) + "\n" + "\n".join(lines[0:3]) + "\n"
        dup_host = self.root / "dup.txt"
        dup_sha = _file(dup_host, twice)
        dup_seg = "\n".join(lines[0:3]) + "\n"
        self.assertFalse(read_evidence(_read_ledger(dup_host, dup_seg), dup_host, dup_sha)["ok"])
        bash = read_evidence(_read_ledger(host, text, tool="bash"), host, digest)
        self.assertFalse(bash["ok"])
        late = read_evidence(_read_ledger(host, text, seq=3, conclusion=2), host, digest)
        self.assertFalse(late["ok"])
        spliced = lines[0] + "\n" + lines[2] + "\n" + lines[4] + "\n"
        self.assertFalse(read_evidence(_read_ledger(host, spliced), host, digest)["ok"])
        altered = segment.replace("x", "y", 1)
        self.assertFalse(read_evidence(_read_ledger(host, altered), host, digest)["ok"])
        outside = read_evidence(_read_ledger(host, segment), host, digest, [1])
        self.assertFalse(outside["ok"])
        prefixed = "\n".join(f"{i + 2}|{lines[i + 1]}" for i in range(3)) + "\n"
        self.assertTrue(read_evidence(_read_ledger(host, prefixed), host, digest)["ok"])
        mixed = "1|" + lines[1] + "\n" + lines[2] + "\n" + lines[3] + "\n"
        self.assertFalse(read_evidence(_read_ledger(host, mixed), host, digest)["ok"])
        self.assertEqual(strip_line_prefixes("1|a\n2|b\n"), "a\nb\n")
        self.assertEqual(strip_line_prefixes("1|a\nb\n"), "1|a\nb\n")

    def test_10g_cited_ranges_and_short_files(self):
        lines = [f"L{i}-" + ("y" * 70) for i in range(5)]
        lines[3] = "   "
        text = "\n".join(lines) + "\n"
        host = self.root / "cited.txt"
        digest = _file(host, text)
        segment = "\n".join(lines[0:4]) + "\n"
        self.assertTrue(read_evidence(_read_ledger(host, segment), host, digest, [1, 2])["ok"])
        self.assertFalse(read_evidence(_read_ledger(host, segment), host, digest, [4, 5])["ok"])
        self.assertFalse(read_evidence(_read_ledger(host, segment), host, digest, [4])["ok"])
        short = self.root / "short.txt"
        short_text = "only a short file\nsecond\n"
        short_sha = _file(short, short_text)
        self.assertLess(len(short_text.encode()), 200)
        self.assertFalse(read_evidence(_read_ledger(short, "only a short file\n"), short, short_sha)["ok"])
        self.assertTrue(read_evidence(_read_ledger(short, short_text), short, short_sha)["ok"])

    def test_pi_chunk_notice_strips_for_first_and_middle(self):
        lines = [f"{i:05d}-" + ("x" * 80) for i in range(1, 1401)]
        text = "\n".join(lines) + "\n"
        self.assertGreater(len(text.encode()), 50 * 1024)
        host = self.root / "wide.txt"
        digest = _file(host, text)
        file_lines = text.splitlines()
        for offset in (None, 400):
            chunk = _pi_read_chunk(text, offset)
            self.assertEqual(chunk["truncatedBy"], "bytes")
            body = chunk["outputText"]
            self.assertIn("(50.0KB limit)", body)
            self.assertNotIn("[Showing lines", text)
            got = read_evidence(_read_ledger(host, body), host, digest)
            self.assertTrue(got["ok"], got)
            self.assertEqual((got["startLine"], got["endLine"]), (chunk["startLine"], chunk["endLine"]))
            span = "\n".join(file_lines[got["startLine"] - 1:got["endLine"]])
            self.assertNotIn("Showing lines", span)
            self.assertNotIn("more lines in file", span)
            self.assertTrue(body.startswith(span))
            self.assertGreater(len(body), len(span))

    def test_altered_or_misplaced_read_notice_is_rejected(self):
        lines = [f"{i:05d}-" + ("y" * 80) for i in range(1, 1401)]
        text = "\n".join(lines) + "\n"
        host = self.root / "wide.txt"
        digest = _file(host, text)
        body = _pi_read_chunk(text)["outputText"]
        at = body.rfind("\n\n[")
        content, notice = body[:at], body[at:]
        self.assertRegex(
            notice,
            r"\n\n\[Showing lines \d+-\d+ of \d+ \(50\.0KB limit\)\. Use offset=\d+ to continue\.\]\Z",
        )
        self.assertTrue(read_evidence(_read_ledger(host, content + notice), host, digest)["ok"])

        def rejected(tool_text: str) -> None:
            got = read_evidence(_read_ledger(host, tool_text), host, digest)
            self.assertFalse(got["ok"])
            self.assertEqual(got["reason"], "no_segment")

        rejected(content + notice.replace("Showing lines", "Showing rows", 1))
        rejected(content + notice.replace("to continue", "to  continue", 1))
        rejected(content + notice.replace(" of ", " of x", 1))
        parts = content.split("\n")
        rejected("\n".join(parts[:20]) + notice + "\n" + "\n".join(parts[20:]))
        rejected(content + notice + notice)
        rejected(notice)

    def test_08_citation_is_per_run_and_innovator_checks_the_patch(self):
        host = self.root / "gap.txt"
        text = "gap output\n"
        digest = _file(host, text)
        own = _read_ledger(host, text, run="11" * 16)
        self.assertTrue(read_evidence(own, host, digest)["ok"])
        empty = Ledger()
        empty.run_id = "22" * 16
        self.assertFalse(read_evidence(empty, host, digest)["ok"])
        good = hooks.innovator_check(own, host, digest, "cand", "cand", 24, 24)
        self.assertTrue(good["ok"])
        self.assertFalse(hooks.innovator_check(own, host, digest, "cand", "other", 24, 24)["ok"])
        self.assertFalse(hooks.innovator_check(own, host, digest, "cand", "cand", 23, 24)["ok"])
        self.assertFalse(hooks.innovator_check(empty, host, digest, "cand", "cand", 24, 24)["ok"])


class RelativeRoleReadCase(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.role = self.root / "role"
        (self.role / "traces").mkdir(parents=True)
        self.body = "alpha\nbeta\ngamma\n"
        self.digest = hashlib.sha256(self.body.encode()).hexdigest()
        self.copy = self.role / "traces" / "round0-trace.jsonl"
        self.copy.write_text(self.body, encoding="utf-8")

    def tearDown(self):
        self.tmp.cleanup()

    def test_relative_read_matches_from_the_role_cwd(self):
        ledger = _read_ledger("traces/round0-trace.jsonl", self.body)
        got = read_evidence(ledger, self.copy, self.digest, role_cwd=self.role)
        self.assertTrue(got["ok"], got)
        self.assertFalse(read_evidence(ledger, self.copy, self.digest)["ok"])

    def test_parent_escape_is_rejected(self):
        secret = self.root / "secret.jsonl"
        secret.write_text(self.body, encoding="utf-8")
        ledger = _read_ledger("../secret.jsonl", self.body)
        got = read_evidence(ledger, secret, self.digest, role_cwd=self.role)
        self.assertFalse(got["ok"])
        self.assertEqual(got["reason"], "no_segment")

    def test_symlink_out_is_rejected(self):
        secret = self.root / "secret.jsonl"
        secret.write_text(self.body, encoding="utf-8")
        link = self.role / "traces" / "leak.jsonl"
        link.symlink_to(secret)
        ledger = _read_ledger("traces/leak.jsonl", self.body)
        self.assertFalse(read_evidence(ledger, secret, self.digest, role_cwd=self.role)["ok"])
        self.assertFalse(read_evidence(ledger, self.copy, self.digest, role_cwd=self.role)["ok"])

    def test_absolute_read_still_matches(self):
        ledger = _read_ledger(self.copy, self.body)
        self.assertTrue(read_evidence(ledger, self.copy, self.digest, role_cwd=self.role)["ok"])
        self.assertTrue(read_evidence(ledger, self.copy, self.digest)["ok"])


class HookCase(unittest.TestCase):
    def test_06_and_08b_argv(self):
        executor = new_run_id()
        role = new_run_id()
        argv = hooks.container_argv(
            image="img", run_id=executor, port=8642, network="devii-004-int", env={"HOME": "/tmp"},
            mounts=[("/src/config", "/config")], command=["run"], role_run_ids=[role],
        )
        blob = "\n".join(argv)
        self.assertIn("devii-004-int", argv)
        self.assertNotIn("--add-host", argv)
        self.assertIn("NET_RAW", argv)
        self.assertEqual(argv[argv.index("--cap-drop") + 1], "NET_RAW")
        self.assertNotIn("/home/box", blob)
        self.assertNotIn("shared", argv)
        with self.assertRaises(ValueError):
            hooks.container_argv(
                image="img", run_id=executor, port=1, network="devii-004-int", env={},
                mounts=[("/home/box/.harness-relay/abc", "/relay")], command=["run"],
            )
        serial = [
            hooks.container_argv(image="img", run_id=new_run_id(), port=1, network="devii-004-int", env={}, mounts=[("/src/a", "/a")], command=["run"])
            for _ in range(2)
        ]
        for argv_i in serial:
            self.assertEqual(argv_i[argv_i.index("--cap-drop") + 1], "NET_RAW")
            self.assertNotIn("/home/box", "\n".join(argv_i))
        self.assertNotIn("open", argv)
        self.assertEqual([item for item in argv if "API_KEY" in item], [f"API_KEY={hooks.PLACEHOLDER_API_KEY}"])
        self.assertNotIn(role, blob)
        self.assertIn(f"HARNESS_RUN_ID={executor}", blob)
        self.assertNotIn(executor, "/src/config")
        with self.assertRaises(ValueError):
            hooks.container_argv(image="img", run_id=executor, port=1, network="shared", env={}, mounts=[], command=["run"])
        with self.assertRaises(ValueError):
            hooks.container_argv(image="img", run_id=executor, port=1, network="open", env={}, mounts=[], command=["run"])
        with self.assertRaises(ValueError):
            hooks.container_argv(image="img", run_id=executor, port=1, network="devii-004-int", env={"API_KEY": "x"}, mounts=[], command=["run"])
        with self.assertRaises(ValueError):
            hooks.container_argv(image="img", run_id=executor, port=1, network="devii-004-int", env={"API_KEY": "sk-live-key"}, mounts=[], command=["run"])
        allowed = hooks.container_argv(
            image="img", run_id=executor, port=1, network="devii-004-int",
            env={"API_KEY": hooks.PLACEHOLDER_API_KEY}, mounts=[], command=["run"],
        )
        self.assertEqual([item for item in allowed if "API_KEY" in item], [f"API_KEY={hooks.PLACEHOLDER_API_KEY}"])
        rejects = [{"type": "reject"}, {"type": "req"}, {"type": "reject"}]
        self.assertEqual(sum(1 for row in rejects if row["type"] == "reject"), 2)

    def test_07_t_first_survives_rewrite_and_delete(self):
        tmp = tempfile.TemporaryDirectory()
        root = Path(tmp.name)
        final = root / "answer.txt"
        final.write_text("one")
        watcher = hooks.OutputWatcher(root, "answer.txt", root / "outputEvents.jsonl")
        watcher.poll_once(10)
        final.write_text("two")
        watcher.poll_once(20)
        final.unlink()
        watcher.poll_once(30)
        final.write_text("three")
        watcher.poll_once(40)
        self.assertEqual(watcher.t_first, 10)
        self.assertEqual(watcher.t_last_write, 40)
        tmp.cleanup()

    def test_10_patch_active_needs_every_request(self):
        sha = "ab" * 32
        ledger = Ledger()
        ledger.reqs = [
            {"systemConfigHashes": [sha]},
            {"systemConfigHashes": []},
        ]
        self.assertFalse(patch_active(ledger, sha)["active"])
        self.assertEqual(patch_active(ledger, sha)["requests"], 2)
        ledger.reqs[1]["systemConfigHashes"] = [sha]
        self.assertTrue(patch_active(ledger, sha)["active"])
        self.assertFalse(patch_active(Ledger(), sha)["active"])

    def test_10c_kinds_and_reconcile(self):
        mapping = {
            "usage_missing": "infra",
            "relay_restart": "infra",
            "attest_mismatch": "infra",
            "no_requests": "infra",
            "connect_failed": "infra",
            "prerun_layout": "infra",
            "docker_daemon_event": "infra",
            "upstream_server_error": "infra",
            "token_cap": "run",
            "checker_undecided": "run",
            "client_disconnect": "run",
            "result_runid_mismatch": "run",
            "布局违规": "run",
            "upstream_client_error": "run",
        }
        for code, kind in mapping.items():
            self.assertEqual(kind, "infra" if code in hooks.INFRA_CODES else "run")
        with self.assertRaises(ValueError):
            hooks.reconcile_first_run(task="hb003", expected_task="", config_sha=hooks.CONTROL_CONFIG_SHA, seed=9, arm="control", reconcile=True)
        good = hooks.reconcile_first_run(task="tasks3/hb003", expected_task="hb003", config_sha=hooks.CONTROL_CONFIG_SHA, seed=9, arm="control", reconcile=True)
        self.assertEqual(good, {"accepted": True, "purpose": "reconcile", "exclude": True})
        again = hooks.reconcile_first_run(task="hb003", expected_task="hb003", config_sha=hooks.CONTROL_CONFIG_SHA, seed=9, arm="control", reconcile=True, already=True)
        self.assertFalse(again["accepted"])
        other = hooks.reconcile_first_run(task="i014", expected_task="hb003", config_sha=hooks.CONTROL_CONFIG_SHA, seed=9, arm="control", reconcile=True)
        self.assertFalse(other["accepted"])
        wrong = hooks.reconcile_first_run(task="hb003", expected_task="hb003", config_sha=hooks.CONTROL_CONFIG_SHA, seed=8, arm="control", reconcile=True)
        self.assertFalse(wrong["accepted"])
        rows = [{"purpose": "reconcile", "reward": 0}, {"purpose": "dev", "reward": 1}]
        kept = hooks.exclude_from_statistics(rows)
        self.assertEqual(kept, [{"purpose": "dev", "reward": 1}])

    def test_10d_and_11_layout(self):
        tmp = tempfile.TemporaryDirectory()
        root = Path(tmp.name)
        mount = root / "config.json"
        mount.write_text("{}\n")
        mounts = [(str(mount), "/config")]
        bad = root / "bad"
        bad.mkdir()
        os.symlink(root / "elsewhere", bad / "outputs")
        (bad / "workspace").mkdir()
        (bad / "workspace" / "junk").write_text("x")
        launched = []
        first = hooks.prepare_container(bad, mounts, mounts, lambda: launched.append(1))
        self.assertFalse(first["started"])
        self.assertEqual(launched, [])
        self.assertIn("prerun_layout", first["classify"]["codes"])
        self.assertEqual(first["classify"]["unscored_kind"], "infra")
        fresh = root / "fresh"
        second = hooks.prepare_container(fresh, mounts, mounts, lambda: launched.append(1))
        self.assertTrue(second["started"])
        self.assertEqual(launched, [1])
        outputs = fresh / "outputs"
        outputs.mkdir()
        os.symlink(mount, outputs / "link")
        self.assertTrue(hooks.output_layout_violation(fresh))
        later = classify(ledger_of([
            {"type": "req", "seq": 1, "runId": "aa" * 16, "bootId": "b", "toolResults": []},
            {"type": "done", "seq": 1, "status": 200, "usage": USAGE},
        ]), {"layout_violation": True})
        self.assertEqual(later["codes"], ["布局违规"])
        self.assertEqual(later["unscored_kind"], "run")
        key = b"k" * 32
        sealed = hooks.seal_layout(second["layout"], key)
        self.assertTrue(hooks.verify_layout(sealed, key))
        sealed["sha"] = "0" * 64
        self.assertFalse(hooks.verify_layout(sealed, key))
        tmp.cleanup()

    def test_regression_uses_relay_tokens(self):
        decision = hooks.score_from_relay(99_000_000, 10, 1_000)
        self.assertEqual(decision["codes"], ["token_cap"])
        self.assertEqual(decision["unscored_kind"], "run")
        self.assertIsNone(decision["reward"])

    def test_09_replayed_run_id_fails_verify(self):
        expected = "ab" * 16
        other = "cd" * 16
        result = hooks.verify_run_binding(
            expected_run_id=expected, attest_run_id=other, relay_run_id=other, result_run_id=other,
            network=hooks.ATTEST_NETWORK, relay_sha="sha", expected_relay_sha="sha",
        )
        self.assertFalse(result["ok"])
        self.assertEqual(result["code"], "result_runid_mismatch")
        self.assertEqual(result["kind"], "run")


class LoopModeCase(unittest.TestCase):
    def test_11_each_cap_and_forged_trace(self):
        key = b"k" * 32
        seed = bytes.fromhex("ab" * 32)
        with self.assertRaises(ValueError):
            loop_mode.pre_round1_sign(key, seed=seed, ranker={"tools": ["read"]}, critic={"tools": ["read"]})
        round0_path = "heldout/hb003/seed0/.../trace.jsonl"
        round0_sha = "3e4f857cfbaae07c3901c379bcdcdd681c15f2438881ad943a6ab6cc957b1a76"
        signed = loop_mode.pre_round1_sign(
            key, seed=seed, ranker={"tools": ["read"]}, critic={"tools": ["read"]},
            round0_path=round0_path, round0_sha=round0_sha,
        )
        self.assertEqual(signed["seed"], 0)
        self.assertEqual(signed["innovatorCap"], 200_000)
        self.assertEqual(signed["maxRounds"], 10)
        self.assertEqual(signed["readOnlyTokenCap"], 30_000_000)
        self.assertEqual(signed["readOnlyWallCapS"], 48 * 3600)
        self.assertEqual(signed["realRunWallCapS"], 103 * 3600)
        self.assertEqual(signed["ranker"], {"tools": ["read"]})
        self.assertEqual(signed["critic"], {"tools": ["read"]})
        self.assertEqual(signed["seedSha"], hashlib.sha256(seed).hexdigest())
        self.assertTrue(loop_mode.verify_pre_round1(signed, key))
        with self.assertRaises(ValueError):
            loop_mode.pre_round1_sign(key, seed=seed, ranker={}, critic={}, round_started=True)

        ten = loop_mode.drive([{} for _ in range(11)])
        self.assertEqual(ten["reason"], "maxRounds")
        self.assertIn("role:10", ten["calls"])
        self.assertIn("real:10", ten["calls"])
        self.assertNotIn("role:11", ten["calls"])
        self.assertNotIn("real:11", ten["calls"])

        tokens = loop_mode.drive([{}], read_only_tokens_n=30_000_000)
        self.assertEqual(tokens["reason"], "readOnlyTokenCap")
        self.assertEqual(tokens["calls"], [])

        wall = loop_mode.drive([{}], read_only_wall_s=48 * 3600)
        self.assertEqual(wall["reason"], "readOnlyWallCap")
        self.assertEqual(wall["calls"], [])

        real = loop_mode.drive([{"real_run_wall_s": 103 * 3600}, {}])
        self.assertEqual(real["calls"], ["role:1", "real:1"])
        self.assertEqual(real["loggedRuns"], [1])
        self.assertEqual(real["reason"], "realRunWallCap")
        self.assertNotIn("role:2", real["calls"])

        usage = {"prompt_tokens": 4, "completion_tokens": 1, "prompt_tokens_details": {"cached_tokens": 0}}
        huge = {"prompt_tokens": 10 ** 9, "completion_tokens": 1, "prompt_tokens_details": {"cached_tokens": 0}}
        events = [
            {"type": "done", "role": "critic", "status": 200, "usage": usage},
            {"type": "done", "role": "executor", "status": 200, "usage": huge},
        ]
        counted = loop_mode.read_only_tokens(events, {"tokens": 10 ** 9})
        self.assertEqual(counted["tokens"], 5)
        self.assertFalse(counted["usage_missing"])

        mixed = loop_mode.drive([
            {"host_fault": True},
            {"reviewer_reject": True},
        ])
        self.assertEqual(mixed["faultRounds"], 1)
        self.assertEqual(mixed["reviewerRejectRounds"], 1)
        self.assertIsNone(mixed["reason"])

        record = signed["round0Record"]
        self.assertEqual(record["srcPath"], round0_path)
        self.assertEqual(record["srcSha256"], round0_sha)
        self.assertEqual(record["hostCopyPath"], "")
        critic = {"type": "done", "role": "critic", "status": 200, "round": 1, "usage": {"prompt_tokens": 3_000_000, "completion_tokens": 0, "prompt_tokens_details": {"cached_tokens": 0}}}
        ranking_only = loop_mode.budget_status([critic])
        self.assertTrue(ranking_only["ranking"]["capHit"])
        self.assertEqual(ranking_only["ranking"]["reason"], "no_winner:cap_hit")
        self.assertFalse(ranking_only["readOnlyCapHit"])
        innovator = {"type": "done", "role": "innovator", "status": 200, "round": 1, "usage": {"prompt_tokens": 30_000_000, "completion_tokens": 0, "prompt_tokens_details": {"cached_tokens": 0}}}
        cumulative_only = loop_mode.budget_status([innovator])
        self.assertFalse(cumulative_only["ranking"]["capHit"])
        self.assertTrue(cumulative_only["readOnlyCapHit"])
        for kind in ("attest_mismatch", "reward", "round0Record"):
            stopped = loop_mode.drive([{"anti_forgery": kind}, {}])
            self.assertEqual(stopped["calls"], ["role:1", "real:1"])
            self.assertEqual(stopped["loggedRuns"], [1])
            self.assertEqual(stopped["reason"], "anti_forgery")
            self.assertNotIn("role:2", stopped["calls"])
            self.assertNotIn("real:2", stopped["calls"])

    def test_13_round0_record(self):
        key = b"k" * 32
        seed = b"s" * 32
        tmp = tempfile.TemporaryDirectory()
        root = Path(tmp.name)
        src = root / "trace.jsonl"
        body = b"alpha\nbeta\ngamma\n"
        src.write_bytes(body)
        dest = root / "private" / "round0-trace.jsonl"
        digest = hashlib.sha256(body).hexdigest()
        signed = loop_mode.pre_round1_sign(
            key, seed=seed, ranker={"tools": ["read"]}, critic={"tools": ["read"]},
            round0_path=str(src), round0_sha=digest, round0_src=src, host_copy_path=dest,
        )
        with self.assertRaises(ValueError):
            loop_mode.pre_round1_sign(
                key, seed=seed, ranker={"tools": ["read"]}, critic={"tools": ["read"]},
                round0_path=str(src), round0_sha="ab" * 32, round0_src=src, host_copy_path=dest,
            )
        self.assertTrue(loop_mode.verify_pre_round1(signed, key))
        record = signed["round0Record"]
        self.assertEqual(record["srcSha256"], hashlib.sha256(body).hexdigest())
        self.assertEqual(record["srcPath"], str(src))
        self.assertEqual(Path(record["hostCopyPath"]).read_bytes(), body)
        self.assertEqual(stat.S_IMODE(dest.parent.stat().st_mode), 0o700)
        self.assertNotEqual(record["srcSha256"], "")
        log = root / "relay" / "gap-finder.jsonl"
        run_id = "ab" * 16
        plant.plant_read(log, run_id, record["hostCopyPath"])
        evidence = read_evidence(log, record["hostCopyPath"], record["srcSha256"])
        self.assertTrue(evidence["ok"])
        other = root / "unsigned.jsonl"
        other.write_bytes(body)
        unsigned_log = root / "relay" / "unsigned.jsonl"
        plant.plant_read(unsigned_log, run_id, other)
        missed = read_evidence(unsigned_log, record["hostCopyPath"], record["srcSha256"])
        self.assertFalse(missed["ok"])
        flipped = bytearray(Path(record["hostCopyPath"]).read_bytes())
        flipped[0] ^= 1
        Path(record["hostCopyPath"]).write_bytes(bytes(flipped))
        changed = read_evidence(log, record["hostCopyPath"], record["srcSha256"])
        self.assertEqual(changed["reason"], "file_sha")
        forged = dict(signed)
        forged["round0Record"] = dict(record)
        forged["round0Record"]["srcSha256"] = "0" * 64
        self.assertFalse(loop_mode.verify_pre_round1(forged, key))
        stopped = loop_mode.drive([{"anti_forgery": "round0Record"}, {}])
        self.assertEqual(stopped["reason"], "anti_forgery")
        self.assertEqual(stopped["calls"], ["role:1", "real:1"])
        self.assertNotIn("role:2", stopped["calls"])
        with self.assertRaises(ValueError):
            loop_mode.copy_round0(src, root / "mounted" / "trace.jsonl", mounts=[(str(root), "/in")])
        tmp.cleanup()

    def test_14_reward_signature(self):
        key = b"k" * 32
        tmp = tempfile.TemporaryDirectory()
        root = Path(tmp.name)
        run = root / "run"
        verifier = run / "verifier"
        verifier.mkdir(parents=True)
        (verifier / "reward.txt").write_text("1\n", encoding="utf-8")
        (run / "result.json").write_text(json.dumps({"reward": 1}) + "\n", encoding="utf-8")
        run_id = "ab" * 16
        copied = hooks.copy_checker_before_sign(run, run_id, relay_root=root / "relay")
        dest = Path(copied["dest"])
        self.assertEqual(stat.S_IMODE(dest.stat().st_mode), 0o700)
        log = dest.parent / "relay.jsonl"
        log.write_text(json.dumps({"type": "relay_start", "bootId": "boot-a", "relaySha": "ab" * 32}) + "\n", encoding="utf-8")
        binding = hooks.relay_binding(log)
        sig = hooks.sign_run_record(
            key, dest,
            relay_log_sha=binding["relayLogSha"],
            relay_sha=binding["relaySha"],
            boot_id=binding["bootId"],
            expected_run_id=run_id,
        )
        self.assertEqual(sig["checkerOutputSha"], copied["sha"])
        self.assertEqual(sig["reward"], 1)
        self.assertIn("relayLogSha", sig)
        self.assertTrue(hooks.verify_run_record(sig, dest, 1, key, container_dir=run)["ok"])
        self.assertTrue(hooks.verify_notes_reward("reward: 1\n", sig, dest, key)["ok"])
        (verifier / "reward.txt").write_text("0\n", encoding="utf-8")
        bad_file = hooks.verify_run_record(sig, dest, sig["reward"], key, container_dir=run)
        self.assertEqual(bad_file, {"ok": False, "reason": "attest_mismatch"})
        (verifier / "reward.txt").write_text("1\n", encoding="utf-8")
        (run / "result.json").write_text(json.dumps({"reward": 0}) + "\n", encoding="utf-8")
        bad_result = hooks.verify_run_record(sig, dest, sig["reward"], key, container_dir=run)
        self.assertEqual(bad_result["reason"], "attest_mismatch")
        (run / "result.json").write_text(json.dumps({"reward": 1}) + "\n", encoding="utf-8")
        (dest / "reward.txt").write_text("0\n", encoding="utf-8")
        bad_host = hooks.verify_run_record(sig, dest, sig["reward"], key, container_dir=run)
        self.assertEqual(bad_host["reason"], "attest_mismatch")
        (dest / "reward.txt").write_text("1\n", encoding="utf-8")
        bad_notes = hooks.verify_notes_reward("start: x\nreward: 0\n", sig, dest, key)
        self.assertEqual(bad_notes["reason"], "attest_mismatch")
        self.assertTrue(hooks.verify_run_record(sig, dest, 1, key, container_dir=run)["ok"])
        self.assertTrue(hooks.verify_notes_reward("reward: 1\n", sig, dest, key)["ok"])
        stopped = loop_mode.drive([{"anti_forgery": "reward"}, {}])
        self.assertEqual(stopped["calls"], ["role:1", "real:1"])
        self.assertEqual(stopped["reason"], "anti_forgery")
        self.assertNotIn("role:2", stopped["calls"])
        default = str(hooks.checker_dest(run_id))
        self.assertEqual(default, f"/home/box/.harness-relay/{run_id}/checker")
        with self.assertRaises(ValueError) as rejected:
            hooks.container_argv(
                image="img", run_id=run_id, port=1, network="devii-004-int", env={},
                mounts=[(default, "/checker")], command=["run"],
            )
        self.assertIn("home/box", str(rejected.exception))
        argv = hooks.container_argv(
            image="img", run_id=run_id, port=1, network="devii-004-int", env={},
            mounts=[("/src/config", "/config")], command=["run"],
        )
        blob = "\n".join(argv)
        self.assertNotIn("/home/box", blob)
        self.assertNotIn(default, blob)
        raw = log.read_bytes()
        log.write_bytes(raw + b'{"type":"done","usage":{"prompt_tokens":9}}\n')
        edited = hooks.verify_run_record(sig, dest, 1, key, container_dir=run)
        self.assertEqual(edited, {"ok": False, "reason": "attest_mismatch"})
        log.write_bytes(raw)
        self.assertTrue(hooks.verify_run_record(sig, dest, 1, key, container_dir=run)["ok"])
        with self.assertRaises(ValueError):
            hooks.relay_binding(root / "missing-relay.jsonl")
        with self.assertRaises(ValueError):
            hooks.sign_run_record(key, dest, relay_log_sha="", relay_sha="ab" * 32, boot_id="boot-a", expected_run_id=run_id)
        blank = root / "blank.jsonl"
        blank.write_text(json.dumps({"type": "relay_start", "bootId": "", "relaySha": ""}) + "\n", encoding="utf-8")
        with self.assertRaises(ValueError):
            hooks.relay_binding(blank)
        tmp.cleanup()

    def test_replayed_checker_fails_verify(self):
        import shutil
        key = b"k" * 32
        tmp = tempfile.TemporaryDirectory()
        root = Path(tmp.name)
        run = root / "run"
        (run / "verifier").mkdir(parents=True)
        (run / "verifier" / "reward.txt").write_text("1\n", encoding="utf-8")
        (run / "result.json").write_text(json.dumps({"reward": 1}) + "\n", encoding="utf-8")
        run_a = "ab" * 16
        run_b = "cd" * 16
        copied = hooks.copy_checker_before_sign(run, run_a, relay_root=root / "relay")
        dest_a = Path(copied["dest"])
        log = dest_a.parent / "relay.jsonl"
        log.write_text(json.dumps({"type": "relay_start", "bootId": "boot-a", "relaySha": "ab" * 32}) + "\n", encoding="utf-8")
        binding = hooks.relay_binding(log)
        sig = hooks.sign_run_record(
            key, dest_a,
            relay_log_sha=binding["relayLogSha"],
            relay_sha=binding["relaySha"],
            boot_id=binding["bootId"],
            expected_run_id=run_a,
        )
        self.assertEqual(sig["relayLogSha"], binding["relayLogSha"])
        self.assertEqual(sig["relaySha"], binding["relaySha"])
        self.assertEqual(sig["bootId"], "boot-a")
        self.assertTrue(hooks.verify_run_record(sig, dest_a, 1, key, container_dir=run)["ok"])
        dest_b = root / "relay" / run_b / "checker"
        shutil.copytree(dest_a, dest_b)
        replay = hooks.verify_run_record(sig, dest_b, 1, key, container_dir=run)
        self.assertEqual(replay, {"ok": False, "reason": "attest_mismatch"})
        tmp.cleanup()

    def test_relay_usage_ignores_the_agent_trace(self):
        import devii_docker_v2 as launcher
        root = Path(tempfile.mkdtemp())
        run_id = "ab" * 16
        trace = root / "trace.jsonl"
        trace.write_text(
            json.dumps({"type": "assistant_message", "usage": {"input": 9_000_000, "output": 1, "cacheRead": 0}}) + "\n",
            encoding="utf-8",
        )
        plant.plant_request(
            root / run_id / "relay.jsonl",
            run_id,
            "system",
            usage={"prompt_tokens": 3, "completion_tokens": 1, "prompt_tokens_details": {"cached_tokens": 0}},
        )
        tokens, missing = launcher.relay_usage_tokens(root, run_id)
        self.assertFalse(missing)
        self.assertEqual(tokens, 4)
        self.assertGreater(trace.stat().st_size, 0)
        missing_tokens, missing_flag = launcher.relay_usage_tokens(root, "cd" * 16)
        self.assertEqual(missing_tokens, 0)
        self.assertTrue(missing_flag)
        blank_tokens, blank_flag = launcher.relay_usage_tokens(root, "  ")
        self.assertEqual(blank_tokens, 0)
        self.assertTrue(blank_flag)

    def test_read_only_usage_follows_the_ledger(self):
        usage = {"prompt_tokens": 10_000_000, "completion_tokens": 0, "prompt_tokens_details": {"cached_tokens": 0}}
        events = [
            {"type": "done", "role": "innovator", "status": 200, "usage": usage},
            {"type": "done", "role": "critic", "status": 200, "usage": usage},
            {"type": "done", "role": "ranker", "status": 200, "usage": usage},
            {"type": "done", "role": "executor", "status": 200, "usage": {"prompt_tokens": 10 ** 9, "completion_tokens": 0, "prompt_tokens_details": {"cached_tokens": 0}}},
        ]
        counted = loop_mode.read_only_tokens(events)
        self.assertEqual(counted["tokens"], 30_000_000)
        self.assertFalse(counted["usage_missing"])
        missing_done = loop_mode.read_only_tokens([{"type": "req", "role": "innovator", "seq": 1}])
        self.assertTrue(missing_done["usage_missing"])
        self.assertIsNone(missing_done["tokens"])
        null_usage = loop_mode.call_usage([{"type": "done", "role": "innovator", "status": 200, "usage": None}])
        self.assertTrue(null_usage["usage_missing"])
        self.assertIsNone(null_usage["tokens"])
        self.assertTrue(loop_mode.call_usage([])["usage_missing"])

    def test_pre_round1_rejects_stdin_key(self):
        env = {key: value for key, value in os.environ.items() if key != "HARNESS_ATTEST_KEY_FILE"}
        proc = subprocess.run(
            [sys.executable, str(Path(__file__).with_name("loop_mode.py")), "pre-round1"],
            input=json.dumps({
                "key": "ab" * 32,
                "seed": "cd" * 32,
                "ranker": {"tools": ["read"]},
                "critic": {"tools": ["read"]},
            }),
            text=True,
            capture_output=True,
            env=env,
            cwd=str(Path(__file__).parent),
        )
        self.assertNotEqual(proc.returncode, 0)
        self.assertNotIn("hmacSha256", proc.stdout)

    def test_bind_role_and_exclusion(self):
        run_id = "ab" * 16
        conclusion = {"excluded": []}
        call = {"seq": 1, "runId": run_id, "conclusion": conclusion}
        events = [
            {"type": "req", "seq": 1, "runId": run_id},
            {"type": "done", "seq": 1, "role": "critic", "assistant": json.dumps(conclusion)},
        ]
        self.assertTrue(loop_mode.bind_role_call("critic", call, events, session_text="forged")["ok"])
        self.assertEqual(loop_mode.bind_role_call("ranker", call, [], "session only")["reason"], "missing_relay_record")
        wrong = loop_mode.bind_role_call("reviewer", {"seq": 1, "runId": run_id, "conclusion": {"accept": True, "reason": "x"}}, [
            {"type": "req", "seq": 1, "runId": "cd" * 16},
            {"type": "done", "seq": 1, "assistant": "{\"accept\":true,\"reason\":\"x\"}"},
        ])
        self.assertEqual(wrong["reason"], "wrong_runId")
        mismatch = loop_mode.bind_role_call("critic", call, [
            {"type": "req", "seq": 1, "runId": run_id},
            {"type": "done", "seq": 1, "assistant": "{\"excluded\":[\"c0\"]}"},
        ])
        self.assertEqual(mismatch["reason"], "conclusion_mismatch")
        later = loop_mode.bind_role_call("critic", call, [
            {"type": "req", "seq": 1, "runId": run_id},
            {"type": "done", "seq": 1, "assistant": "{\"excluded\":[\"old\"]}"},
            {"type": "req", "seq": 2, "runId": run_id},
            {"type": "done", "seq": 2, "assistant": "final {\"excluded\":[]}"},
        ])
        self.assertTrue(later["ok"])
        with self.assertRaises(ValueError):
            loop_mode.bind_role_call("gap", call, events)
        one = loop_mode.exclude_and_recompute(
            [{"id": "a", "changedKeys": 2, "configSha": "s"}, {"id": "b", "changedKeys": 1, "configSha": "t"}],
            ["a"],
        )
        self.assertEqual(one["status"], "winner")
        self.assertEqual(one["winner"], "b")
        none = loop_mode.exclude_and_recompute([{"id": "a"}, {"id": "b"}], ["a", "b"])
        self.assertEqual(none, {"status": "no_winner", "reason": "ranker_invalid"})

    def test_checker_copy_and_round0_sha(self):
        root = Path(tempfile.mkdtemp())
        run = root / "run"
        verifier = run / "verifier"
        verifier.mkdir(parents=True)
        (verifier / "reward.txt").write_bytes(b"1\n")
        run_id = "ab" * 16
        copied = hooks.copy_checker_before_sign(run, run_id, relay_root=root / "relay")
        dest = Path(copied["dest"])
        self.assertEqual(dest, root / "relay" / run_id / "checker")
        self.assertEqual((dest / "reward.txt").read_bytes(), b"1\n")
        again = hooks.copy_checker_before_sign(run, run_id, relay_root=root / "relay")
        self.assertEqual(again["sha"], copied["sha"])
        self.assertEqual(str(hooks.checker_dest(run_id)), f"/home/box/.harness-relay/{run_id}/checker")
        self.assertEqual(hooks.DEFAULT_RELAY_ROOT, harness_relay.DEFAULT_LOG_ROOT)
        pinned = hashlib.sha256(b"1\n").hexdigest()
        self.assertEqual(hooks.assert_round0_host_copy(b"1\n", pinned), pinned)
        with self.assertRaises(TypeError):
            hooks.assert_round0_host_copy(b"1\n")
        with self.assertRaises(ValueError) as rejected:
            hooks.assert_round0_host_copy(b"1\n", "ab" * 32)
        self.assertIn("round-0 host copy sha", str(rejected.exception))
        with self.assertRaises(ValueError):
            hooks.assert_round0_host_copy(b"1\n", "")
        (verifier / "reward.txt").write_bytes(b"0\n")
        with self.assertRaises(ValueError):
            hooks.copy_checker_before_sign(run, run_id, relay_root=root / "relay")


class LaunchCase(unittest.TestCase):
    def test_production_launch_uses_container_argv_and_the_host_lock(self):
        import devii_docker_v2 as box
        root = Path(tempfile.mkdtemp())
        run = root / "round"
        run_id = "ab" * 16
        seen = []
        real = hooks.container_argv

        def spy(**kwargs):
            seen.append(kwargs)
            return real(**kwargs)

        hooks.container_argv = spy
        try:
            argv = box.agent_cmd("tasks2/i014", run, "candidate", "devii-name", run_id=run_id, port=9)
        finally:
            hooks.container_argv = real
        self.assertEqual(len(seen), 1)
        self.assertEqual(seen[0]["network"], "devii-004-int")
        sources = [item[0] for item in seen[0]["mounts"]]
        self.assertIn(str(run / "workspace"), sources)
        self.assertIn(str(run / "public"), sources)
        self.assertTrue(any(src.startswith(str(box.CFG)) for src in sources))
        self.assertEqual(str(box.DATA), "/workspace/contest-data/devii")
        self.assertEqual(box.LAKE, box.DATA / "shared" / "data_lake")
        self.assertIn(str(box.LAKE), sources)
        self.assertNotIn(str(box.DATA), sources)
        checker = box.checker_cmd("tasks2/i014", run, "runs/task", "devii-name-chk", run_id="ef" * 16, port=9)
        self.assertIn(f"{box.DATA}/tasks2/i014/tests:/tests:ro", checker)
        checker_blob = "\n".join(checker)
        self.assertNotIn("BASE_URL", checker_blob)
        self.assertNotIn("HARNESS_RUN_ID", checker_blob)
        self.assertEqual(checker[checker.index("--cap-drop") + 1], "NET_RAW")
        self.assertEqual(argv[argv.index("--cap-drop") + 1], "NET_RAW")
        blob = "\n".join(argv)
        self.assertIn("HARNESS_WORKSPACE=/workspace/runs", argv)
        self.assertIn("HARNESS_CANDIDATE_CONFIG=/cfg/candidate.json", argv)
        self.assertIn("OMP_NUM_THREADS=4", argv)
        self.assertIn("OPENBLAS_NUM_THREADS=4", argv)
        self.assertIn(f"BASE_URL=http://10.204.0.1:9/r/{run_id}/v1", argv)
        self.assertEqual([item for item in argv if "API_KEY" in item], [f"API_KEY={hooks.PLACEHOLDER_API_KEY}"])
        self.assertNotIn("API_KEY", checker_blob)
        self.assertNotIn("newapi.ai-modeling.top", blob)
        self.assertNotIn("--add-host", argv)
        self.assertNotIn("/home/box", blob)
        with self.assertRaises(ValueError):
            box.agent_cmd("tasks1/004-dims-pqn-batch-qc", "/home/box/run", "control", "nope", run_id="cd" * 16, port=9)
        with self.assertRaises(RuntimeError):
            box.start_agent_container(
                "tasks2/i014", run, "candidate", "devii-name",
                run_id=run_id, port=9, relay_log_root="", lock_path=root / "missing.lock",
                popen=lambda *args, **kwargs: None,
            )
        lock = root / "one.lock"
        calls = []

        def fake_popen(argv, **kwargs):
            calls.append(list(argv))
            return object()

        proc, fd = box.start_agent_container(
            "tasks2/i014", run, "candidate", "devii-name",
            run_id=run_id, port=9, relay_log_root=str(root / "relay"), lock_path=lock,
            popen=fake_popen, preflight=lambda **_kwargs: None,
        )
        self.assertIsNotNone(proc)
        self.assertEqual(calls[0][calls[0].index("--cap-drop") + 1], "NET_RAW")
        child = subprocess.run([sys.executable, "-c", "\n".join([
            "import sys",
            f"sys.path.insert(0, {str(HERE)!r})",
            "import devii_docker_v2 as box",
            "try:",
            f"    box.one_run_lock({str(lock)!r})",
            "except RuntimeError:",
            "    raise SystemExit(2)",
            "raise SystemExit(0)",
        ])], capture_output=True, text=True)
        self.assertEqual(child.returncode, 2, child.stderr)
        box.release_run_lock(fd)
        released = subprocess.run([sys.executable, "-c", "\n".join([
            "import sys",
            f"sys.path.insert(0, {str(HERE)!r})",
            "import devii_docker_v2 as box",
            f"fd = box.one_run_lock({str(lock)!r})",
            "box.release_run_lock(fd)",
        ])], capture_output=True, text=True)
        self.assertEqual(released.returncode, 0, released.stderr)

    def test_preflight_fails_closed_and_the_result_binds_the_host_run_id(self):
        import devii_docker_v2 as box
        with self.assertRaises(RuntimeError) as missing:
            box.assert_task_network(inspect=lambda _network: False, connect=lambda _host, _port: None)
        self.assertIn("devii-004-int", str(missing.exception))
        seen = []

        def connect(host, port):
            seen.append((host, port))
            raise ConnectionRefusedError("down")

        with self.assertRaises(RuntimeError) as silent:
            box.assert_task_network(port=8642, inspect=lambda network: network == "devii-004-int", connect=connect)
        self.assertEqual(seen, [("10.204.0.1", 8642)])
        self.assertIn("10.204.0.1:8642", str(silent.exception))

        root = Path(tempfile.mkdtemp())
        run = root / "round"
        run_id = "ab" * 16
        popped = []
        real = box.assert_task_network

        def down(**kwargs):
            raise RuntimeError(f"relay is not listening on {kwargs['host']}:{kwargs['port']}")

        box.assert_task_network = down
        try:
            with self.assertRaises(RuntimeError) as blocked:
                box.start_agent_container(
                    "tasks2/i014", run, "candidate", "devii-name",
                    run_id=run_id, port=9, relay_log_root=str(root / "relay"), lock_path=root / "lock",
                    popen=lambda *_args, **_kwargs: popped.append(1),
                )
        finally:
            box.assert_task_network = real
        self.assertIn("10.204.0.1:9", str(blocked.exception))
        self.assertEqual(popped, [])

        verifier = run / "verifier"
        verifier.mkdir(parents=True)
        (verifier / "reward.txt").write_bytes(b"1\n")
        relay = root / "relay"
        recorded = box.finalize_launch(run, run_id, str(relay), {"task": "tasks2/i014", "checker_exit": 0})
        written = json.loads((run / "result.json").read_text())
        self.assertEqual(written["runId"], run_id)
        self.assertEqual(written["relay_id"], run_id)
        self.assertEqual(recorded["checkerDest"], str(relay / run_id / "checker"))
        self.assertEqual((relay / run_id / "checker" / "reward.txt").read_bytes(), b"1\n")
        skipped = box.finalize_launch(run, run_id, str(relay), {"task": "tasks2/i014", "checker_exit": "skipped_token_cap"})
        self.assertEqual(skipped["runId"], run_id)
        self.assertNotIn("checkerDest", skipped)


class EwiTableCase(unittest.TestCase):
    def test_diff_table_is_deterministic(self):
        rows = []
        rows.append(("early-write-idle", 700.0, _old_idle(0, 700, ""), ewi_relay.ewi_relay_v1(t_first=0, t_last_write=0, response_ends=[], t_end=700, timed_out=False)))
        rows.append(("early-write-late-rewrite", 50.0, _old_idle(650, 700, ""), ewi_relay.ewi_relay_v1(t_first=0, t_last_write=650, response_ends=[], t_end=700, timed_out=False)))
        rows.append(("write-delete-rewrite", 300.0, _old_idle(400, 700, ""), ewi_relay.ewi_relay_v1(t_first=0, t_last_write=400, response_ends=[], t_end=700, timed_out=False)))
        rows.append(("long-generation", 50.0, _old_idle(0, 700, '{"type":"assistant_message","ts":650000}\n'), ewi_relay.ewi_relay_v1(t_first=0, response_ends=[650], t_end=700, timed_out=False)))
        rows.append(("timeout-continuous", 100.0, _old_idle(0, 700, "".join(f'{{"type":"assistant_message","ts":{t}}}\n' for t in (100000, 200000, 300000, 400000, 500000, 600000)), timed_out=True), ewi_relay.ewi_relay_v1(t_first=0, response_ends=[100, 200, 300, 400, 500, 600], t_end=700, timed_out=True)))
        nan = ewi_relay.ewi_relay_v1(t_first=float("nan"), response_ends=[], t_end=700, timed_out=False)
        self.assertEqual(nan["verdict"], "EWI不可判")
        self.assertIsNone(nan["ewi"])
        old_nan = _old_idle(0, 700, '{"type":"assistant_message","ts":NaN}\n', expect_error=True)
        lines = ["# EWI-relay-v1 vs ewi_idle.py", "", "| case | old idle | relay idle | relay verdict |", "| --- | --- | --- | --- |"]
        for name, _expected, old, new in rows:
            idle = new["idle"]
            lines.append(f"| {name} | {old} | {idle} | {new['verdict']} |")
            if name == "early-write-idle":
                self.assertEqual(old, 700.0)
                self.assertEqual(idle, 700)
            if name == "early-write-late-rewrite":
                self.assertEqual(old, 50.0)
                self.assertEqual(idle, 700)
            if name == "long-generation":
                self.assertGreater(650, 0)
                self.assertEqual(idle, 50)
        lines.append(f"| nan-ts | {old_nan} |  | EWI不可判 |")
        lines.append("")
        text = "\n".join(lines)
        DIFF_TABLE.write_text(text, encoding="utf-8")
        self.assertGreaterEqual(text.count("\n| "), 6)
        self.assertIn("EWI不可判", text)
        self.assertEqual(DIFF_TABLE.read_text(encoding="utf-8"), text)
        again = ewi_relay.ewi_relay_v1(t_first=True, response_ends=[], t_end=1, timed_out=False)
        self.assertNotEqual(again["verdict"], False)


class NullScoreCase(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.verifier = self.root / "verifier"
        self.checker = self.root / "relay" / ("ab" * 16) / "checker"
        self.verifier.mkdir(parents=True)
        self.reason = "gold labels missing for the hidden split"

    def tearDown(self):
        self.tmp.cleanup()

    def _write_scorer(self, payload):
        (self.verifier / ".scorer-result.json").write_text(json.dumps(payload), encoding="utf-8")

    def test_null_score_is_copied_before_unlink_and_stays_unscored(self):
        payload = {"total_score": None, "reward": None, "reason": self.reason}
        self._write_scorer(payload)
        (self.verifier / "reward.txt").write_text("0.000000\n", encoding="utf-8")
        (self.verifier / "breakdown.json").write_text(json.dumps({
            "total_score": 0.0,
            "reward": 0.0,
            "issues": ["checker_exception: ValueError: private evaluator returned non-finite score"],
        }), encoding="utf-8")
        self.assertTrue(hooks.preserve_scorer_result(self.verifier, self.checker))
        source = self.verifier / ".scorer-result.json"
        source.unlink()
        self.assertFalse(source.exists())
        self.assertTrue(self.verifier.is_dir())
        copied = json.loads((self.checker / ".scorer-result.json").read_text(encoding="utf-8"))
        self.assertEqual(copied["reason"], self.reason)
        stable = json.loads((self.verifier / "scorer-result.json").read_text(encoding="utf-8"))
        self.assertEqual(stable, payload)
        row = hooks.apply_score_accounting(
            {"checker_exit": 0, "reward": "0.000000"},
            self.verifier,
            self.checker,
        )
        self.assertEqual(row["score_status"], "unscored")
        self.assertEqual(row["unscored_reason"], self.reason)
        self.assertIsNone(row["reward"])
        self.assertEqual(row["anomaly"], self.reason)
        self.assertEqual(row["checker_exit"], 0)

    def test_watch_copies_the_scorer_file_before_it_is_deleted(self):
        import time
        payload = {"total_score": None, "reward": None, "reason": self.reason}
        with hooks.ScorerWatch(self.verifier, self.checker):
            self._write_scorer(payload)
            copied = self.checker / ".scorer-result.json"
            for _ in range(50):
                if copied.is_file():
                    break
                time.sleep(0.02)
            self.assertTrue(copied.is_file())
            (self.verifier / ".scorer-result.json").unlink()
        self.assertFalse((self.verifier / ".scorer-result.json").exists())
        self.assertEqual(json.loads(copied.read_text(encoding="utf-8"))["reason"], self.reason)
        noted = hooks.null_score_status(self.verifier, self.checker)
        self.assertTrue(noted["nullScore"])
        self.assertEqual(noted["unscored_reason"], self.reason)

    def test_finite_zero_stays_scored_and_a_bare_non_finite_issue_is_unscored(self):
        self._write_scorer({"total_score": 0, "reward": 0.0, "reason": "public contract failed"})
        hooks.preserve_scorer_result(self.verifier, self.checker)
        row = hooks.apply_score_accounting({"checker_exit": 0, "reward": "0.000000"}, self.verifier, self.checker)
        self.assertNotIn("score_status", row)
        self.assertEqual(row["reward"], "0.000000")
        self.assertFalse(hooks.null_score_status(self.verifier, self.checker)["nullScore"])

        bare = self.root / "bare"
        bare.mkdir()
        (bare / "reward.txt").write_text("0.000000\n", encoding="utf-8")
        (bare / "breakdown.json").write_text(json.dumps({
            "total_score": 0.0,
            "reward": 0.0,
            "issues": ["checker_exception: ValueError: private evaluator returned non-finite score"],
        }), encoding="utf-8")
        noted = hooks.null_score_status(bare, self.root / "missing-checker")
        self.assertTrue(noted["nullScore"])
        self.assertIn("non-finite", noted["unscored_reason"])
        accounted = hooks.apply_score_accounting({"checker_exit": 0, "reward": "0.000000"}, bare, self.root / "missing-checker")
        self.assertEqual(accounted["score_status"], "unscored")
        self.assertIsNone(accounted["reward"])


class OnceCase(unittest.TestCase):
    def setUp(self):
        import devii_docker_v2 as box
        self.box = box
        self.root = Path(tempfile.mkdtemp())
        self.harness = self.root / "harness.mjs"
        self.harness.write_text("export const harness = 1;\n")
        self.config = self.root / "control.json"
        self.config.write_text('{"parts":{"agent-loop":{"maxSteps":25}}}\n')
        self.key = self.root / "attest.key"
        write_key(self.key, b"a" * 32)
        self.up = self.root / "upstream.key"
        write_key(self.up, b"b" * 32)
        self._old_attest = os.environ.get("HARNESS_ATTEST_KEY_FILE")
        self._old_up = os.environ.get("RELAY_UPSTREAM_KEY_FILE")
        os.environ["HARNESS_ATTEST_KEY_FILE"] = str(self.key)
        os.environ["RELAY_UPSTREAM_KEY_FILE"] = str(self.up)
        self._old_sha = box.HARNESS_SHA

    def tearDown(self):
        self.box.HARNESS_SHA = self._old_sha
        if self._old_attest is None:
            os.environ.pop("HARNESS_ATTEST_KEY_FILE", None)
        else:
            os.environ["HARNESS_ATTEST_KEY_FILE"] = self._old_attest
        if self._old_up is None:
            os.environ.pop("RELAY_UPSTREAM_KEY_FILE", None)
        else:
            os.environ["RELAY_UPSTREAM_KEY_FILE"] = self._old_up

    def test_wrong_harness_sha_refuses_before_docker(self):
        seen = []

        def popen(*args, **kwargs):
            seen.append(args)

        with self.assertRaises(self.box.OnceError) as caught:
            self.box.once_from_flags([
                "--task", "hb003", "--seed", "9", "--arm", "control",
                "--config", str(self.config), "--run-dir", str(self.root / "run"),
                "--harness", str(self.harness),
            ], popen=popen, preflight=lambda **_kwargs: None, stage=lambda *_args: None, limits_of=lambda _task: {"agent_timeout_sec": 30, "verifier_timeout_sec": 30})
        self.assertIn("harness", str(caught.exception))
        self.assertEqual(seen, [])
        with self.assertRaises(self.box.OnceError) as arm:
            self.box.run_once("hb003", 9, "treatment", self.config, self.root / "other", self.harness, popen=popen)
        self.assertIn("arm", str(arm.exception))
        self.assertEqual(seen, [])

    def _relay(self):
        return Relay(
            port=8642, log_root=self.root / "relay", upstream_key_file=str(self.up), attest_key_file=str(self.key),
            bind_host="127.0.0.1", plant_enabled=True,
        )

    def _run(self, relay, run, checker, extra=(), run_id="ab" * 16, docker=None):
        self.box.HARNESS_SHA = hashlib.sha256(self.harness.read_bytes()).hexdigest()
        seen = []

        class Proc:
            def wait(self, timeout=None):
                return 0

            def kill(self):
                return None

        def popen(argv, **kwargs):
            seen.append(list(argv))
            (run / "workspace" / "runs" / "task-stub").mkdir(parents=True, exist_ok=True)
            relay.record(run_id, {"type": "req", "seq": 1, "runId": run_id})
            relay.record(run_id, {"type": "done", "status": 200, "usage": dict(USAGE)})
            return Proc()

        attest = self.root / "attest" / run.name
        recorded = self.box.once_from_flags([
            "--task", "hb003", "--seed", "9", "--arm", "control",
            "--config", str(self.config), "--run-dir", str(run), "--harness", str(self.harness),
            "--run-id", run_id, "--nonce", "cd" * 16, "--attest-dir", str(attest),
            *extra,
        ], popen=popen, call=checker, preflight=lambda **_kwargs: None,
           stage=lambda _task, dst: Path(dst).mkdir(parents=True, exist_ok=True),
           limits_of=lambda _task: {"agent_timeout_sec": 3600, "verifier_timeout_sec": 60, "allow_internet": True},
           relay=relay, listen=False, lock_path=self.root / f"{run.name}.lock", docker=docker)
        return recorded, seen, run_id, attest

    def _assert_argv(self, argv, run_id):
        blob = "\n".join(argv)
        self.assertEqual(argv[:4], ["sudo", "-E", "docker", "run"])
        self.assertIn("--network", argv)
        self.assertEqual(argv[argv.index("--network") + 1], "devii-004-int")
        self.assertEqual(argv[argv.index("--cap-drop") + 1], "NET_RAW")
        self.assertIn(f"BASE_URL=http://10.204.0.1:8642/r/{run_id}/v1", argv)
        self.assertEqual([item for item in argv if "API_KEY" in item], [f"API_KEY={hooks.PLACEHOLDER_API_KEY}"])
        self.assertIn(f"{self.harness}:/opt/harness/src/harness.mjs:ro", argv)
        self.assertIn(f"{self.config}:/cfg/candidate.json:ro", argv)

    def _verify(self, attest, run, run_id):
        import shutil
        bun = shutil.which("bun")
        self.assertTrue(bun, "bun")
        code = "\n".join([
            'import { readFileSync } from "node:fs";',
            'import { verifyHostAttestation } from "./harness-opt/src/modules/attestation.ts";',
            "const result = verifyHostAttestation({",
            "  attestDir: process.env.ATTEST,",
            "  key: readFileSync(process.env.KEY),",
            "  configPath: process.env.CONFIG,",
            "  harnessPath: process.env.HARNESS,",
            "  runDir: process.env.RUN,",
            "  runId: process.env.RUN_ID,",
            "  expectedNonce: process.env.NONCE,",
            "});",
            "process.stdout.write(JSON.stringify(result));",
        ])
        env = os.environ.copy()
        env.update({
            "ATTEST": str(attest), "KEY": str(self.key), "CONFIG": str(self.config),
            "HARNESS": str(self.harness), "RUN": str(run), "RUN_ID": run_id, "NONCE": "cd" * 16,
        })
        proc = subprocess.run([bun, "-e", code], cwd=str(HERE.parent.parent), capture_output=True, text=True, env=env)
        self.assertEqual(proc.returncode, 0, proc.stderr or proc.stdout)
        return json.loads(proc.stdout)

    def test_once_launches_through_container_argv_and_signs_relay_usage(self):
        relay = self._relay()
        run = self.root / "scored"

        class Done:
            returncode = 0

        def checker(argv, **kwargs):
            (run / "verifier").mkdir(parents=True, exist_ok=True)
            (run / "verifier" / "reward.txt").write_text("1\n")
            return Done()

        recorded, seen, run_id, attest = self._run(relay, run, checker)
        self.assertEqual(len(seen), 1)
        self._assert_argv(seen[0], run_id)
        self.assertEqual(recorded["task"], "tasks3/hb003")
        self.assertEqual(recorded["seed"], 9)
        self.assertEqual(recorded["arm"], "control")
        self.assertEqual(recorded["mountedHarnessSha"], hashlib.sha256(self.harness.read_bytes()).hexdigest())
        self.assertEqual(recorded["score_status"], "scored")
        self.assertEqual(recorded["reward"], 1)
        self.assertEqual(recorded["tokens"], 12)
        signed = json.loads((self.root / "relay" / run_id / "run-record.json").read_text())
        for field in ("checkerOutputSha", "reward", "relayLogSha", "relaySha", "bootId"):
            self.assertIn(field, signed)
        self.assertEqual(signed["reward"], 1)
        self.assertEqual(signed["relaySha"], relay.relay_sha)
        self.assertEqual(signed["bootId"], relay.boot_id)
        self.assertTrue(signed["relayLogSha"])
        verified = self._verify(attest, run, run_id)
        self.assertTrue(verified["ok"], verified)
        self.assertEqual(verified["reward"], 1)
        self.assertEqual(verified["mountedHarnessSha"], recorded["mountedHarnessSha"])

    def test_null_score_stays_unscored_and_keeps_the_reason(self):
        relay = self._relay()
        run = self.root / "null"

        class Done:
            returncode = 0

        def checker(argv, **kwargs):
            (run / "verifier").mkdir(parents=True, exist_ok=True)
            (run / "verifier" / ".scorer-result.json").write_text(json.dumps({"total_score": None, "reason": "gold labels missing"}) + "\n")
            (run / "verifier" / "reward.txt").write_text("0\n")
            return Done()

        recorded, seen, run_id, attest = self._run(relay, run, checker)
        self.assertEqual(len(seen), 1)
        self._assert_argv(seen[0], run_id)
        self.assertEqual(recorded["score_status"], "unscored")
        self.assertIsNone(recorded["reward"])
        self.assertEqual(recorded["unscored_reason"], "gold labels missing")
        self.assertEqual(recorded["mountedHarnessSha"], hashlib.sha256(self.harness.read_bytes()).hexdigest())
        self.assertFalse((self.root / "relay" / run_id / "run-record.json").exists())
        copied = json.loads((self.root / "relay" / run_id / "checker" / ".scorer-result.json").read_text())
        self.assertEqual(copied["reason"], "gold labels missing")
        self.assertIsNone(copied["total_score"])
        verified = self._verify(attest, run, run_id)
        self.assertTrue(verified["ok"], verified)
        self.assertIsNone(verified["reward"])

    def test_seed9_reconcile_uses_the_configured_task(self):
        relay = self._relay()
        run = self.root / "recon"

        class Done:
            returncode = 0

        def checker(argv, **kwargs):
            (run / "verifier").mkdir(parents=True, exist_ok=True)
            (run / "verifier" / "reward.txt").write_text("1\n")
            return Done()

        recorded, _seen, _run_id, _attest = self._run(relay, run, checker, extra=("--reconcile", "--expected-task", "hb003"))
        self.assertEqual(recorded["purpose"], "reconcile")
        self.assertTrue(recorded["reconcile"]["exclude"])
        self.assertEqual(recorded["score_status"], "scored")
        self.assertEqual(recorded["reward"], 1)
        run2 = self.root / "recon-again"

        def checker2(argv, **kwargs):
            (run2 / "verifier").mkdir(parents=True, exist_ok=True)
            (run2 / "verifier" / "reward.txt").write_text("1\n")
            return Done()

        again, _seen2, _id2, _attest2 = self._run(relay, run2, checker2, extra=("--reconcile", "--expected-task", "hb003"), run_id="cd" * 16)
        self.assertFalse(again["reconcile"]["accepted"])
        self.assertNotIn("purpose", again)
        mismatch = self.root / "recon-other"

        def checker3(argv, **kwargs):
            (mismatch / "verifier").mkdir(parents=True, exist_ok=True)
            (mismatch / "verifier" / "reward.txt").write_text("1\n")
            return Done()

        other, _seen3, _id3, _attest3 = self._run(
            relay, mismatch, checker3, extra=("--reconcile", "--expected-task", "i014"), run_id="ef" * 16,
        )
        self.assertFalse(other["reconcile"]["accepted"])
        self.assertEqual(other["score_status"], "scored")
        with self.assertRaises(self.box.OnceError) as missing_expected:
            self.box.once_from_flags([
                "--task", "hb003", "--seed", "9", "--arm", "control", "--reconcile",
                "--config", str(self.config), "--run-dir", str(self.root / "no-expected"),
                "--harness", str(self.harness),
            ], popen=lambda *args, **kwargs: (_ for _ in ()).throw(AssertionError("docker")), preflight=lambda **_kwargs: None)
        self.assertIn("expected task", str(missing_expected.exception))

    def test_standalone_close_fault_is_unscored_and_unsigned(self):
        class Done:
            returncode = 0

        mismatch_relay = self._relay()
        mismatch = self.root / "mismatch"
        mismatch_id = "ab" * 16

        def tamper(argv, **kwargs):
            (mismatch / "verifier").mkdir(parents=True, exist_ok=True)
            (mismatch / "verifier" / "reward.txt").write_text("1\n")
            with (self.root / "relay" / mismatch_id / "relay.jsonl").open("ab") as handle:
                handle.write(b"tamper\n")
            return Done()

        recorded, _seen, run_id, _attest = self._run(mismatch_relay, mismatch, tamper, run_id=mismatch_id)
        self.assertEqual(recorded["unscored_reason"], "attest_mismatch")
        self.assertEqual(recorded["score_status"], "unscored")
        self.assertIsNone(recorded["reward"])
        self.assertEqual(recorded["tokens"], 12)
        self.assertFalse((self.root / "relay" / run_id / "run-record.json").exists())
        self.assertNotIn("purpose", recorded)

        missing_root = self.root / "relay-missing"
        missing_relay = Relay(
            port=8642, log_root=missing_root, upstream_key_file=str(self.up), attest_key_file=str(self.key),
            bind_host="127.0.0.1", plant_enabled=True,
        )
        missing = self.root / "missing-log"
        missing_id = "ef" * 16

        def drop_log(argv, **kwargs):
            (missing / "verifier").mkdir(parents=True, exist_ok=True)
            (missing / "verifier" / "reward.txt").write_text("1\n")
            (missing_root / missing_id / "relay.jsonl").unlink(missing_ok=True)
            return Done()

        # The helper always reads self.root / "relay". Drive this case through run_once directly.
        self.box.HARNESS_SHA = hashlib.sha256(self.harness.read_bytes()).hexdigest()
        seen = []

        class Proc:
            def wait(self, timeout=None):
                return 0

            def kill(self):
                return None

        def popen(argv, **kwargs):
            seen.append(list(argv))
            (missing / "workspace" / "runs" / "task-stub").mkdir(parents=True, exist_ok=True)
            missing_relay.record(missing_id, {"type": "done", "status": 200, "usage": dict(USAGE)})
            return Proc()

        dropped = self.box.once_from_flags([
            "--task", "hb003", "--seed", "9", "--arm", "control",
            "--config", str(self.config), "--run-dir", str(missing), "--harness", str(self.harness),
            "--run-id", missing_id,
        ], popen=popen, call=drop_log, preflight=lambda **_kwargs: None,
           stage=lambda _task, dst: Path(dst).mkdir(parents=True, exist_ok=True),
           limits_of=lambda _task: {"agent_timeout_sec": 3600, "verifier_timeout_sec": 60, "allow_internet": True},
           relay=missing_relay, listen=False, lock_path=self.root / "missing.lock")
        self.assertEqual(dropped["unscored_reason"], "usage_missing")
        self.assertEqual(dropped["score_status"], "unscored")
        self.assertIsNone(dropped["reward"])
        self.assertEqual(dropped["tokens"], 12)
        self.assertFalse((missing_root / missing_id / "run-record.json").exists())
        self.assertEqual(len(seen), 1)

    def test_empty_run_is_unscored_and_not_reconciled(self):
        relay = self._relay()
        run = self.root / "empty"
        self.box.HARNESS_SHA = hashlib.sha256(self.harness.read_bytes()).hexdigest()

        class Proc:
            def wait(self, timeout=None):
                return 2

            def kill(self):
                return None

        def popen(argv, **kwargs):
            return Proc()

        recorded = self.box.once_from_flags([
            "--task", "hb003", "--seed", "9", "--arm", "control", "--reconcile",
            "--expected-task", "hb003",
            "--config", str(self.config), "--run-dir", str(run), "--harness", str(self.harness),
            "--run-id", "ab" * 16,
        ], popen=popen, preflight=lambda **_kwargs: None,
           stage=lambda _task, dst: Path(dst).mkdir(parents=True, exist_ok=True),
           limits_of=lambda _task: {"agent_timeout_sec": 3600, "verifier_timeout_sec": 60, "allow_internet": True},
           relay=relay, listen=False, lock_path=self.root / "empty.lock")
        self.assertEqual(recorded["exit"], 2)
        self.assertEqual(recorded["unscored_reason"], "no_requests")
        self.assertEqual(recorded["score_status"], "unscored")
        self.assertIsNone(recorded["reward"])
        self.assertFalse(recorded["reconcile"]["accepted"])
        self.assertNotIn("purpose", recorded)
        self.assertFalse((self.root / "relay" / ("ab" * 16) / "run-record.json").exists())
        self.assertEqual(recorded["tokens"], 0)

    def test_once_removes_an_orphan_container_before_the_agent_starts(self):
        relay = self._relay()
        run = self.root / "orphan"
        cid = "ab" * 32
        name = "devii-once-hb003-9-control"
        order = []

        class Done:
            returncode = 0

        def checker(argv, **kwargs):
            (run / "verifier").mkdir(parents=True, exist_ok=True)
            (run / "verifier" / "reward.txt").write_text("1\n")
            return Done()

        def docker(argv, **kwargs):
            order.append(list(argv))
            class Found:
                returncode = 0
                stdout = cid + "\n"
            class Ok:
                returncode = 0
                stdout = ""
            return Found() if argv[3:4] == ["inspect"] else Ok()

        recorded, seen, run_id, _attest = self._run(relay, run, checker, docker=docker)
        self.assertEqual([item[3] for item in order], ["inspect", "kill", "rm"])
        self.assertEqual(order[0][:3], ["sudo", "-E", "docker"])
        self.assertEqual(order[0][-1], name)
        self.assertEqual(order[1], ["sudo", "-E", "docker", "kill", name])
        self.assertEqual(order[2], ["sudo", "-E", "docker", "rm", "-f", name])
        self.assertEqual(seen[0][:4], ["sudo", "-E", "docker", "run"])
        self.assertIn(name, seen[0])
        log = (run / "devii_one.log").read_text(encoding="utf-8")
        self.assertIn(f"cleaned orphan container name={name} id={cid}", log)
        self.assertEqual(recorded["score_status"], "scored")
        self.assertEqual(recorded["reward"], 1)
        self.assertNotIn("relayFault", recorded)
        self.assertNotEqual(recorded.get("unscored_reason"), "agent_failed")

        absent = self.root / "no-orphan"
        absent_order = []

        def checker_absent(argv, **kwargs):
            (absent / "verifier").mkdir(parents=True, exist_ok=True)
            (absent / "verifier" / "reward.txt").write_text("1\n")
            return Done()

        def docker_missing(argv, **kwargs):
            absent_order.append(list(argv))
            class Missing:
                returncode = 1
                stdout = ""
            return Missing()

        quiet, seen_absent, _id, _attest2 = self._run(
            relay, absent, checker_absent, run_id="12" * 16, docker=docker_missing,
        )
        self.assertEqual([item[3] for item in absent_order], ["inspect"])
        self.assertNotIn("cleaned orphan", (absent / "devii_one.log").read_text(encoding="utf-8"))
        self.assertEqual(seen_absent[0][:4], ["sudo", "-E", "docker", "run"])
        self.assertEqual(quiet["score_status"], "scored")
        self.assertEqual(quiet["reward"], 1)

    def test_once_copies_the_task_tree_and_attest_reads_the_copy(self):
        relay = self._relay()
        run = self.root / "copy"
        self.box.HARNESS_SHA = hashlib.sha256(self.harness.read_bytes()).hexdigest()
        run_id = "ab" * 16
        planted = {}
        copy_argvs = []

        class Proc:
            def wait(self, timeout=None):
                return 0

            def kill(self):
                return None

        class Done:
            returncode = 0

        def popen(argv, **kwargs):
            task = run / "workspace" / "runs" / "task-plant"
            (task / "outputs").mkdir(parents=True)
            (task / ".pi-sessions").mkdir()
            (task / "trace.jsonl").write_text('{"type":"run_start","candidateConfigHash":"copy"}\n')
            (task / "outputs" / "out.txt").write_text("output\n")
            (task / ".pi-sessions" / "s.jsonl").write_text("session\n")
            (run / "trace.jsonl").write_text("decoy-trace\n")
            (run / ".pi-sessions").mkdir(parents=True, exist_ok=True)
            (run / ".pi-sessions" / "decoy.jsonl").write_text("decoy-session\n")
            for path in task.rglob("*"):
                if path.is_file() and not path.is_symlink():
                    planted[path] = (path.read_bytes(), path.stat().st_mtime_ns)
            relay.record(run_id, {"type": "req", "seq": 1, "runId": run_id})
            relay.record(run_id, {"type": "done", "status": 200, "usage": dict(USAGE)})
            return Proc()

        def call(argv, **kwargs):
            text = "\n".join(argv) if isinstance(argv, (list, tuple)) else ""
            if "cp -a " not in text:
                (run / "verifier").mkdir(parents=True, exist_ok=True)
                (run / "verifier" / "reward.txt").write_text("1\n")
                return Done()
            copy_argvs.append(list(argv))
            volumes = [argv[index + 1] for index, item in enumerate(argv) if item == "-v"]
            src_mount = next(item for item in volumes if item.endswith(":/src:ro"))
            dst_mount = next(item for item in volumes if item.endswith(":/dst"))
            host_src = Path(src_mount[: -len(":/src:ro")])
            host_dst = Path(dst_mount[: -len(":/dst")])
            script = next(item for item in argv if item.startswith("cp -a "))
            inner = script.split(" ", 2)[2].split("/. ", 1)[0]
            if len(inner) >= 2 and inner[0] == inner[-1] == "'":
                inner = inner[1:-1]
            origin = host_src / inner[len("/src/"):]
            for path in origin.rglob("*"):
                if path.is_symlink() or not path.is_file():
                    continue
                target = host_dst / path.relative_to(origin)
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_bytes(path.read_bytes())
            return Done()

        attest = self.root / "copy-attest"
        recorded = self.box.once_from_flags([
            "--task", "hb003", "--seed", "9", "--arm", "control",
            "--config", str(self.config), "--run-dir", str(run), "--harness", str(self.harness),
            "--run-id", run_id, "--nonce", "cd" * 16, "--attest-dir", str(attest),
        ], popen=popen, call=call, preflight=lambda **_kwargs: None,
           stage=lambda _task, dst: Path(dst).mkdir(parents=True, exist_ok=True),
           limits_of=lambda _task: {"agent_timeout_sec": 3600, "verifier_timeout_sec": 60, "allow_internet": True},
           relay=relay, listen=False, lock_path=self.root / "copy.lock")
        self.assertEqual(len(copy_argvs), 1)
        argv = copy_argvs[0]
        blob = "\n".join(argv)
        self.assertEqual(argv[:4], ["sudo", "-E", "docker", "run"])
        self.assertEqual(argv[argv.index("--network") + 1], "devii-004-int")
        self.assertEqual(argv[argv.index("--cap-drop") + 1], "NET_RAW")
        self.assertNotIn("BASE_URL", blob)
        self.assertNotIn("API_KEY", blob)
        self.assertIn(f"COPY_UID={os.getuid()}", argv)
        self.assertIn(f"COPY_GID={os.getgid()}", argv)
        self.assertIn(f"{run / 'workspace'}:/src:ro", argv)
        self.assertIn(f"{run / 'task-copy'}:/dst", argv)
        self.assertIn("chown -R", blob)
        task = run / "workspace" / "runs" / "task-plant"
        for path, (body, mtime) in planted.items():
            self.assertEqual(path.read_bytes(), body)
            self.assertEqual(path.stat().st_mtime_ns, mtime)
        copied = run / "task-copy"
        self.assertEqual((copied / "trace.jsonl").read_bytes(), (task / "trace.jsonl").read_bytes())
        self.assertEqual((copied / "outputs" / "out.txt").read_bytes(), b"output\n")
        self.assertEqual((copied / ".pi-sessions" / "s.jsonl").read_bytes(), b"session\n")
        self.assertEqual(recorded["taskCopyDir"], "task-copy")
        self.assertEqual(recorded["taskCopySha"], self.box._task_copy_sha(task))
        self.assertEqual(recorded["taskCopySha"], self.box._task_copy_sha(copied))
        disk = json.loads((run / "result.json").read_text())
        self.assertEqual(disk["taskCopySha"], recorded["taskCopySha"])
        self.assertEqual(recorded["score_status"], "scored")
        self.assertEqual(recorded["reward"], 1)
        verified = self._verify(attest, run, run_id)
        self.assertTrue(verified["ok"], verified)
        self.assertTrue(str(verified["tracePath"]).endswith("/task-copy/trace.jsonl"))
        self.assertEqual(verified["traceSha"], hashlib.sha256((copied / "trace.jsonl").read_bytes()).hexdigest())
        self.assertNotEqual(verified["traceSha"], hashlib.sha256((run / "trace.jsonl").read_bytes()).hexdigest())
        self.assertTrue(all("/task-copy/.pi-sessions/" in item for item in verified["sessionFiles"]))
        self.assertNotIn("decoy.jsonl", verified["piSessionShas"])

    def test_attest_unreadable_dir_fails_closed(self):
        import contextlib
        import io
        run = self.root / "locked"
        run.mkdir()
        (run / ".pi-sessions").mkdir()
        (run / "result.json").write_text(json.dumps({
            "arm": "control", "seed": 9, "runId": "ab" * 16, "score_status": "unscored",
            "reward": None, "tokens": 0, "exit": 0, "task": "tasks3/hb003",
        }))
        original = os.walk

        def boom(*args, **kwargs):
            raise PermissionError(13, "Permission denied", str(run / ".pi-sessions"))

        os.walk = boom
        try:
            with self.assertRaises(self.box.OnceError) as caught:
                self.box.attest_from_run(run, self.harness, self.config, self.root / "locked-attest")
            self.assertIn("attest cannot read", str(caught.exception))
            self.assertNotIn("PermissionError", str(caught.exception))
            self.assertNotIn("Traceback", str(caught.exception))
            stderr = io.StringIO()
            argv = sys.argv
            sys.argv = [
                "devii_docker_v2.py", "attest",
                "--run-dir", str(run), "--harness", str(self.harness), "--config", str(self.config),
                "--attest-dir", str(self.root / "locked-attest-cli"),
            ]
            try:
                with contextlib.redirect_stderr(stderr):
                    with self.assertRaises(SystemExit) as exited:
                        self.box.main()
            finally:
                sys.argv = argv
            self.assertEqual(exited.exception.code, 1)
            text = stderr.getvalue()
            self.assertIn("attest cannot read", text)
            self.assertNotIn("PermissionError", text)
            self.assertNotIn("Traceback", text)
        finally:
            os.walk = original

    def test_once_relay_upstream_is_the_network_upstream(self):
        self.box.HARNESS_SHA = hashlib.sha256(self.harness.read_bytes()).hexdigest()
        seen = {}
        real = self.box._standalone_relay

        def wrap(root, port):
            relay = real(root, port)
            seen["relay"] = relay
            return relay

        self.box._standalone_relay = wrap
        run = self.root / "net-once"
        run_id = "cd" * 16

        class Proc:
            def wait(self, timeout=None):
                return 0

            def kill(self):
                return None

        try:
            recorded = self.box.run_once(
                "hb003", 9, "control", self.config, run, self.harness,
                run_id=run_id, relay_root=self.root / "net-relay", listen=False,
                popen=lambda argv, **kwargs: Proc(), call=lambda *args, **kwargs: Proc(),
                preflight=lambda **_kwargs: None,
                stage=lambda _task, dst: Path(dst).mkdir(parents=True, exist_ok=True),
                limits_of=lambda _task: {"agent_timeout_sec": 3600, "verifier_timeout_sec": 60, "allow_internet": True},
                lock_path=self.root / "net-once.lock",
            )
        finally:
            self.box._standalone_relay = real
        relay = seen["relay"]
        self.assertEqual(relay.upstream_url, harness_relay.UPSTREAM_URL)
        self.assertIsNot(relay.upstream, harness_relay._default_upstream)
        self.assertTrue(harness_relay._is_production_upstream(relay.upstream))
        assert_network_post(self, relay, harness_relay.UPSTREAM_URL)
        self.assertEqual(recorded["unscored_reason"], "no_requests")
        self.assertFalse((self.root / "net-relay" / "reject.jsonl").exists())


@unittest.skipUnless(
    os.environ.get("RELAY_LIVE_SMOKE") == "1" and bool(os.environ.get("RELAY_UPSTREAM_KEY_FILE")),
    "set RELAY_LIVE_SMOKE=1 and RELAY_UPSTREAM_KEY_FILE to POST one chat through the relay",
)
class LiveUpstreamSmoke(unittest.TestCase):
    def test_one_chat_reaches_the_real_upstream(self):
        import devii_docker_v2 as box
        key_file = os.environ["RELAY_UPSTREAM_KEY_FILE"]
        self.assertTrue(Path(key_file).is_file(), key_file)
        tmp = tempfile.TemporaryDirectory()
        root = Path(tmp.name)
        attest = root / "attest.key"
        attest.write_bytes(b"live-smoke-attest-key-not-the-upstream\n")
        os.chmod(attest, 0o600)
        self.assertNotEqual(os.path.realpath(key_file), os.path.realpath(attest))
        self.assertNotEqual(Path(key_file).read_bytes(), attest.read_bytes())
        try:
            relay = Relay(
                port=8642, log_root=root / "logs", upstream_key_file=key_file, attest_key_file=str(attest),
                bind_host="127.0.0.1", plant_enabled=False,
            )
            self.assertIsNot(relay.upstream, harness_relay._default_upstream)
            self.assertEqual(relay.upstream_url, harness_relay.UPSTREAM_URL)
            run = new_run_id()
            relay.open_run(run, "executor", "abc")
            body = json.dumps({
                "model": box.MODEL,
                "messages": [{"role": "user", "content": "Reply with the single word pong."}],
                "max_tokens": 16,
                "stream": False,
            }).encode()
            import urllib.request
            captured = {}
            original = urllib.request.urlopen

            def urlopen(req, timeout=None):
                captured["ua"] = req.get_header("User-agent")
                return original(req, timeout=timeout)

            urllib.request.urlopen = urlopen
            try:
                status, resp = relay.handle(
                    "POST", f"/r/{run}/v1/chat/completions", body, {"host": f"{relay.host}:{relay.port}"},
                )
            finally:
                urllib.request.urlopen = original
            self.assertEqual(captured.get("ua"), "Mozilla/5.0")
            self.assertEqual(status, 200, resp)
            parsed = json.loads(resp.decode("utf-8"))
            self.assertIsInstance(parsed.get("choices"), list)
            self.assertGreater(len(parsed["choices"]), 0)
            usage = parsed.get("usage") or {}
            self.assertIsInstance(usage.get("prompt_tokens"), int)
            self.assertIsInstance(usage.get("completion_tokens"), int)
            self.assertGreater(usage["prompt_tokens"] + usage["completion_tokens"], 0)
        finally:
            tmp.cleanup()


def _old_idle(t_write, t_end, trace, timed_out=False, expect_error=False):
    import subprocess
    tmp = tempfile.TemporaryDirectory()
    root = Path(tmp.name)
    outputs = root / "outputs"
    outputs.mkdir()
    answer = outputs / "answer.txt"
    answer.write_text("x\n")
    os.utime(answer, (t_write, t_write))
    (root / "trace.jsonl").write_text(trace)
    (root / "batch.log").write_text("1970-01-01T00:11:40.000Z run 1 done\n")
    (root / "summary.csv").write_text(f"task,seed,n,timed_out,trace\ni014,0,1,{timed_out},{(root / 'trace.jsonl')}\n")
    proc = subprocess.run(["python3", str(EWI_SCRIPT), str(root)], capture_output=True, text=True)
    tmp.cleanup()
    if expect_error:
        return "missing ts" if "missing ts" in (proc.stderr + proc.stdout) else "error"
    if proc.returncode != 0:
        raise AssertionError(proc.stderr or proc.stdout)
    for line in proc.stdout.splitlines():
        if line.startswith("{"):
            return json.loads(line)["idle"]
    raise AssertionError(proc.stdout)


if __name__ == "__main__":
    unittest.main()
