import { describe, expect, test } from "bun:test";
import { mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  HumanAcceptanceGate,
  SandboxBoundary,
  SandboxViolation,
  SecretRedactor,
  assertSnapshotIntegrity,
  createTrustedSnapshot,
  evaluateTrustedSnapshot,
  generateEvaluationKeyPair,
  signEvaluationDigest,
  validEvaluationPublicKey,
  verifyEvaluationDigest,
  restrictSandboxPolicy,
} from "./security-boundary";

describe("security boundary", () => {
  test("rejects traversal, protected paths, network, and host sockets", () => {
    const boundary = new SandboxBoundary({ root: "/tmp/evok-security", network: "none" });

    expect(boundary.assertPath("candidate.ts", "write")).toBe("/tmp/evok-security/candidate.ts");
    expect(() => boundary.assertPath("../outside", "write")).toThrow(SandboxViolation);
    expect(() => boundary.assertPath(".env", "read")).toThrow(SandboxViolation);
    expect(() => boundary.assertPath("evaluator/contract.json", "write")).toThrow(SandboxViolation);
    expect(() => boundary.assertNetwork("https://example.com")).toThrow(SandboxViolation);
    expect(() => boundary.assertHostSocket("/var/run/docker.sock")).toThrow(SandboxViolation);
    expect(() => boundary.validateCandidateFiles({ "../outside": "x" })).toThrow(SandboxViolation);
  });

  test("rejects symlink components even when the resolved target is inside another directory", async () => {
    const root = await mkdtemp(join(tmpdir(), "evok-security-"));
    const outside = await mkdtemp(join(tmpdir(), "evok-outside-"));
    await symlink(outside, join(root, "link"));
    const boundary = new SandboxBoundary({ root });

    await expect(boundary.assertPathAsync("link/result.json", "write")).rejects.toThrow(SandboxViolation);
  });

  test("redacts the same secrets in text and nested event values", () => {
    const redactor = new SecretRedactor(["top-secret", "x"]);
    const text = redactor.redactText("Authorization: Bearer top-secret; token=top-secret; x");
    expect(text).not.toContain("top-secret");
    expect(text).not.toContain("x");
    const value = redactor.redact({ raw: { output: "top-secret" }, message: "safe" });
    expect(JSON.stringify(value)).not.toContain("top-secret");
    expect(value).toMatchObject({ message: "safe" });
  });

  test("freezes and binds an evaluation snapshot to digests", async () => {
    const snapshot = createTrustedSnapshot({
      missionId: "m",
      branchId: "b",
      attempt: 1,
      files: { score: "3" },
      contract: { objective: "maximize" },
      provenance: { runId: "m:b:1", candidateId: "b:1", fencingToken: 1 },
    });

    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.files)).toBe(true);
    const manifest = assertSnapshotIntegrity(snapshot);
    expect(manifest.snapshotDigest).toBe(snapshot.digest);
    expect(Object.isFrozen(manifest)).toBe(true);
    const evaluated = await evaluateTrustedSnapshot(snapshot, snapshot.contract, (input) => {
      expect(Object.isFrozen(input)).toBe(true);
      return Number(input.files.score);
    });
    expect(evaluated.result).toBe(3);

    const forged = { ...snapshot, files: { score: "99" } };
    expect(() => assertSnapshotIntegrity(forged)).toThrow();
  });

  test("keeps per-run policy restrictions from enabling forbidden capabilities", () => {
    const restricted = new SandboxBoundary({ root: "/tmp/evok-policy", allowedTools: ["bash", "powershell", "user_bash"], allowBash: true });
    expect(() => restricted.assertToolCall("bash", { command: "cat /etc/passwd" })).toThrow(SandboxViolation);
    expect(() => restricted.assertToolCall("bash", { command: "curl https://example.com" })).toThrow(SandboxViolation);
    expect(() => restricted.assertToolCall("powershell", { command: "curl https://example.com" })).toThrow(SandboxViolation);
    expect(() => restricted.assertToolCall("user_bash", { command: "cat /etc/passwd" })).toThrow(SandboxViolation);
  });

  test("readRoots permit read access to approved project roots but never writes or escapes", () => {
    const boundary = new SandboxBoundary({
      root: "/tmp/evok-run",
      readRoots: ["/home/me/research-project"],
    });
    expect(boundary.assertPath("/home/me/research-project/README.md", "read")).toBe("/home/me/research-project/README.md");
    expect(boundary.assertPath("result.txt", "read")).toBe("/tmp/evok-run/result.txt");
    // writes stay confined to the run workspace
    expect(() => boundary.assertPath("/home/me/research-project/README.md", "write")).toThrow(SandboxViolation);
    // an unrelated absolute path is still a traversal
    expect(() => boundary.assertPath("/home/me/other/secret.txt", "read")).toThrow(SandboxViolation);
    // protected segments remain protected even inside a read root
    expect(() => boundary.assertPath("/home/me/research-project/.env", "read")).toThrow(SandboxViolation);
  });

  test("readRoots cannot escape through a symlink committed inside the project", async () => {
    const root = await mkdtemp(join(tmpdir(), "evok-readroot-"));
    const secret = await mkdtemp(join(tmpdir(), "evok-readroot-secret-"));
    await writeFile(join(secret, "id_rsa"), "private key");
    await symlink(secret, join(root, "link"));
    const boundary = new SandboxBoundary({
      root: await mkdtemp(join(tmpdir(), "evok-readroot-run-")),
      readRoots: [root],
    });
    // lexical containment passes, but the symlink resolves outside every approved root
    expect(() => boundary.assertPath(join(root, "link", "id_rsa"), "read")).toThrow(SandboxViolation);
    expect(() => boundary.assertPath(join(root, "link"), "read")).toThrow(SandboxViolation);
  });

  test("restrictSandboxPolicy intersects readRoots so a run cannot widen project access", () => {
    const restricted = restrictSandboxPolicy(
      { root: "/tmp/evok-run", readRoots: ["/home/me/project", "/home/me/shared"] },
      { root: "/tmp/evok-run", readRoots: ["/home/me/project"] },
    );
    expect(restricted.readRoots).toEqual(["/home/me/project"]);
    const unrestricted = restrictSandboxPolicy({ root: "/tmp/evok-run", readRoots: ["/home/me/project"] }, { root: "/tmp/evok-run" });
    expect(unrestricted.readRoots).toEqual(["/home/me/project"]);
    const adding = restrictSandboxPolicy({ root: "/tmp/evok-run" }, { root: "/tmp/evok-run", readRoots: ["/home/me/project"] });
    expect(adding.readRoots).toBeUndefined();
    // strict containment both directions keeps the narrower root
    const overlayNarrower = restrictSandboxPolicy(
      { root: "/tmp/evok-run", readRoots: ["/home/me/project"] },
      { root: "/tmp/evok-run", readRoots: ["/home/me/project/sub"] },
    );
    expect(overlayNarrower.readRoots).toEqual(["/home/me/project/sub"]);
    const baseNarrower = restrictSandboxPolicy(
      { root: "/tmp/evok-run", readRoots: ["/home/me/project/sub"] },
      { root: "/tmp/evok-run", readRoots: ["/home/me/project"] },
    );
    expect(baseNarrower.readRoots).toEqual(["/home/me/project/sub"]);
    // disjoint grants collapse to nothing
    const disjoint = restrictSandboxPolicy(
      { root: "/tmp/evok-run", readRoots: ["/home/me/project"] },
      { root: "/tmp/evok-run", readRoots: ["/home/me/other"] },
    );
    expect(disjoint.readRoots).toEqual([]);
  });

  test("requires an explicit human decision after local promotion", () => {
    const gate = new HumanAcceptanceGate();
    expect(() => gate.accept({ championDigest: "", acceptedBy: "operator" })).toThrow();
    const decision = gate.accept({ championDigest: "abc", acceptedBy: "operator", decisionId: "d1" });
    expect(decision).toMatchObject({ championDigest: "abc", acceptedBy: "operator", decisionId: "d1" });
  });

  test("binds acceptance to a request and rejects invalid expiry windows", () => {
    const gate = new HumanAcceptanceGate();
    expect(() => gate.accept({ championDigest: "abc", acceptedBy: "operator", acceptedAt: 5, expiresAt: 5 })).toThrow();
    const decision = gate.accept({ championDigest: "abc", acceptedBy: "operator", requestId: "submission-1", acceptedAt: 5, expiresAt: 10, token: "do-not-copy" } as unknown as Parameters<HumanAcceptanceGate["accept"]>[0]);
    expect(decision).toMatchObject({ requestId: "submission-1", acceptedAt: 5, expiresAt: 10 });
    expect((decision as Record<string, unknown>).token).toBeUndefined();
    expect(Object.isFrozen(decision)).toBe(true);
  });

  test("evaluator signatures verify only against the registered key and reject tampering", () => {
    const evaluator = generateEvaluationKeyPair("independent-evaluator");
    const forger = generateEvaluationKeyPair("forger");
    const digest = "sha256:digest";
    const signature = signEvaluationDigest(digest, evaluator.privateKey);

    expect(validEvaluationPublicKey(evaluator.publicKey)).toBe(true);
    expect(validEvaluationPublicKey("not-a-key")).toBe(false);
    expect(verifyEvaluationDigest(digest, signature, evaluator.publicKey)).toBe(true);
    expect(verifyEvaluationDigest("sha256:other", signature, evaluator.publicKey)).toBe(false);
    expect(verifyEvaluationDigest(digest, signature, forger.publicKey)).toBe(false);
  });
});
