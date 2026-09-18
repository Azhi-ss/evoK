import { describe, expect, test } from "bun:test";
import { DAGScheduler, DeterministicScheduler, MissionQueue, PolicyGuard, type DagTask, type DagTaskResult } from "../toy-harness";

const guard = new PolicyGuard({
  maxBranchWidth: 1,
  maxAttempts: 1,
  maxBranchBudget: 1,
  permissions: [],
  resources: [],
  mandatoryVerificationGates: [],
});

function artifact(taskId: string): DagTaskResult {
  return {
    status: "COMPLETED",
    artifacts: [Object.freeze({
      artifactId: `${taskId}-artifact`,
      taskId,
      address: `artifact://${taskId}`,
      digest: `${taskId}:digest`,
    })],
  };
}

describe("DAG scheduler", () => {
  test("bounds the ready selection without hiding a later startable task", async () => {
    const scheduler = new DAGScheduler({
      missionId: "ready-selection",
      maxParallelTasks: 1,
      maxReadyTasks: 1,
      budget: 1,
      tasks: [
        { taskId: "too-expensive", budget: 2, execute: () => artifact("too-expensive") },
        { taskId: "available", budget: 1, execute: () => artifact("available") },
      ],
    });

    expect(scheduler.readySet()).toEqual(["available"]);
    const result = await scheduler.run();
    expect(result.tasks.available.status).toBe("COMPLETED");
    expect(result.tasks["too-expensive"].status).toBe("BLOCKED");
  });

  test("runs independent ready tasks in parallel", async () => {
    const started: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const task = (taskId: string): DagTask => ({
      taskId,
      execute: async () => {
        started.push(taskId);
        await gate;
        return artifact(taskId);
      },
    });
    const scheduler = new DAGScheduler({
      missionId: "parallel",
      tasks: [task("a"), task("b")],
      maxParallelTasks: 2,
    });

    const running = scheduler.run();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(started).toEqual(["a", "b"]);
    release();

    const result = await running;
    expect(result.tasks.a.status).toBe("COMPLETED");
    expect(result.tasks.b.status).toBe("COMPLETED");
  });

  test("matches required artifacts by artifact id rather than task id", async () => {
    const result = await new DAGScheduler({
      missionId: "artifact-id",
      tasks: [
        { taskId: "source", execute: () => artifact("source") },
        {
          taskId: "join",
          dependencies: ["source"],
          requiredArtifacts: ["source"],
          joinPolicy: { required: ["source"], optional: [], quorum: 1, timeoutMs: 100, terminalFailure: true },
          reducer: () => artifact("join"),
        },
      ],
    }).run();

    expect(result.tasks.join.status).toBe("BLOCKED");
    expect(result.joins.join.closed).toBe(true);
  });

  test("does not release a join when a required dependency has no artifact", async () => {
    const started: string[] = [];
    const scheduler = new DAGScheduler({
      missionId: "missing-artifact",
      tasks: [
        { taskId: "a", execute: () => { started.push("a"); return { status: "COMPLETED" }; } },
        { taskId: "b", execute: () => { started.push("b"); return artifact("b"); } },
        {
          taskId: "join",
          dependencies: ["a", "b"],
          joinPolicy: { required: ["a", "b"], optional: [], quorum: 2, timeoutMs: 100, terminalFailure: true },
          execute: () => { started.push("join"); return artifact("join"); },
        },
      ],
      maxParallelTasks: 2,
    });

    const result = await scheduler.run();
    expect(started).toEqual(["a", "b"]);
    expect(result.tasks.join.status).toBe("BLOCKED");
    expect(result.joins.join.closed).toBe(true);
    expect(result.events.some((event) => event.type === "JOIN_CLOSED" && event.taskId === "join")).toBe(true);
  });

  test("requires an explicit JoinPolicy for dependent tasks", () => {
    expect(() => new DAGScheduler({
      missionId: "explicit-join-policy",
      tasks: [
        { taskId: "source", execute: () => artifact("source") },
        { taskId: "downstream", dependencies: ["source"], execute: () => artifact("downstream") },
      ],
    })).toThrow("requires an explicit join policy");
  });

  test("releases a join only after required dependency artifacts arrive", async () => {
    const started: string[] = [];
    let releaseA!: () => void;
    let releaseB!: () => void;
    const gateA = new Promise<void>((resolve) => { releaseA = resolve; });
    const gateB = new Promise<void>((resolve) => { releaseB = resolve; });
    const source = (taskId: string, gate: Promise<void>): DagTask => ({
      taskId,
      execute: async () => {
        started.push(taskId);
        await gate;
        return artifact(taskId);
      },
    });
    const scheduler = new DAGScheduler({
      missionId: "join",
      maxParallelTasks: 2,
      tasks: [
        source("a", gateA),
        source("b", gateB),
        {
          taskId: "join",
          dependencies: ["a", "b"],
          joinPolicy: { required: ["a", "b"], optional: [], quorum: 2, timeoutMs: 100, terminalFailure: true },
          reducer: (input) => {
            started.push("join");
            expect([...input.artifacts].map((value) => value.taskId)).toEqual(["a", "b"]);
            return artifact("join");
          },
        },
      ],
    });

    const running = scheduler.run();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(started).toEqual(["a", "b"]);
    releaseA();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(started).toEqual(["a", "b"]);
    releaseB();

    const result = await running;
    expect(started).toEqual(["a", "b", "join"]);
    expect(result.tasks.join.status).toBe("COMPLETED");
    expect(result.events.some((event) => event.type === "JOIN_RELEASED" && event.taskId === "join")).toBe(true);
  });

  test("keeps failed and quarantined tasks isolated from an unrelated dependency chain", async () => {
    const started: string[] = [];
    const scheduler = new DAGScheduler({
      missionId: "isolated-failure",
      maxParallelTasks: 2,
      tasks: [
        { taskId: "failed", execute: () => { started.push("failed"); return { status: "FAILED", error: "worker error" }; } },
        { taskId: "good", execute: () => { started.push("good"); return artifact("good"); } },
        {
          taskId: "downstream",
          dependencies: ["good"],
          joinPolicy: { required: ["good"], optional: [], quorum: 1, timeoutMs: 100, terminalFailure: true },
          execute: () => { started.push("downstream"); return artifact("downstream"); },
        },
        { taskId: "quarantined", execute: () => { started.push("quarantined"); return { status: "QUARANTINED", objections: ["unsafe"] }; } },
      ],
    });

    const result = await scheduler.run();
    expect(started).toEqual(["failed", "good", "quarantined", "downstream"]);
    expect(result.tasks.failed).toMatchObject({ status: "FAILED", error: "worker error" });
    expect(result.tasks.quarantined).toMatchObject({ status: "QUARANTINED", objections: ["unsafe"] });
    expect(result.tasks.good.status).toBe("COMPLETED");
    expect(result.tasks.downstream.status).toBe("COMPLETED");
  });

  test("does not auto-retry a terminal Task failure", async () => {
    let attempts = 0;
    const result = await new DAGScheduler({
      missionId: "terminal-failure",
      tasks: [{
        taskId: "failed",
        maxAttempts: 2,
        execute: () => {
          attempts += 1;
          return { status: "FAILED", error: "terminal" };
        },
      }],
    }).run();

    expect(attempts).toBe(1);
    expect(result.tasks.failed).toMatchObject({ status: "FAILED", attempt: 1, error: "terminal" });
  });

  test("repairs a task with a fresh attempt without disturbing completed siblings", async () => {
    let attempts = 0;
    const scheduler = new DAGScheduler({
      missionId: "repair",
      maxParallelTasks: 2,
      tasks: [
        {
          taskId: "repairable",
          maxAttempts: 2,
          execute: () => {
            attempts += 1;
            return attempts === 1 ? { status: "REPAIR", objections: ["retry"] } : artifact("repairable");
          },
        },
        { taskId: "sibling", execute: () => artifact("sibling") },
        {
          taskId: "after",
          dependencies: ["repairable"],
          joinPolicy: { required: ["repairable"], optional: [], quorum: 1, timeoutMs: 100, terminalFailure: true },
          execute: () => artifact("after"),
        },
      ],
    });

    const result = await scheduler.run();
    expect(attempts).toBe(2);
    expect(result.tasks.repairable).toMatchObject({ status: "COMPLETED", attempt: 2 });
    expect(result.tasks.sibling.status).toBe("COMPLETED");
    expect(result.tasks.after.status).toBe("COMPLETED");
    expect(result.tasks.repairable.runId).toBe("repair:repairable:run-2");
  });

  test("does not reserve artifacts from a repair attempt", async () => {
    let attempts = 0;
    const result = await new DAGScheduler({
      missionId: "repair-artifact",
      tasks: [{
        taskId: "task",
        maxAttempts: 2,
        execute: () => {
          attempts += 1;
          return attempts === 1
            ? { status: "REPAIR", artifacts: [artifact("task").artifacts![0]!] }
            : artifact("task");
        },
      }],
    }).run();

    expect(attempts).toBe(2);
    expect(result.tasks.task).toMatchObject({ status: "COMPLETED", attempt: 2 });
    expect(result.tasks.task.artifact?.artifactId).toBe("task-artifact");
  });

  test("closes when a required member lacks evidence even if optional quorum is met", async () => {
    const result = await new DAGScheduler({
      missionId: "required-evidence",
      maxParallelTasks: 2,
      tasks: [
        { taskId: "required", execute: () => ({ status: "COMPLETED" }) },
        { taskId: "optional", execute: () => artifact("optional") },
        {
          taskId: "join",
          dependencies: ["required", "optional"],
          joinPolicy: { required: ["required"], optional: ["optional"], quorum: 1, timeoutMs: 100, terminalFailure: true },
          reducer: () => artifact("join"),
        },
      ],
    }).run();

    expect(result.tasks.join.status).toBe("BLOCKED");
    expect(result.joins.join.closed).toBe(true);
  });

  test("uses optional join members toward quorum without treating their failure as required", async () => {
    const started: string[] = [];
    const scheduler = new DAGScheduler({
      missionId: "optional-quorum",
      maxParallelTasks: 3,
      tasks: [
        { taskId: "required", execute: () => artifact("required") },
        { taskId: "failed-optional", execute: () => ({ status: "FAILED", error: "unavailable" }) },
        { taskId: "available-optional", execute: () => artifact("available-optional") },
        {
          taskId: "join",
          dependencies: ["required", "failed-optional", "available-optional"],
          joinPolicy: { required: ["required"], optional: ["failed-optional", "available-optional"], quorum: 2, timeoutMs: 100, terminalFailure: true },
          reducer: () => { started.push("join"); return artifact("join"); },
        },
      ],
    });

    const result = await scheduler.run();
    expect(started).toEqual(["join"]);
    expect(result.tasks.join.status).toBe("COMPLETED");
    expect(result.status).toBe("COMPLETED");
    expect(result.joins.join.released).toBe(true);
    expect(result.tasks["failed-optional"].status).toBe("FAILED");
  });

  test("serializes conflicting resources and write scopes while consuming the shared budget", async () => {
    const active = new Set<string>();
    let maxActive = 0;
    const order: string[] = [];
    const task = (taskId: string, resources: readonly string[], writeScope: string): DagTask => ({
      taskId,
      resources,
      writeScopes: [writeScope],
      budget: 1,
      execute: async () => {
        order.push(`start:${taskId}`);
        active.add(taskId);
        maxActive = Math.max(maxActive, active.size);
        await new Promise((resolve) => setTimeout(resolve, 5));
        active.delete(taskId);
        order.push(`end:${taskId}`);
        return artifact(taskId);
      },
    });
    const scheduler = new DAGScheduler({
      missionId: "limits",
      tasks: [task("a", ["cpu"], "shared"), task("b", ["cpu"], "shared"), task("c", ["gpu"], "other")],
      maxParallelTasks: 3,
      resourceLimits: { cpu: 1, gpu: 1 },
      budget: 3,
    });

    const result = await scheduler.run();
    expect(result.status).toBe("COMPLETED");
    expect(maxActive).toBe(2);
    expect(order.indexOf("end:a") < order.indexOf("start:b") || order.indexOf("end:b") < order.indexOf("start:a")).toBe(true);
    expect(result.remainingBudget).toBe(0);
  });

  test("closes a join when the remaining budget cannot produce its quorum", async () => {
    const scheduler = new DAGScheduler({
      missionId: "join-budget",
      budget: 1,
      maxParallelTasks: 1,
      tasks: [
        { taskId: "a", budget: 1, execute: () => artifact("a") },
        { taskId: "b", budget: 1, execute: () => artifact("b") },
        {
          taskId: "join",
          dependencies: ["a", "b"],
          joinPolicy: { required: ["a", "b"], optional: [], quorum: 2, timeoutMs: 100, terminalFailure: true },
          reducer: () => artifact("join"),
        },
      ],
    });

    const result = await scheduler.run();
    expect(result.tasks.a.status).toBe("COMPLETED");
    expect(result.tasks.b.status).toBe("BLOCKED");
    expect(result.tasks.join.status).toBe("BLOCKED");
    expect(result.joins.join.closed).toBe(true);
  });

  test("validates DAG identity, dependency, join, resource, and concurrency limits", () => {
    const run = () => artifact("a");
    expect(() => new DAGScheduler({ missionId: "duplicate", tasks: [{ taskId: "a", execute: run }, { taskId: "a", execute: run }] })).toThrow();
    expect(() => new DAGScheduler({ missionId: "unknown", tasks: [{ taskId: "a", dependencies: ["missing"], joinPolicy: { required: ["missing"], optional: [], quorum: 1, timeoutMs: 1, terminalFailure: true }, execute: run }] })).toThrow();
    expect(() => new DAGScheduler({ missionId: "cycle", tasks: [
      { taskId: "a", dependencies: ["b"], joinPolicy: { required: ["b"], optional: [], quorum: 1, timeoutMs: 1, terminalFailure: true }, execute: run },
      { taskId: "b", dependencies: ["a"], joinPolicy: { required: ["a"], optional: [], quorum: 1, timeoutMs: 1, terminalFailure: true }, execute: run },
    ] })).toThrow();
    expect(() => new DAGScheduler({ missionId: "parallel-limit", maxParallelTasks: 0, tasks: [{ taskId: "a", execute: run }] })).toThrow();
    expect(() => new DAGScheduler({ missionId: "ready-limit", maxReadyTasks: 0, tasks: [{ taskId: "a", execute: run }] })).toThrow();
    expect(() => new DAGScheduler({ missionId: "join-policy", tasks: [
      { taskId: "a", execute: run },
      { taskId: "b", execute: run },
      { taskId: "join", dependencies: ["a", "b"], joinPolicy: { required: ["a"], optional: [], quorum: 1, timeoutMs: 1, terminalFailure: true }, execute: run },
    ] })).toThrow();
    expect(() => new DAGScheduler({ missionId: "resource", resources: ["cpu"], tasks: [{ taskId: "a", resources: ["gpu"], execute: run }] })).toThrow();
    expect(() => new DAGScheduler({ missionId: "proto-resource", tasks: [{ taskId: "a", resources: ["__proto__", "__proto__"], execute: run }] })).toThrow("capacity");
  });

  test("rejects non-string result statuses at the executor boundary", async () => {
    const result = await new DAGScheduler({
      missionId: "invalid-status",
      tasks: [{ taskId: "task", execute: () => ({ status: new String("COMPLETED") as unknown as "COMPLETED" }) }],
    }).run();

    expect(result.tasks.task).toMatchObject({ status: "FAILED", error: "invalid task result status" });
  });

  test("rejects contradictory task and branch artifact ownership", async () => {
    const result = await new DAGScheduler({
      missionId: "contradictory-owner",
      tasks: [{
        taskId: "task",
        execute: () => ({
          status: "COMPLETED",
          artifacts: [{ artifactId: "artifact", taskId: "task", branchId: "other", address: "artifact://task", digest: "task:digest" }],
        }),
      }],
    }).run();

    expect(result.tasks.task).toMatchObject({ status: "FAILED", error: "task artifact belongs to another task" });
  });

  test("treats a missing executor as a task-scoped failure", async () => {
    const result = await new DAGScheduler({
      missionId: "missing-executor",
      maxParallelTasks: 2,
      tasks: [
        { taskId: "missing" },
        { taskId: "available", execute: () => artifact("available") },
      ],
    }).run();

    expect(result.tasks.missing).toMatchObject({ status: "FAILED", error: "task missing has no executor or reducer" });
    expect(result.tasks.available.status).toBe("COMPLETED");
    expect(result.status).toBe("STOPPED");
  });

  test("enforces the global budget and workspace ownership cap", async () => {
    const started: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const scheduler = new DAGScheduler({
      missionId: "budget-workspace",
      maxParallelTasks: 2,
      maxWorkspaceOwners: 1,
      budget: 2,
      tasks: [
        { taskId: "first", budget: 1, workspaceId: "owned", execute: async () => { started.push("first"); await gate; return artifact("first"); } },
        { taskId: "second", budget: 1, workspaceId: "owned", execute: () => { started.push("second"); return artifact("second"); } },
        { taskId: "over-budget", budget: 1, execute: () => { started.push("over-budget"); return artifact("over-budget"); } },
      ],
    });

    const running = scheduler.run();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(started).toEqual(["first"]);
    release();
    const result = await running;
    expect(started).toEqual(["first", "second"]);
    expect(result.tasks["over-budget"].status).toBe("BLOCKED");
    expect(result.remainingBudget).toBe(0);
  });

  test("keeps a non-terminal timed-out join open for a late completion", async () => {
    const scheduler = new DAGScheduler({
      missionId: "non-terminal-timeout",
      maxParallelTasks: 1,
      tasks: [
        {
          taskId: "slow",
          execute: async () => {
            await new Promise((resolve) => setTimeout(resolve, 10));
            return artifact("slow");
          },
        },
        {
          taskId: "join",
          dependencies: ["slow"],
          joinPolicy: { required: ["slow"], optional: [], quorum: 1, timeoutMs: 1, terminalFailure: false },
          reducer: () => artifact("join"),
        },
      ],
    });

    const result = await scheduler.run();
    expect(result.tasks.slow.status).toBe("COMPLETED");
    expect(result.tasks.join.status).toBe("COMPLETED");
    expect(result.joins.join).toMatchObject({ released: true, closed: false, timedOut: true });
  });

  test("keeps a non-terminal failed join unresolved", async () => {
    const result = await new DAGScheduler({
      missionId: "non-terminal-failure",
      tasks: [
        { taskId: "failed", execute: () => ({ status: "FAILED", error: "unavailable" }) },
        {
          taskId: "join",
          dependencies: ["failed"],
          joinPolicy: { required: ["failed"], optional: [], quorum: 1, timeoutMs: 5, terminalFailure: false },
          reducer: () => artifact("join"),
        },
      ],
    }).run();

    expect(result.tasks.join.status).toBe("QUEUED");
    expect(result.joins.join).toMatchObject({ released: false, closed: false });
    expect(result.events.some((event) => event.type === "JOIN_CLOSED" && event.taskId === "join")).toBe(false);
  });

  test("closes a timed-out join and fences the unfinished required task", async () => {
    const scheduler = new DAGScheduler({
      missionId: "timeout",
      maxParallelTasks: 2,
      tasks: [
        {
          taskId: "slow",
          execute: async () => {
            await new Promise((resolve) => setTimeout(resolve, 25));
            return artifact("slow");
          },
        },
        { taskId: "fast", execute: () => artifact("fast") },
        {
          taskId: "join",
          dependencies: ["slow", "fast"],
          joinPolicy: { required: ["slow", "fast"], optional: [], quorum: 2, timeoutMs: 5, terminalFailure: true },
          reducer: () => artifact("join"),
        },
      ],
    });

    const result = await scheduler.run();
    expect(result.tasks.slow.status).toBe("FAILED");
    expect(result.tasks.slow.error).toBe("join timed out");
    expect(result.tasks.fast.status).toBe("COMPLETED");
    expect(result.tasks.join.status).toBe("BLOCKED");
    expect(result.joins.join).toMatchObject({ closed: true, timedOut: true });
  });

  test("times out a lone running required dependency", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const running = new DAGScheduler({
      missionId: "lone-timeout",
      tasks: [
        { taskId: "slow", execute: async () => { await gate; return artifact("slow"); } },
        {
          taskId: "join",
          dependencies: ["slow"],
          joinPolicy: { required: ["slow"], optional: [], quorum: 1, timeoutMs: 5, terminalFailure: true },
          reducer: () => artifact("join"),
        },
      ],
    }).run();
    setTimeout(release, 30);

    const result = await running;
    expect(result.tasks.slow).toMatchObject({ status: "FAILED", error: "join timed out" });
    expect(result.tasks.join.status).toBe("BLOCKED");
    expect(result.joins.join).toMatchObject({ closed: true, timedOut: true });
  });

  test("keeps timed-out task reservations until the run settles", async () => {
    const started: string[] = [];
    let releaseSlow!: () => void;
    const slowGate = new Promise<void>((resolve) => { releaseSlow = resolve; });
    const scheduler = new DAGScheduler({
      missionId: "timeout-reservation",
      maxParallelTasks: 2,
      resourceLimits: { cpu: 1 },
      tasks: [
        {
          taskId: "slow",
          resources: ["cpu"],
          execute: async () => {
            started.push("slow:start");
            await slowGate;
            started.push("slow:end");
            return artifact("slow");
          },
        },
        { taskId: "trigger", execute: () => artifact("trigger") },
        { taskId: "conflicting", resources: ["cpu"], execute: () => { started.push("conflicting:start"); return artifact("conflicting"); } },
        {
          taskId: "join",
          dependencies: ["slow", "trigger"],
          joinPolicy: { required: ["slow", "trigger"], optional: [], quorum: 2, timeoutMs: 5, terminalFailure: true },
          reducer: () => artifact("join"),
        },
      ],
    });

    const running = scheduler.run();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(scheduler.events().some((event) => event.type === "TASK_FAILED" && event.taskId === "slow")).toBe(true);
    expect(started).not.toContain("conflicting:start");
    releaseSlow();

    const result = await running;
    expect(started.indexOf("slow:end")).toBeLessThan(started.indexOf("conflicting:start"));
    expect(result.tasks.conflicting.status).toBe("COMPLETED");
  });

  test("does not start queued required work after its join times out", async () => {
    let queuedStarted = false;
    const result = await new DAGScheduler({
      missionId: "timeout-queued",
      maxParallelTasks: 1,
      tasks: [
        {
          taskId: "slow",
          execute: async () => {
            await new Promise((resolve) => setTimeout(resolve, 25));
            return artifact("slow");
          },
        },
        { taskId: "queued", execute: () => { queuedStarted = true; return artifact("queued"); } },
        {
          taskId: "join",
          dependencies: ["slow", "queued"],
          joinPolicy: { required: ["slow", "queued"], optional: [], quorum: 2, timeoutMs: 5, terminalFailure: true },
          reducer: () => artifact("join"),
        },
      ],
    }).run();

    expect(queuedStarted).toBe(false);
    expect(result.tasks.queued).toMatchObject({ status: "BLOCKED", attempt: 0, error: "join timed out" });
    expect(result.tasks.join.status).toBe("BLOCKED");
  });

  test("fences optional members of a timed-out join too", async () => {
    let optionalStarted = false;
    const result = await new DAGScheduler({
      missionId: "timeout-optional",
      maxParallelTasks: 1,
      tasks: [
        {
          taskId: "slow",
          execute: async () => {
            await new Promise((resolve) => setTimeout(resolve, 25));
            return artifact("slow");
          },
        },
        { taskId: "optional", execute: () => { optionalStarted = true; return artifact("optional"); } },
        {
          taskId: "join",
          dependencies: ["slow", "optional"],
          joinPolicy: { required: ["slow"], optional: ["optional"], quorum: 2, timeoutMs: 5, terminalFailure: true },
          reducer: () => artifact("join"),
        },
      ],
    }).run();

    expect(optionalStarted).toBe(false);
    expect(result.tasks.optional).toMatchObject({ status: "BLOCKED", attempt: 0, error: "join timed out" });
    expect(result.tasks.join.status).toBe("BLOCKED");
  });

  test("serializes DAG missions through the coordinator mission queue", async () => {
    const order: string[] = [];
    const coordinator = new DeterministicScheduler(guard);
    const mission = (missionId: string) => ({
      missionId,
      maxParallelTasks: 1,
      tasks: [{
        taskId: "task",
        execute: async () => {
          order.push(`start:${missionId}`);
          await new Promise((resolve) => setTimeout(resolve, 5));
          order.push(`end:${missionId}`);
          return artifact("task");
        },
      }],
    });

    const first = coordinator.runDag(mission("dag-a"));
    const second = coordinator.runDag(mission("dag-b"));
    await Promise.all([first, second]);

    expect(order).toEqual(["start:dag-a", "end:dag-a", "start:dag-b", "end:dag-b"]);
  });

  test("rejects malformed mission queue entries without throwing synchronously", async () => {
    const queue = new MissionQueue<string>();
    const invalid = queue.enqueue(null as unknown as { missionId: string; run: () => string });

    await expect(invalid).rejects.toThrow("mission queue tasks require a missionId and run function");
    expect(queue.size()).toBe(0);
  });

  test("runs queued missions sequentially even when each mission has internal parallelism", async () => {
    const order: string[] = [];
    const queue = new MissionQueue<string>();
    const first = queue.enqueue("mission-a", async () => {
      order.push("start:a");
      await new Promise((resolve) => setTimeout(resolve, 5));
      order.push("end:a");
      return "a";
    });
    const second = queue.enqueue("mission-b", () => {
      order.push("start:b");
      return "b";
    });

    const results = await queue.drain();
    expect(results).toEqual(["a", "b"]);
    expect(await first).toBe("a");
    expect(await second).toBe("b");
    expect(order).toEqual(["start:a", "end:a", "start:b"]);
  });

  test("can drain an empty mission queue before enqueuing work", async () => {
    const queue = new MissionQueue<string>();
    expect(await queue.drain()).toEqual([]);

    queue.enqueue("later", () => "later");
    expect(await queue.drain()).toEqual(["later"]);
    expect(queue.size()).toBe(0);
  });
});
