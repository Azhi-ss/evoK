import { isAttributionLabel, type Scorecard, type TraceRecord } from "../types";

/**
 * Contest proxy: equal-weight mean of per-task rewards, times 100.
 * A failed task scores 0. A failed trace with no attribution label is
 * incomplete, and the dev gate must not promote it.
 */
export function scoreTraces(traces: readonly TraceRecord[]): Scorecard {
  if (traces.length === 0) {
    return { devScore: Number.NaN, tokens: 0, attributionComplete: false };
  }
  let rewardSum = 0;
  let tokens = 0;
  let attributionComplete = true;
  for (const trace of traces) {
    if (!Number.isFinite(trace.tokens) || trace.tokens < 0) {
      attributionComplete = false;
    } else {
      tokens += trace.tokens;
    }
    const rewardOk = Number.isFinite(trace.reward) && trace.reward >= 0 && trace.reward <= 1;
    if (!rewardOk) attributionComplete = false;
    if (trace.failed || !rewardOk) {
      if (trace.failed && trace.labels.length === 0) attributionComplete = false;
      if (trace.labels.some((label) => !isAttributionLabel(label))) attributionComplete = false;
      continue;
    }
    rewardSum += trace.reward;
  }
  return {
    devScore: (rewardSum / traces.length) * 100,
    tokens,
    attributionComplete,
  };
}
