import { expect, test } from "bun:test";
import { CollaborationScheduler } from "./collaboration-scheduler";
const child = (objective: string) => ({ role: "collaborator" as const, objective });

test("completed nodes answer targeted questions without changing their original result; target quota is shared", () => {
  const s = new CollaborationScheduler(":memory:");
  try {
    s.root("r");
    const [a, b] = s.recruit({ requestId: "init", fromNodeId: "r", children: [child("a"), child("b")] });
    const la = s.take()!,
      lb = s.take()!;
    s.finish({
      nodeId: b,
      runId: lb.runId,
      summary: "original B",
      sessionRef: "B native session",
      toolTurns: 2,
    });
    let sender = la;
    for (let i = 0; i < 2; i++) {
      const q = {
        fromNodeId: a,
        runId: sender.runId,
        requestId: "ask" + i,
        targetNodeId: b,
        question: "cite " + i,
      };
      const id = s.communicate(q);
      expect(s.communicate(q)).toBe(id);
      s.release(a, sender.runId);
      const ans = s.take()!;
      expect(ans).toMatchObject({
        nodeId: b,
        kind: "answer",
        question: q.question,
        questionFrom: a,
        sessionRef: "B native session",
        remainingToolTurns: 6 - i,
      });
      s.finish({ nodeId: b, runId: ans.runId, summary: "citation " + i, toolTurns: 1 });
      sender = s.take()!;
      expect(sender.nodeId).toBe(a);
      expect(sender.receipts[0].summary).toBe("citation " + i);
    }
    expect(() =>
      s.communicate({
        fromNodeId: a,
        runId: sender.runId,
        requestId: "third",
        targetNodeId: b,
        question: "again",
      }),
    ).toThrow(/limit/);
    s.finish({ nodeId: a, runId: sender.runId, summary: "original A" });
    expect(s.takeRoot("r")!.receipts.map((r) => r.summary)).toEqual(["original A", "original B"]);
  } finally {
    s.close();
  }
});

test("reject waits on an ancestor or reciprocal sender; timeout, late reply and retirement never reawaken prior caller", () => {
  const s = new CollaborationScheduler(":memory:");
  try {
    s.root("r");
    const [a, b] = s.recruit({ requestId: "begin", fromNodeId: "r", children: [child("a"), child("b")] });
    const la = s.take()!,
      lb = s.take()!;
    expect(() =>
      s.communicate({ fromNodeId: a, runId: la.runId, requestId: "up", targetNodeId: "r", question: "wait" }),
    ).toThrow(/cycle/);
    s.communicate({
      fromNodeId: a,
      runId: la.runId,
      requestId: "ab",
      targetNodeId: b,
      question: "why",
      deadlineMs: 100,
    });
    s.release(a, la.runId);
    expect(() =>
      s.communicate({
        fromNodeId: b,
        runId: lb.runId,
        requestId: "ba",
        targetNodeId: a,
        question: "and why",
      }),
    ).toThrow(/cycle/);
    s.finish({ nodeId: b, runId: lb.runId, summary: "B result" });
    const answering = s.take()!;
    expect(answering.kind).toBe("answer");
    s.expire(100);
    const resumed = s.take()!;
    expect(resumed.nodeId).toBe(a);
    expect(resumed.receipts[0].status).toBe("timeout");
    s.finish({ nodeId: b, runId: answering.runId, summary: "late answer" });
    expect(s.take()).toBeNull();
    s.retire(b, "done");
    expect(() =>
      s.communicate({
        fromNodeId: a,
        runId: resumed.runId,
        requestId: "ret",
        targetNodeId: b,
        question: "one more",
      }),
    ).toThrow(/retired/);
  } finally {
    s.close();
  }
});

test("a parent concluding seals its descendants but preserves their deliveries; cross-root messages cannot reopen them", () => {
  const s = new CollaborationScheduler(":memory:");
  try {
    s.root("r");
    s.root("other");
    const [a, b] = s.recruit({
      fromNodeId: "r",
      requestId: "start",
      children: [child("branch A"), child("branch B")],
    });
    const la = s.take()!,
      lb = s.take()!;
    const [c] = s.recruit({ fromNodeId: a, runId: la.runId, requestId: "child", children: [child("C")] });
    s.release(a, la.runId);
    const lc = s.take()!;
    s.finish({ nodeId: c, runId: lc.runId, summary: "original C" });
    const resumed = s.take()!;
    s.finish({ nodeId: a, runId: resumed.runId, summary: "original A" });
    expect(s.snapshot().nodes.find((n) => n.nodeId === c)).toMatchObject({
      state: "retired",
      result: { summary: "original C" },
    });
    expect(() =>
      s.communicate({
        fromNodeId: b,
        runId: lb.runId,
        requestId: "late",
        targetNodeId: c,
        question: "still around?",
      }),
    ).toThrow(/retired/);
    expect(() =>
      s.communicate({ fromNodeId: "other", requestId: "cross", targetNodeId: a, question: "outside" }),
    ).toThrow(/crosses/);
    s.finish({ nodeId: b, runId: lb.runId, summary: "B" });
    const root = s.takeRoot("r")!;
    s.finish({ nodeId: "r", runId: root.runId, summary: "round done" });
    expect(
      s
        .snapshot()
        .nodes.filter((n) => n.rootId === "r" && n.depth)
        .map((n) => n.state),
    ).toEqual(["retired", "retired", "retired"]);
    expect(() => s.finish({ nodeId: c, runId: lc.runId, summary: "rewritten" })).toThrow(/conflicting/);
    expect(s.finish({ nodeId: c, runId: lc.runId, summary: "original C" }).summary).toBe("original C");
  } finally {
    s.close();
  }
});

test("different root pumps share a priority window and cannot steal the last slot from resumed or deeper work", () => {
  const s = new CollaborationScheduler(":memory:");
  try {
    s.root("r1");
    s.root("r2");
    const [a] = s.recruit({ fromNodeId: "r1", requestId: "a", children: [child("a")] });
    s.recruit({ fromNodeId: "r2", requestId: "b", children: [child("b"), child("c")] });
    const la = s.take("r1")!,
      b = s.take("r2")!;
    s.recruit({ fromNodeId: a, runId: la.runId, requestId: "nested", children: [child("depth2")] });
    s.release(a, la.runId);
    expect(s.take("r2")).toBeNull();
    const deep = s.take("r1")!;
    expect(deep.depth).toBe(2);
    s.finish({ nodeId: deep.nodeId, runId: deep.runId, summary: "done" });
    expect(s.take("r2")).toBeNull();
    expect(s.take("r1")?.nodeId).toBe(a);
    expect(s.take()).toBeNull();
    s.finish({ nodeId: b.nodeId, runId: b.runId, summary: "b" });
    expect(s.take("r2")!.task).toBe("c");
  } finally {
    s.close();
  }
});
