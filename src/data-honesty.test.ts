import { describe, expect, test } from "bun:test";
import {
  ScoreFileToyCompetitionAdapter,
  ToyCompetitionHarness,
  type ToyAgentRuntime,
} from "./toy-harness";
import {
  LeakageViolation,
  auditCandidateFiles,
  resolveDataHonestyContract,
  type DataHonestyContract,
} from "./data-honesty";

const prediction = {
  predictionId: "honesty-prediction",
  hypothesis: "the candidate improves the score honestly",
  expectedObservation: "the evaluator returns the candidate score",
  expectedObservations: ["the evaluator returns the candidate score"],
  failureModes: ["the score does not improve"],
} as const;

const contract = { objective: "maximize" };
const policy = { maxBranches: 1, maxParallelBranches: 1, maxAttempts: 3, quorum: 1 };

/** A fixture adapter that declares the data honesty contract on the adapter/evaluation contract face. */
class HonestAdapter extends ScoreFileToyCompetitionAdapter {
  readonly honesty: DataHonestyContract;
  constructor(honesty: DataHonestyContract) {
    super("score");
    this.honesty = honesty;
  }
  leakage_audit(): DataHonestyContract["leakage_audit"] {
    return this.honesty.leakage_audit;
  }
  test_signal_policy(): DataHonestyContract["test_signal_policy"] {
    return this.honesty.test_signal_policy;
  }
}

const forbidContract: DataHonestyContract = {
  leakage_audit: { protectedPaths: ["test.csv", "private/solution.csv"], goldLabels: [0, 1, 1, 0, 1] },
  test_signal_policy: { mode: "forbid", testSignals: ["kaggle_submission.csv", "leaderboard", "private_score"] },
};

const discloseContract: DataHonestyContract = {
  leakage_audit: { protectedPaths: ["test.csv", "private/solution.csv"], goldLabels: [0, 1, 1, 0, 1] },
  test_signal_policy: { mode: "disclose_only", testSignals: ["kaggle_submission.csv", "leaderboard"] },
};

function runtime(files: Record<string, string>): ToyAgentRuntime {
  return {
    selfVerify: () => ({ ok: true }),
    propose: () => ({ files }),
    falsify: () => ({ ok: true, objections: [] }),
  };
}

function mission(missionId: string, adapter: HonestAdapter, files: Record<string, string>) {
  return new ToyCompetitionHarness({
    prediction,
    missionId,
    taskContract: contract,
    branchIds: ["candidate-1"],
    runtime: runtime(files),
    adapter,
    policy,
  });
}

describe("T40 data honesty contract face", () => {
  test("exposes leakage_audit and test_signal_policy (forbid | disclose_only) on the adapter contract", () => {
    const forbidden = resolveDataHonestyContract(new HonestAdapter(forbidContract));
    expect(forbidden?.leakage_audit.protectedPaths).toEqual(["test.csv", "private/solution.csv"]);
    expect(forbidden?.test_signal_policy.mode).toBe("forbid");

    const disclosed = resolveDataHonestyContract(new HonestAdapter(discloseContract));
    expect(disclosed?.test_signal_policy.mode).toBe("disclose_only");
  });

  test("contract absence means the gate is inactive (adapters without data-honesty declarations)", () => {
    expect(resolveDataHonestyContract(new ScoreFileToyCompetitionAdapter())).toBeUndefined();
  });
});

describe("T40 leakage audit — unit findings", () => {
  test("clean candidate files pass the audit", () => {
    const findings = auditCandidateFiles(forbidContract, { train: "model.fit(X_train, y_train)", score: "7" });
    expect(findings).toEqual([]);
  });

  test("reads of protected test/answer paths are leakage findings", () => {
    const findings = auditCandidateFiles(forbidContract, {
      "main.py": "import pandas as pd\ndf = pd.read_csv('test.csv')\nprint(df)",
    });
    expect(findings.length).toBeGreaterThan(0);
    expect(findings[0].kind).toBe("protected_path");
  });

  test("embedding the full gold-label row verbatim is label leakage", () => {
    const findings = auditCandidateFiles(forbidContract, {
      "predictions": JSON.stringify([0, 1, 1, 0, 1]),
    });
    expect(findings.some((finding) => finding.kind === "gold_labels")).toBe(true);
  });

  test("embedding gold labels inside code (not a standalone predictions file) is still leakage", () => {
    const findings = auditCandidateFiles(forbidContract, {
      "main.py": `import pandas as pd\ngold = [0, 1, 1, 0, 1]  # "answer key\nprint(gold)`,
    });
    expect(findings.some((finding) => finding.kind === "gold_labels")).toBe(true);
  });

  test("a protected path read by basename alone is still flagged", () => {
    const findings = auditCandidateFiles(forbidContract, {
      "main.py": "ans = open('solution.csv').read()",
    });
    expect(findings.some((finding) => finding.kind === "protected_path")).toBe(true);
  });

  test("a partial label sequence is not treated as gold-label leakage (avoids binary false positives)", () => {
    const findings = auditCandidateFiles(forbidContract, {
      "predictions": JSON.stringify([1, 1, 0]),
    });
    expect(findings.some((finding) => finding.kind === "gold_labels")).toBe(false);
  });

  test("referencing a test/private feedback channel is test-signal peeking", () => {
    const findings = auditCandidateFiles(forbidContract, {
      "main.py": "score = scrape('https://kaggle.com/leaderboard')\nsubmit(score)",
    });
    expect(findings.some((finding) => finding.kind === "test_signal")).toBe(true);
  });

  test("findings never embed the gold-label values themselves", () => {
    const findings = auditCandidateFiles(forbidContract, { "predictions": JSON.stringify([0, 1, 1, 0, 1]) });
    for (const finding of findings) {
      expect(JSON.stringify(finding)).not.toContain("0,1,1,0,1");
    }
  });
});

describe("T40 forbid mode — quarantine, no automatic retry of the same violation", () => {
  test("a clean pipeline promotes normally with the gate active", async () => {
    const harness = mission("forbid-clean", new HonestAdapter(forbidContract), { score: "7" });
    const result = await harness.run();
    expect(result.branches["candidate-1"]?.status).toBe("PROMOTED_LOCAL");
    expect(harness.events().some((event) => event.type === "BRANCH_QUARANTINED")).toBe(false);
  });

  test("confirmed leakage is quarantined, never evaluated, and the proposal is never auto-retried", async () => {
    let evaluated = false;
    let proposals = 0;
    const harness = new ToyCompetitionHarness({
      prediction,
      missionId: "forbid-leak",
      taskContract: contract,
      branchIds: ["candidate-1"],
      runtime: {
        selfVerify: () => ({ ok: true }),
        propose: () => { proposals += 1; return { files: { "main.py": "import pandas as pd\npd.read_csv('test.csv')" } }; },
        falsify: () => ({ ok: true, objections: [] }),
      },
      adapter: new HonestAdapter(forbidContract),
      evaluate: () => { evaluated = true; return { score: 9 }; },
      policy,
    });
    const result = await harness.run();

    expect(result.branches["candidate-1"]?.status).toBe("QUARANTINED");
    expect(evaluated).toBe(false);
    // maxAttempts=3 allows infrastructure retries; a confirmed violation never re-proposes.
    expect(proposals).toBe(1);
    const event = harness.events().find((item) => item.type === "BRANCH_QUARANTINED");
    expect(event).toBeDefined();
    expect(event?.payload.leakageFindings).toBeDefined();
    expect(event?.payload.violationFingerprint).toBeDefined();
    // A quarantined branch is terminal: no retry is scheduled.
    expect(harness.events().some((item) => item.type === "RETRY_SCHEDULED")).toBe(false);
  });

  test("re-attempting the same confirmed violation is refused (fingerprint repeat), unlike infrastructure retries", async () => {
    // First run: leakage attempt quarantines.
    const first = mission("forbid-repeat-a", new HonestAdapter(forbidContract), {
      "main.py": "pd.read_csv('test.csv')",
    });
    await first.run();
    const firstEvent = first.events().find((item) => item.type === "BRANCH_QUARANTINED");
    const fingerprint = firstEvent?.payload.violationFingerprint as string;
    expect(typeof fingerprint).toBe("string");

    // A fresh branch attempt carrying the identical violation must also quarantine with the same
    // fingerprint: the violation path is never automatically retried.
    const second = mission("forbid-repeat-b", new HonestAdapter(forbidContract), {
      "main.py": "pd.read_csv('test.csv')",
    });
    await second.run();
    const secondEvent = second.events().find((item) => item.type === "BRANCH_QUARANTINED");
    expect(secondEvent?.payload.violationFingerprint).toBe(fingerprint);
  });
});

describe("T40 disclose_only mode — auditable disclosure, test feedback never a promotion basis", () => {
  test("leakage leaves a durable disclosure event but the candidate still evaluates", async () => {
    const harness = mission("disclose-leak", new HonestAdapter(discloseContract), {
      "main.py": "pd.read_csv('test.csv')",
      score: "5",
    });
    const result = await harness.run();

    const disclosure = harness.events().filter((event) => event.type === "LEAKAGE_DISCLOSURE");
    expect(disclosure.length).toBe(1);
    expect(disclosure[0].payload.findingKinds).toContain("protected_path");
    expect(disclosure[0].payload.mode).toBe("disclose_only");
    // disclose_only records but does not block.
    expect(result.branches["candidate-1"]?.status).not.toBe("QUARANTINED");
    expect(harness.events().some((event) => event.type === "BRANCH_QUARANTINED")).toBe(false);
  });

  test("disclosure events never carry gold-label values", async () => {
    const harness = mission("disclose-labels", new HonestAdapter(discloseContract), {
      "predictions": JSON.stringify([0, 1, 1, 0, 1]),
      score: "5",
    });
    await harness.run();
    const event = harness.events().find((item) => item.type === "LEAKAGE_DISCLOSURE");
    expect(JSON.stringify(event?.payload)).not.toContain("0,1,1,0,1");
  });
});

describe("T40 test-signal policy", () => {
  test("forbid mode quarantines test-signal peeking (public-score hill-climbing)", async () => {
    const harness = mission("forbid-signal", new HonestAdapter(forbidContract), {
      "main.py": "hillclimb_to('leaderboard')",
    });
    const result = await harness.run();
    expect(result.branches["candidate-1"]?.status).toBe("QUARANTINED");
    const event = harness.events().find((item) => item.type === "BRANCH_QUARANTINED");
    const findings = event?.payload.leakageFindings as ReadonlyArray<{ kind: string }>;
    expect(findings.some((finding) => finding.kind === "test_signal")).toBe(true);
  });

  test("promotion never consumes the agent-readable feedback view (test feedback is not a default promotion basis)", async () => {
    // feedback view enabled; a falsifier role sees it, but promotion is a score-only trusted verdict.
    const seen: unknown[] = [];
    const harness = new ToyCompetitionHarness({
      prediction,
      missionId: "disclose-no-promotion-signal",
      taskContract: contract,
      branchIds: ["candidate-1"],
      runtime: {
        selfVerify: () => ({ ok: true }),
        propose: () => ({ files: { score: "7" } }),
        falsify: ({ feedbackView }) => { seen.push(feedbackView); return { ok: true, objections: [] }; },
      },
      adapter: new HonestAdapter(discloseContract),
      evaluationFeedback: { enabled: true },
      policy,
    });
    const result = await harness.run();

    expect(result.branches["candidate-1"]?.status).toBe("PROMOTED_LOCAL");
    // The agent role may see the feedback view, but the promotion verdict cites the trusted
    // evaluation evidence only — never the feedback channel.
    const promotion = harness.events().find((event) => event.type === "PROMOTED_LOCAL");
    expect(promotion?.payload.evaluationRef).toBeTruthy();
    expect(promotion?.payload.feedbackView).toBeUndefined();
    expect(promotion?.payload.feedback_view).toBeUndefined();
    expect(seen.length).toBe(1);
  });
});

describe("T40 LeakageViolation", () => {
  test("is a trust violation so the harness quarantines it", () => {
    const violation = new LeakageViolation([{ kind: "protected_path", token: "test.csv", detail: "reads protected test/answer data" }]);
    expect(violation).toBeInstanceOf(Error);
    expect(violation.name).toBe("LeakageViolation");
    expect(violation.findings[0].kind).toBe("protected_path");
  });
});
