import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ATTEST_FIELDS,
  ATTEST_FILENAME,
  ATTEST_SCHEMA,
  loadAttestKey,
  pythonFloatLexeme,
  treeShas,
  verifyHostAttestation,
  writeHostAttestation,
} from "./attestation";

function keyFile(dir: string): { readonly file: string; readonly key: Buffer } {
  const file = join(dir, "attest.key");
  const key = Buffer.alloc(32, 4);
  writeFileSync(file, key);
  chmodSync(file, 0o600);
  return { file, key };
}

function layout(name: string): { readonly root: string; readonly runDir: string; readonly attestDir: string; readonly harness: string; readonly config: string; readonly key: Buffer } {
  const root = mkdtempSync(join(tmpdir(), `attest-${name}-`));
  const runDir = join(root, "run");
  const attestDir = join(root, "attest");
  const harness = join(root, "harness.mjs");
  const config = join(root, "config.json");
  writeFileSync(harness, "harness\n");
  writeFileSync(config, "{\"parts\":{\"agent-loop\":{\"maxSteps\":24}}}\n");
  mkdirSync(join(runDir, "outputs"), { recursive: true });
  mkdirSync(join(runDir, "verifier"), { recursive: true });
  mkdirSync(join(runDir, ".pi-sessions"), { recursive: true });
  writeFileSync(join(runDir, "trace.jsonl"), "{\"type\":\"run_start\"}\n");
  writeFileSync(join(runDir, "outputs", "answer.txt"), "ok\n");
  writeFileSync(join(runDir, "verifier", "reward.txt"), "1\n");
  writeFileSync(join(runDir, ".pi-sessions", "session.jsonl"), "{\"type\":\"message\"}\n");
  writeFileSync(join(runDir, "result.json"), "{\"reward\":1}\n");
  const linked = join(root, "outside.txt");
  writeFileSync(linked, "secret\n");
  symlinkSync(linked, join(runDir, "outputs", "linked.txt"));
  return { root, runDir, attestDir, harness, config, key: keyFile(root).key };
}

describe("devii-opt-attest/v1", () => {
  test("a Python-written attestation verifies, and a changed artifact does not", () => {
    const host = layout("py");
    const written = spawnSync("python3", ["-c", PYTHON_WRITE, host.runDir, host.attestDir, host.harness, host.config, join(host.root, "attest.key")], { encoding: "utf8" });
    expect(written.status).toBe(0);
    const verified = verifyHostAttestation({
      attestDir: host.attestDir,
      key: host.key,
      configPath: host.config,
      harnessPath: host.harness,
      runDir: host.runDir,
    });
    expect(verified.ok).toBe(true);
    if (!verified.ok) return;
    expect(verified.mountedConfigSha).toHaveLength(64);
    expect(verified.reward).toBe(1);
    expect(verified.outputShas).not.toHaveProperty("linked.txt");
    writeFileSync(join(host.runDir, "trace.jsonl"), "{\"type\":\"run_start\",\"tampered\":true}\n");
    const tampered = verifyHostAttestation({
      attestDir: host.attestDir,
      key: host.key,
      configPath: host.config,
      harnessPath: host.harness,
      runDir: host.runDir,
    });
    expect(tampered.ok).toBe(false);
    if (tampered.ok) return;
    expect(tampered.reasons).toContain("trace");
  });

  test("a file this package writes verifies in Python, including reward 1.0", () => {
    const host = layout("ts");
    writeHostAttestation({
      attestDir: host.attestDir,
      outDir: host.root,
      runDir: host.runDir,
      key: host.key,
      harnessPath: host.harness,
      configPath: host.config,
      reward: 1,
      meta: {
        task: "tasks2/i014",
        seed: 0,
        arm: "candidate",
        score_status: "scored",
        tokens: 10,
        exit: 0,
        runDir: host.runDir,
        runId: "host-run",
        runPath: host.runDir,
        at: "2026-10-21T00:00:00+09:00",
      },
    });
    const checked = spawnSync("python3", ["-c", PYTHON_CHECK, join(host.attestDir, ATTEST_FILENAME), join(host.root, "attest.key")], { encoding: "utf8" });
    expect(checked.status).toBe(0);
    expect(checked.stdout.trim()).toBe("ok");
    const body = JSON.parse(readFileSync(join(host.attestDir, ATTEST_FILENAME), "utf8")) as Record<string, unknown>;
    expect(body[ATTEST_FIELDS.schema]).toBe(ATTEST_SCHEMA);
    expect(typeof body[ATTEST_FIELDS.mac]).toBe("string");
    expect(pythonFloatLexeme(1)).toBe("1.0");
    const text = readFileSync(join(host.attestDir, ATTEST_FILENAME), "utf8");
    expect(text).toContain("\"reward\": 1.0");
    const run = body.run as { runDir?: string; runPath?: string };
    expect(run.runDir).toBe("run");
    expect(run.runPath).toBe("run");
  });

  test("a bad mac, a different config, and a symlink are rejected", () => {
    const host = layout("bad");
    writeHostAttestation({
      attestDir: host.attestDir,
      outDir: host.root,
      runDir: host.runDir,
      key: host.key,
      harnessPath: host.harness,
      configPath: host.config,
      reward: 1,
      meta: {
        task: "tasks2/i014",
        seed: 0,
        arm: "candidate",
        score_status: "scored",
        tokens: 4,
        exit: 0,
        runDir: host.runDir,
        runId: "host-run",
        runPath: host.runDir,
        at: "2026-10-21T00:00:00+09:00",
      },
    });
    const other = join(host.root, "other.json");
    writeFileSync(other, "{\"parts\":{\"agent-loop\":{\"maxSteps\":25}}}\n");
    const mismatch = verifyHostAttestation({
      attestDir: host.attestDir,
      key: host.key,
      configPath: other,
      harnessPath: host.harness,
      runDir: host.runDir,
    });
    expect(mismatch.ok).toBe(false);
    if (!mismatch.ok) expect(mismatch.reasons).toContain("config");
    const file = join(host.attestDir, ATTEST_FILENAME);
    const raw = readFileSync(file, "utf8");
    writeFileSync(file, raw.replace("\"hmacSha256\": \"", "\"hmacSha256\": \"0"));
    const bad = verifyHostAttestation({
      attestDir: host.attestDir,
      key: host.key,
      configPath: host.config,
      harnessPath: host.harness,
      runDir: host.runDir,
    });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.reasons).toContain("hmac");
    expect(treeShas(join(host.runDir, "outputs"))).not.toHaveProperty("linked.txt");
    expect(() => loadAttestKey(join(host.runDir, "missing-key"))).toThrow(/missing/);
  });

  test("a signed runPath that is not the host-assigned path fails closed", () => {
    const host = layout("runpath");
    const planted = join(host.root, "planted");
    mkdirSync(planted, { recursive: true });
    writeHostAttestation({
      attestDir: host.attestDir,
      outDir: host.root,
      runDir: host.runDir,
      key: host.key,
      harnessPath: host.harness,
      configPath: host.config,
      reward: 1,
      meta: {
        task: "tasks2/i014",
        seed: 0,
        arm: "candidate",
        score_status: "scored",
        tokens: 4,
        exit: 0,
        runDir: host.runDir,
        runId: "host-run",
        runPath: planted,
        at: "2026-10-21T00:00:00+09:00",
      },
    });
    const hijacked = verifyHostAttestation({
      attestDir: host.attestDir,
      key: host.key,
      configPath: host.config,
      harnessPath: host.harness,
      runDir: host.runDir,
      runId: "host-run",
    });
    expect(hijacked.ok).toBe(false);
    if (!hijacked.ok) expect(hijacked.reasons).toContain("runPath");
    const missing = spawnSync("python3", ["-c", PYTHON_WRITE_NO_RUNPATH, host.runDir, host.attestDir, host.harness, host.config, join(host.root, "attest.key")], { encoding: "utf8" });
    expect(missing.status).toBe(0);
    const bare = verifyHostAttestation({
      attestDir: host.attestDir,
      key: host.key,
      configPath: host.config,
      harnessPath: host.harness,
      runDir: host.runDir,
    });
    expect(bare.ok).toBe(false);
    if (!bare.ok) expect(bare.reasons).toContain("runPath");
  });

  test("a copied signed run verifies, and a tamper or an escaping path does not", () => {
    const host = layout("copy");
    writeHostAttestation({
      attestDir: host.attestDir,
      outDir: host.root,
      runDir: host.runDir,
      key: host.key,
      harnessPath: host.harness,
      configPath: host.config,
      reward: 1,
      meta: {
        task: "tasks2/i014",
        seed: 0,
        arm: "candidate",
        score_status: "scored",
        tokens: 4,
        exit: 0,
        runDir: host.runDir,
        runId: "host-run",
        runPath: host.runDir,
        at: "2026-10-21T00:00:00+09:00",
      },
    });
    const dest = join(host.root, "relocated");
    cpSync(host.runDir, join(dest, "run"), { recursive: true });
    cpSync(host.attestDir, join(dest, "attest"), { recursive: true });
    const moved = verifyHostAttestation({
      attestDir: join(dest, "attest"),
      key: host.key,
      configPath: host.config,
      harnessPath: host.harness,
      outDir: dest,
      runDir: join(dest, "run"),
    });
    expect(moved.ok).toBe(true);
    writeFileSync(join(dest, "run", "trace.jsonl"), "{\"type\":\"run_start\",\"tampered\":true}\n");
    const tampered = verifyHostAttestation({
      attestDir: join(dest, "attest"),
      key: host.key,
      configPath: host.config,
      harnessPath: host.harness,
      outDir: dest,
      runDir: join(dest, "run"),
    });
    expect(tampered.ok).toBe(false);
    if (!tampered.ok) expect(tampered.reasons).toContain("trace");
    expect(() => writeHostAttestation({
      attestDir: join(host.root, "escape-attest"),
      outDir: host.root,
      runDir: host.runDir,
      key: host.key,
      harnessPath: host.harness,
      configPath: host.config,
      reward: 1,
      meta: {
        task: "tasks2/i014",
        seed: 0,
        arm: "candidate",
        score_status: "scored",
        tokens: 4,
        exit: 0,
        runDir: host.runDir,
        runId: "host-run",
        runPath: join(host.root, "..", "outside"),
        at: "2026-10-21T00:00:00+09:00",
      },
    })).toThrow(/escapes the out dir/);
    const escaped = spawnSync("python3", ["-c", PYTHON_WRITE_ESCAPE, host.runDir, join(host.root, "escape-signed"), host.harness, host.config, join(host.root, "attest.key")], { encoding: "utf8" });
    expect(escaped.status).toBe(0);
    const outside = verifyHostAttestation({
      attestDir: join(host.root, "escape-signed"),
      key: host.key,
      configPath: host.config,
      harnessPath: host.harness,
      outDir: host.root,
      runDir: host.runDir,
    });
    expect(outside.ok).toBe(false);
    if (!outside.ok) expect(outside.reasons).toContain("runDir");
  });

  test("a copied legacy absolute attestation verifies when the relative remainder matches", () => {
    const host = layout("legacy-copy");
    const written = spawnSync("python3", ["-c", PYTHON_WRITE, host.runDir, host.attestDir, host.harness, host.config, join(host.root, "attest.key")], { encoding: "utf8" });
    expect(written.status).toBe(0);
    const inPlace = verifyHostAttestation({
      attestDir: host.attestDir,
      key: host.key,
      configPath: host.config,
      harnessPath: host.harness,
      outDir: host.root,
      runDir: host.runDir,
    });
    expect(inPlace.ok).toBe(true);
    const dest = join(host.root, "relocated");
    cpSync(host.runDir, join(dest, "run"), { recursive: true });
    cpSync(host.attestDir, join(dest, "attest"), { recursive: true });
    const moved = verifyHostAttestation({
      attestDir: join(dest, "attest"),
      key: host.key,
      configPath: host.config,
      harnessPath: host.harness,
      outDir: dest,
      runDir: join(dest, "run"),
    });
    expect(moved.ok).toBe(true);
    writeFileSync(join(dest, "run", "trace.jsonl"), "{\"type\":\"run_start\",\"tampered\":true}\n");
    const tampered = verifyHostAttestation({
      attestDir: join(dest, "attest"),
      key: host.key,
      configPath: host.config,
      harnessPath: host.harness,
      outDir: dest,
      runDir: join(dest, "run"),
    });
    expect(tampered.ok).toBe(false);
    if (!tampered.ok) expect(tampered.reasons).toContain("trace");
    const mismatched = join(host.root, "other-layout");
    cpSync(host.runDir, join(mismatched, "xb", "run"), { recursive: true });
    cpSync(host.attestDir, join(mismatched, "attest"), { recursive: true });
    const escaped = verifyHostAttestation({
      attestDir: join(mismatched, "attest"),
      key: host.key,
      configPath: host.config,
      harnessPath: host.harness,
      outDir: mismatched,
      runDir: join(mismatched, "xb", "run"),
    });
    expect(escaped.ok).toBe(false);
    if (!escaped.ok) expect(escaped.reasons).toContain("runDir");
  });
});

const PYTHON_WRITE = `
import hashlib, hmac, json, os, sys
from pathlib import Path
run, attest, harness, config, keyfile = map(Path, sys.argv[1:])
def sha(p):
    return hashlib.sha256(Path(p).read_bytes()).hexdigest()
def tree(root):
    root = Path(root)
    if not root.is_dir():
        return {}
    return {str(p.relative_to(root)): sha(p) for p in sorted(root.rglob("*")) if p.is_file() and not p.is_symlink()}
body = {
  "schema": "devii-opt-attest/v1",
  "mountedHarnessSha": sha(harness),
  "mountedConfigSha": sha(config),
  "traceSha": sha(run / "trace.jsonl"),
  "piSessionShas": tree(run / ".pi-sessions"),
  "outputShas": tree(run / "outputs"),
  "reward": float(1),
  "rewardFileSha": sha(run / "verifier" / "reward.txt"),
  "resultSha": sha(run / "result.json"),
  "run": {"task": "tasks2/i014", "seed": 0, "arm": "candidate", "score_status": "scored", "tokens": 4, "exit": 0, "runDir": str(run.resolve()), "runPath": str(run.resolve()), "runId": "host-run", "at": "2026-10-21T00:00:00+09:00"},
}
key = keyfile.read_bytes()
body["hmacSha256"] = hmac.new(key, json.dumps(body, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode(), hashlib.sha256).hexdigest()
attest.mkdir(parents=True, exist_ok=True)
(attest / "attestation.json").write_text(json.dumps(body, indent=1, sort_keys=True) + "\\n")
`;

const PYTHON_CHECK = `
import hashlib, hmac, json, sys
body = json.loads(open(sys.argv[1]).read())
mac = body.pop("hmacSha256")
key = open(sys.argv[2], "rb").read()
got = hmac.new(key, json.dumps(body, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode(), hashlib.sha256).hexdigest()
print("ok" if hmac.compare_digest(mac, got) else "bad")
`;

const PYTHON_WRITE_NO_RUNPATH = `
import hashlib, hmac, json, sys
from pathlib import Path
run, attest, harness, config, keyfile = map(Path, sys.argv[1:])
def sha(p):
    return hashlib.sha256(Path(p).read_bytes()).hexdigest()
def tree(root):
    root = Path(root)
    return {str(p.relative_to(root)): sha(p) for p in sorted(root.rglob("*")) if p.is_file() and not p.is_symlink()}
body = {
  "schema": "devii-opt-attest/v1",
  "mountedHarnessSha": sha(harness),
  "mountedConfigSha": sha(config),
  "traceSha": sha(run / "trace.jsonl"),
  "piSessionShas": tree(run / ".pi-sessions"),
  "outputShas": tree(run / "outputs"),
  "reward": float(1),
  "rewardFileSha": sha(run / "verifier" / "reward.txt"),
  "resultSha": sha(run / "result.json"),
  "run": {"task": "tasks2/i014", "seed": 0, "arm": "candidate", "score_status": "scored", "tokens": 4, "exit": 0, "runDir": str(run.resolve()), "runId": "host-run", "at": "2026-10-21T00:00:00+09:00"},
}
key = keyfile.read_bytes()
body["hmacSha256"] = hmac.new(key, json.dumps(body, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode(), hashlib.sha256).hexdigest()
attest.mkdir(parents=True, exist_ok=True)
(attest / "attestation.json").write_text(json.dumps(body, indent=1, sort_keys=True) + "\\n")
`;

const PYTHON_WRITE_ESCAPE = `
import hashlib, hmac, json, sys
from pathlib import Path
run, attest, harness, config, keyfile = map(Path, sys.argv[1:])
def sha(p):
    return hashlib.sha256(Path(p).read_bytes()).hexdigest()
def tree(root):
    root = Path(root)
    return {str(p.relative_to(root)): sha(p) for p in sorted(root.rglob("*")) if p.is_file() and not p.is_symlink()}
body = {
  "schema": "devii-opt-attest/v1",
  "mountedHarnessSha": sha(harness),
  "mountedConfigSha": sha(config),
  "traceSha": sha(run / "trace.jsonl"),
  "piSessionShas": tree(run / ".pi-sessions"),
  "outputShas": tree(run / "outputs"),
  "reward": float(1),
  "rewardFileSha": sha(run / "verifier" / "reward.txt"),
  "resultSha": sha(run / "result.json"),
  "run": {"task": "tasks2/i014", "seed": 0, "arm": "candidate", "score_status": "scored", "tokens": 4, "exit": 0, "runDir": "../escape", "runPath": "../escape", "runId": "host-run", "at": "2026-10-21T00:00:00+09:00"},
}
key = keyfile.read_bytes()
body["hmacSha256"] = hmac.new(key, json.dumps(body, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode(), hashlib.sha256).hexdigest()
attest.mkdir(parents=True, exist_ok=True)
(attest / "attestation.json").write_text(json.dumps(body, indent=1, sort_keys=True) + "\\n")
`;
