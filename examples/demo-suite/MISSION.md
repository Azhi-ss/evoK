# Demo suite research reference

Goal: raise the independent `suite-metric` `pass_rate` toward 0.8 without
writing a score.

Candidate: `src/solve.js` CommonJS exports (`double`, `isEven`, `sum`,
`max`, `clamp`). Trusted cases live in `suite/cases.json` and are never
read from the Candidate snapshot.

Only the independent Evaluator measures the result. Candidates must not
self-report a score. This scaffold does not authorize External Submission.
The shipped baseline is intentionally incomplete so a measured pass_rate
is about 0.4.
