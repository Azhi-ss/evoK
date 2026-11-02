import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CollaborationScheduler } from "./collaboration-scheduler";

const cleanup: (() => void)[] = [];
afterEach(() => {
  while (cleanup.length) cleanup.pop()!();
});
function open() {
  const dir = mkdtempSync(join(tmpdir(), "evok-tree-"));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const reopen = () => {
    const s = new CollaborationScheduler(join(dir, "tree.sqlite"));
    cleanup.push(() => s.close());
    return s;
  };
  return { s: reopen(), reopen };
}
const child = (objective: string) => ({ role: "collaborator" as const, objective });

test("two occupied slots are released only after native termination; fan-in resumes once across restart", () => {
  const { s, reopen } = open();
  s.root("root");
  const request = { requestId: "initial", fromNodeId: "root", children: [child("A"), child("B")] };
  const [a, b] = s.recruit(request);
  expect(s.recruit(request)).toEqual([a, b]);
  const la = s.take()!,
    lb = s.take()!;
  expect([la.nodeId, lb.nodeId]).toEqual([a, b]);
  s.checkpoint({ nodeId: a, runId: la.runId, summary: "A checkpoint", sessionRef: "native A", toolTurns: 3 });
  const [c, d] = s.recruit({ requestId: "nested", fromNodeId: a, runId: la.runId, children: [child("C"), child("D")] });
  const restarted = reopen();
  expect(restarted.take()).toBeNull();
  restarted.release(a, la.runId);
  const lc = restarted.take()!;
  expect(lc.nodeId).toBe(c);
  restarted.finish({ nodeId: c, runId: lc.runId, summary: "C result" });
  expect(restarted.takeRoot("root")).toBeNull();
  const ld = restarted.take()!;
  expect(ld.nodeId).toBe(d);
  restarted.finish({ nodeId: d, runId: ld.runId, summary: "D result" });
  const resumed = restarted.take()!;
  expect(resumed).toMatchObject({ nodeId: a, sessionRef: "native A", remainingToolTurns: 5, summary: "A checkpoint" });
  expect(resumed.runId).not.toBe(la.runId);
  expect(resumed.receipts.map((r) => r.summary)).toEqual(["C result", "D result"]);
  expect(() => restarted.finish({ nodeId: a, runId: la.runId, summary: "late" })).toThrow();
  restarted.finish({ nodeId: a, runId: resumed.runId, summary: "A result" });
  restarted.finish({ nodeId: b, runId: lb.runId, summary: "B result" });
  restarted.finish({ nodeId: b, runId: lb.runId, summary: "B result" });
  const back = restarted.takeRoot("root")!;
  expect(back.receipts.map((r) => r.summary)).toEqual(["A result", "B result"]);
  expect(restarted.takeRoot("root")).toBeNull();
});

test("depth and batch bounds, immutable code package restriction, and absolute dependency timeout", () => {
  const { s } = open();
  s.root("r");
  expect(() =>
    s.recruit({ requestId: "big", fromNodeId: "r", children: [child("1"), child("2"), child("3")] }),
  ).toThrow();
  const [a, b] = s.recruit({
    requestId: "a",
    fromNodeId: "r",
    children: [child("a"), { ...child("b"), codePackage: true }],
  });
  const la = s.take()!,
    lb = s.take()!;
  expect(() =>
    s.recruit({ requestId: "leaf", fromNodeId: b, runId: lb.runId, children: [child("forbidden")] }),
  ).toThrow();
  expect(() =>
    s.recruit({
      requestId: "research",
      fromNodeId: a,
      runId: la.runId,
      children: [{ role: "researcher", objective: "new research" }],
    }),
  ).toThrow();
  const [c] = s.recruit({ requestId: "c", fromNodeId: a, runId: la.runId, children: [child("c")] });
  s.release(a, la.runId);
  const lc = s.take()!;
  const [d] = s.recruit({ requestId: "d", fromNodeId: c, runId: lc.runId, children: [child("d")], deadlineMs: 700 });
  s.release(c, lc.runId);
  const ld = s.take()!;
  expect(ld.nodeId).toBe(d);
  expect(() => s.recruit({ requestId: "deep", fromNodeId: d, runId: ld.runId, children: [child("depth4")] })).toThrow();
  s.expire(701);
  s.finish({ nodeId: d, runId: ld.runId, summary: "late D" });
  const post = s.take()!;
  expect(post.nodeId).toBe(c);
  expect(post.receipts[0].status).toBe("timeout");
  expect(s.take()).toBeNull();
});

test("a resumed attempt outranks deep work and deep work outranks another root's fresh child", () => {
  const { s } = open();
  s.root("r1");
  s.root("r2");
  const [a, b] = s.recruit({ fromNodeId: "r1", requestId: "r1-batch", children: [child("A"), child("B")] });
  s.recruit({ fromNodeId: "r2", requestId: "r2-batch", children: [child("fresh")] });
  const la = s.take()!,
    lb = s.take()!;
  const [c] = s.recruit({ fromNodeId: a, runId: la.runId, requestId: "C", children: [child("C")] });
  const [d] = s.recruit({ fromNodeId: b, runId: lb.runId, requestId: "D", children: [child("D")] });
  s.release(a, la.runId);
  s.release(b, lb.runId);
  const lc = s.take()!;
  expect(lc.nodeId).toBe(c);
  s.finish({ nodeId: c, runId: lc.runId, summary: "done" });
  expect(s.take()?.nodeId).toBe(a);
  expect(s.take()?.nodeId).toBe(d);
  expect(s.take()).toBeNull();
});
