"""Parse a relay log and decide how a run scores.

load() only parses and validates. Every unscored decision lives in classify().
"""
import hashlib
import json
import os
import re
from pathlib import Path

PREFIX = re.compile(r"^(\d+)\|(.*)$")
# pi-coding-agent dist/core/tools/read.js: one trailing truncation notice.
_READ_NOTICE_BODY = (
    r"\n\n\[(Showing lines \d+-\d+ of \d+(?: \([^)]*\))?|\d+ more lines in file)"
    r"\. Use offset=\d+ to continue\.\]"
)
_READ_NOTICE_END = re.compile(_READ_NOTICE_BODY + r"\s*$")
_READ_NOTICE_ANY = re.compile(_READ_NOTICE_BODY)
READ_TOOLS = frozenset({"read"})
INFRA_CODES = (
    "usage_missing",
    "relay_restart",
    "attest_mismatch",
    "no_requests",
    "connect_failed",
    "prerun_layout",
    "docker_daemon_event",
    "upstream_server_error",
)
RUN_CODES = (
    "token_cap",
    "checker_undecided",
    "client_disconnect",
    "result_runid_mismatch",
    "布局违规",
    "upstream_client_error",
)
DAEMON_EVENTS = frozenset({"dockerd_restart", "dockerd_unavailable", "host_oom_other"})
CONTAINER_EVENTS = frozenset({"die", "oom", "kill", "exit"})


class Ledger:
    def __init__(self, path=None):
        self.path = path
        self.events = []
        self.reqs = []
        self.dones = []
        self.run_id = None
        self.validation_errors = []
        self.conclusion_seq = None
        self.tool_bodies = {}
        self.tool_dir = None
        self.valid = True

    def tool_text(self, sha):
        if sha in self.tool_bodies:
            return self.tool_bodies[sha]
        if self.tool_dir is None:
            return None
        file = Path(self.tool_dir) / sha
        if not file.is_file():
            return None
        return file.read_text(encoding="utf-8")


def load(path) -> Ledger:
    """Parse one run log. Structural problems are recorded, not scored."""
    ledger = Ledger(path)
    log = Path(path)
    ledger.tool_dir = str(log.parent / "tool")
    if not log.is_file():
        ledger.valid = False
        ledger.validation_errors.append("missing")
        return ledger
    seen_open = False
    run_ids = set()
    for raw in log.read_text(encoding="utf-8").splitlines():
        if not raw.strip():
            continue
        try:
            event = json.loads(raw)
        except json.JSONDecodeError as exc:
            raise ValueError("relay log line is not JSON") from exc
        if not isinstance(event, dict):
            raise ValueError("relay log line is not an object")
        ledger.events.append(event)
        kind = event.get("type")
        if kind == "relay_start" and seen_open:
            ledger.valid = False
            ledger.validation_errors.append("relay_start_after_open")
        if kind == "open":
            seen_open = True
            rid = event.get("runId")
            if isinstance(rid, str):
                run_ids.add(rid)
                ledger.run_id = rid
        if kind == "req":
            rid = event.get("runId")
            if isinstance(rid, str):
                run_ids.add(rid)
            ledger.reqs.append(event)
            if event.get("conclusion") is True and ledger.conclusion_seq is None:
                ledger.conclusion_seq = event.get("seq")
        if kind == "done":
            ledger.dones.append(event)
    if len(run_ids) > 1:
        ledger.valid = False
        ledger.validation_errors.append("other_run_id")
    starts = [e for e in ledger.events if e.get("type") == "relay_start"]
    opens = [e for e in ledger.events if e.get("type") == "open"]
    if opens and len(starts) != 1:
        ledger.valid = False
        ledger.validation_errors.append("relay_start_count")
    return ledger


def _is_2xx(done) -> bool:
    if done.get("errClass") in ("4xx", "5xx", "network"):
        return False
    if done.get("error") in ("client_disconnect", "upstream_http", "upstream_network"):
        return False
    status = done.get("status", 200)
    if status is None or isinstance(status, bool):
        return False
    return 200 <= int(status) <= 299


def weight(usage):
    """W = i + o + cacheRead. Missing cached field is usage_missing, not an exception."""
    if not isinstance(usage, dict):
        return None
    if "prompt_tokens_details" in usage and isinstance(usage["prompt_tokens_details"], dict) and "cached_tokens" in usage["prompt_tokens_details"]:
        cache = usage["prompt_tokens_details"]["cached_tokens"]
    elif "prompt_cache_hit_tokens" in usage:
        cache = usage["prompt_cache_hit_tokens"]
    else:
        return None
    try:
        prompt = usage["prompt_tokens"]
        completion = usage["completion_tokens"]
    except (KeyError, TypeError):
        return None
    if isinstance(cache, bool) or isinstance(prompt, bool) or isinstance(completion, bool):
        return None
    if not all(isinstance(item, (int, float)) for item in (prompt, completion, cache)):
        return None
    return (prompt - cache) + completion + cache


def tokens(ledger: Ledger) -> dict:
    """Sum relay usage. usage_missing is a 2xx done with null usage or no cached field."""
    total = 0
    missing = False
    for done in ledger.dones:
        if not _is_2xx(done):
            continue
        if done.get("usage") is None:
            missing = True
            continue
        weighed = weight(done["usage"])
        if weighed is None:
            missing = True
            continue
        total += weighed
    return {"tokens": None if missing else total, "usage_missing": missing, "observed": total}


def _docker_events(host) -> list:
    if "docker_events" in host:
        events = host["docker_events"]
    elif "docker_event" in host:
        events = [host["docker_event"]]
    else:
        return []
    return list(events or [])


def _docker_infra(host) -> bool:
    """Daemon restart, daemon down, or a host OOM that kills another process.

    A container's own die, oom, kill, or exit is never infra.
    """
    return any(event in DAEMON_EVENTS for event in _docker_events(host))


def classify(ledger: Ledger, host=None) -> dict:
    """score_status and unscored_kind. Reward is null whenever the run is unscored."""
    host = host or {}
    found = []

    def add(code):
        if code not in found:
            found.append(code)

    if "relay_start_after_open" in ledger.validation_errors or host.get("relay_restart") is True:
        add("relay_restart")
    expected_boot = host.get("expected_boot_id")
    if expected_boot and any(req.get("bootId") != expected_boot for req in ledger.reqs):
        add("relay_restart")
    if host.get("attest_mismatch") is True:
        add("attest_mismatch")
    if host.get("prerun_ok") is False:
        add("prerun_layout")
    elif len(ledger.reqs) == 0:
        if host.get("connect_evidence") == "host":
            add("connect_failed")
        else:
            add("no_requests")
    if _docker_infra(host):
        add("docker_daemon_event")
    if host.get("layout_violation") is True:
        add("布局违规")
    if host.get("token_cap") is True:
        add("token_cap")
    if host.get("checker_undecided") is True:
        add("checker_undecided")
    try:
        if tokens(ledger)["usage_missing"]:
            add("usage_missing")
    except ValueError:
        add("usage_missing")
    done_by_seq = {done.get("seq"): done for done in ledger.dones}
    for req in ledger.reqs:
        done = done_by_seq.get(req.get("seq"))
        if done is None:
            add("client_disconnect")
            continue
        err = done.get("errClass")
        if err == "4xx":
            add("upstream_client_error")
        elif err in ("5xx", "network"):
            add("upstream_server_error")
        if done.get("error") == "client_disconnect":
            add("client_disconnect")
    expected = host.get("expected_run_id")
    result_id = host.get("result_run_id", None)
    if expected is not None and result_id is not None and result_id != expected:
        add("result_runid_mismatch")
    infra = [code for code in found if code in INFRA_CODES]
    run = [code for code in found if code in RUN_CODES]
    if not infra and not run:
        return {"score_status": "scored", "unscored_kind": None, "codes": [], "reward": None}
    return {
        "score_status": "unscored",
        "unscored_kind": "run" if run else "infra",
        "codes": infra + run,
        "reward": None,
    }


def patch_active(ledger: Ledger, mounted_sha: str) -> dict:
    """Activation counts only requests that carry a config hash.

    A request with no hash, such as compaction, is ignored. It is not forgery.
    A request that carries some other hash still fails the check. If nothing
    carries a hash, the patch was not shown to the model.
    """
    reqs = ledger.reqs
    if not mounted_sha:
        return {"active": False, "requests": len(reqs)}
    carrying = [req for req in reqs if req.get("systemConfigHashes")]
    if not carrying:
        return {"active": False, "requests": len(reqs)}
    active = all(mounted_sha in (req.get("systemConfigHashes") or []) for req in carrying)
    return {"active": active, "requests": len(reqs)}


def _strip_read_notice(text: str) -> str:
    """Drop Pi's read-tool truncation notice when it is exactly one, at the end."""
    hits = list(_READ_NOTICE_ANY.finditer(text))
    if len(hits) != 1:
        return text
    end = _READ_NOTICE_END.search(text)
    if end is None or end.start() != hits[0].start():
        return text
    return text[:end.start()]


def strip_line_prefixes(text: str) -> str:
    """If every line is N|rest, strip that prefix. Mixed lines stay as they are."""
    lines = text.splitlines()
    if lines and all(PREFIX.match(line) for line in lines):
        body = "\n".join(PREFIX.match(line).group(2) for line in lines)
        if text.endswith("\n"):
            body += "\n"
        return body
    return text


def _args_path(args):
    if isinstance(args, str):
        try:
            parsed = json.loads(args)
        except json.JSONDecodeError:
            return args
        args = parsed
    if isinstance(args, dict):
        path = args.get("path", args.get("file"))
        return path if isinstance(path, str) else None
    return None


def _same_path(left, right) -> bool:
    try:
        return os.path.realpath(left) == os.path.realpath(right)
    except OSError:
        return os.path.abspath(left) == os.path.abspath(right)


def _within(child, root) -> bool:
    return child == root or child.startswith(root + os.sep)


def _role_relative_realpath(tool_path, role_cwd):
    """Resolve a relative tool path against the role cwd.

    ``..`` that leaves the cwd, and a symlink whose realpath leaves the cwd,
    are rejected. A path that stays inside is returned so the caller can
    require it to be the attested copy. Absolute paths are not handled here.
    """
    if os.path.isabs(tool_path) or not role_cwd:
        return None
    try:
        cwd_real = os.path.realpath(role_cwd)
    except OSError:
        return None
    if not os.path.isdir(cwd_real):
        return None
    lexical = os.path.normpath(os.path.join(cwd_real, tool_path))
    if not _within(lexical, cwd_real):
        return None
    try:
        resolved = os.path.realpath(lexical)
    except OSError:
        return None
    if not _within(resolved, cwd_real):
        return None
    return resolved


def _read_path_matches(tool_path, host_file_path, role_cwd) -> bool:
    """Absolute tool paths compare as before. Relative ones use the role cwd."""
    if not isinstance(tool_path, str) or tool_path == "":
        return False
    if os.path.isabs(tool_path):
        return _same_path(tool_path, host_file_path)
    resolved = _role_relative_realpath(tool_path, role_cwd)
    if resolved is None:
        return False
    try:
        attested = os.path.realpath(host_file_path)
    except OSError:
        attested = os.path.abspath(host_file_path)
    return resolved == attested


def _round0_file(host_file_path) -> bool:
    return os.path.basename(str(host_file_path)) == "round0-trace.jsonl"


def _resolved_inside_cwd(tool_path, role_cwd):
    """A tool path that stays inside the role cwd, relative or absolute."""
    if not isinstance(tool_path, str) or tool_path == "" or not role_cwd:
        return None
    if not os.path.isabs(tool_path):
        return _role_relative_realpath(tool_path, role_cwd)
    try:
        cwd_real = os.path.realpath(role_cwd)
    except OSError:
        return None
    if not os.path.isdir(cwd_real):
        return None
    lexical = os.path.abspath(tool_path)
    if not _within(lexical, cwd_real):
        return None
    try:
        resolved = os.path.realpath(tool_path)
    except OSError:
        return None
    if not _within(resolved, cwd_real) or not os.path.isfile(resolved):
        return None
    return resolved


def _file_sha(path) -> str | None:
    try:
        data = Path(path).read_bytes()
    except OSError:
        return None
    return hashlib.sha256(data).hexdigest()


def _counts_as_round0(tool_path, host_file_path, expected_sha, role_cwd) -> bool:
    """Another in-cwd name counts as round0 when that file's sha is round0's."""
    if not _round0_file(host_file_path):
        return False
    resolved = _resolved_inside_cwd(tool_path, role_cwd)
    if resolved is None:
        return False
    return _file_sha(resolved) == expected_sha


def _expand_cited(cited):
    lines = []
    for item in cited:
        if isinstance(item, int):
            lines.append(item)
        elif isinstance(item, (list, tuple)) and len(item) == 2:
            start, end = int(item[0]), int(item[1])
            lines.extend(range(start, end + 1))
        else:
            raise TypeError("cited line")
    return lines


def _segment_span(segment: str, host_text: str):
    file_lines = host_text.splitlines()
    seg_lines = segment.splitlines()
    host_norm = "\n".join(file_lines) + ("\n" if host_text.endswith("\n") else "")
    seg_norm = "\n".join(seg_lines) + ("\n" if segment.endswith("\n") else "")
    whole = segment == host_text or seg_norm == host_norm
    file_bytes = len(host_text.encode())
    if file_bytes < 200 and not whole:
        return None
    if whole:
        if not file_lines:
            return (1, 1) if host_text == "" else (1, 1)
        return (1, len(file_lines))
    if len(seg_lines) < 3 or len(segment.encode()) < 200:
        return None
    count = 0
    found = None
    width = len(seg_lines)
    if width == 0 or width > len(file_lines):
        return None
    for index in range(len(file_lines) - width + 1):
        if file_lines[index:index + width] == seg_lines:
            count += 1
            found = (index + 1, index + width)
    if count != 1:
        return None
    return found


def _cited_ok(cited, span, host_text) -> bool:
    if cited is None:
        return True
    file_lines = host_text.splitlines()
    lines = _expand_cited(cited)
    if not lines:
        return False
    start, end = span
    if any(line < start or line > end for line in lines):
        return False
    return any(0 < line <= len(file_lines) and file_lines[line - 1].strip() != "" for line in lines)


def read_evidence(role_ledger, host_file_path, expected_file_sha, cited_lines=None, *, role_cwd=None) -> dict:
    """A segment counts only when (a)(b)(c)(d) and cited-line rule (f) all hold."""
    data = Path(host_file_path).read_bytes()
    digest = hashlib.sha256(data).hexdigest()
    if digest != expected_file_sha:
        return {"ok": False, "reason": "file_sha"}
    host_text = data.decode("utf-8")
    ledger = role_ledger if isinstance(role_ledger, Ledger) else load(role_ledger)
    for req in ledger.reqs:
        if ledger.run_id and req.get("runId") not in (None, ledger.run_id):
            continue
        if ledger.conclusion_seq is not None and req.get("seq", 0) >= ledger.conclusion_seq:
            continue
        for tool in req.get("toolResults") or []:
            if tool.get("toolName") not in READ_TOOLS:
                continue
            path = _args_path(tool.get("args"))
            if not path:
                continue
            if not _read_path_matches(path, host_file_path, role_cwd) and not _counts_as_round0(path, host_file_path, digest, role_cwd):
                continue
            raw = ledger.tool_text(tool.get("sha256"))
            if raw is None:
                continue
            stripped = _strip_read_notice(raw)
            if stripped != raw and stripped == "":
                continue
            segment = strip_line_prefixes(stripped)
            span = _segment_span(segment, host_text)
            if span is None:
                continue
            if not _cited_ok(cited_lines, span, host_text):
                continue
            return {
                "ok": True,
                "startLine": span[0],
                "endLine": span[1],
                "seq": req.get("seq"),
                "sha256": tool.get("sha256"),
            }
    return {"ok": False, "reason": "no_segment"}


def main(argv=None):
    import sys
    argv = list(sys.argv[1:] if argv is None else argv)
    if not argv or argv[0] != "read-evidence":
        raise SystemExit("usage: ledger.py read-evidence --log PATH --file PATH --sha HEX [--cited 1,2] [--cwd DIR]")
    flags = {}
    key = None
    for arg in argv[1:]:
        if arg.startswith("--"):
            key = arg[2:]
            flags[key] = ""
        elif key:
            flags[key] = arg
            key = None
    cited = None
    if flags.get("cited"):
        cited = [int(part) for part in flags["cited"].split(",") if part]
    cwd = flags.get("cwd") or None
    result = read_evidence(flags["log"], flags["file"], flags["sha"], cited, role_cwd=cwd)
    print(json.dumps(result))
    raise SystemExit(0 if result["ok"] else 2)


if __name__ == "__main__":
    main()
