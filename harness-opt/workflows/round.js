/**
 * Named-workflow script body for `harnessopt.round`.
 * `registerWorkflowResource` returns this string from a synchronous resolve.
 * The runtime provides `runs`. Importing this module does not start a round.
 */
export const HARNESSOPT_ROUND_NAME = "harnessopt.round";

export const HARNESSOPT_ROUND_SCRIPT = [
  "const gapRun = await runs.all([{ key: \"gap\", agent: \"gap-finder\", task: \"Read traces and return gaps with id, failureClass, summary, traceIds.\" }]);",
  "const gap = gapRun.map(function (child) { return child.output; }).join(\"\\n\");",
  "const innovRun = await runs.all([{ key: \"innovate\", agent: \"innovator\", task: \"From the gap report, write one patch with part, motivation, expectedFailureClass, and summary.\\n\" + gap }]);",
  "const patch = innovRun.map(function (child) { return child.output; }).join(\"\\n\");",
  "const reviewRun = await runs.all([{ key: \"review\", agent: \"reviewer-gate\", task: \"Review the candidate against the parent. Return accept and reason.\\n\" + patch }]);",
  "return { ok: true, gap: gap, patch: patch, review: reviewRun.map(function (child) { return child.output; }).join(\"\\n\") };",
].join("\n");
