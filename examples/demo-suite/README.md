# Demo suite scaffold (ET-OPS-DOMAIN)

Copyable **true-domain** research project. It wires the merged `suite-metric`
Competition Adapter: a trusted local test suite measures Candidate
`src/solve.js` exports. The score is `pass_rate = n_pass / n_total`.

The shipped baseline is intentionally incomplete (2 of 5 cases pass).
`--start --baseline-only` either runs that **measured** baseline **or**
prints remaining hard gates. It does not invent a green pass, does not
read a hand-written `0.4` seed, and does not authorize true submit.

Target lift ≥0.8 is a later ticket (ET-RSI-LIFT). This scaffold proves
baseline measurement only.

## Absolute-path operation

Always pass **absolute** paths. A relative `--project` is resolved from the
current working directory and will miss `.evok/evaluation.json` if you invoked
`evok` from another directory.

| Thing | How to point at it |
| --- | --- |
| `--project` | Absolute directory of this scaffold (or a copy). |
| evaluation contract | `<abs-project>/.evok/evaluation.json` — `id: suite-metric`, `score.metric: pass_rate`. Trusted suite (`suite/cases.json`) stays **relative** to the project, never an absolute file and never taken from the Candidate snapshot. |
| Mission draft | `<abs-project>/.evok/missions/demo-suite/draft.json` |
| Isolated workspace | Created by the controller as a temp dir. Do **not** pass a workspace path as `--project`. |

```bash
# from the evoK repo root — resolve the demo to an absolute path first
DEMO="$(pwd)/examples/demo-suite"

# copy this folder if you want a private working copy
cp -R "$DEMO" /tmp/evok-demo-suite
DEMO="$(cd /tmp/evok-demo-suite && pwd)"

bun run evok --start --baseline-only --project "$DEMO" --mission demo-suite
# equivalent: bun run evok /start --baseline-only --project "$DEMO" --mission demo-suite
```

If Pi model/auth (or another start prerequisite) is missing, the CLI lists
**remaining hard gates** and dispatches nothing. Admission, Budget Gate, hang,
T48, and Broker stay in force. `#40` Progressive stays off. Start is not
skill-authorization.

Prove the shipped baseline without a live model (measured 2/5 = 0.4):

```bash
bun test src/project-evaluator.test.ts
bun test src/competition/local-js-exports-runner.test.ts
```

## Copyable evaluation contract

Documented suite-metric template: `templates/evaluation.suite-metric.json`.
This demo already ships the true-domain runner at `.evok/evaluation.json`:

```json
{
  "id": "suite-metric",
  "version": "1",
  "suite": {
    "kind": "local-tests",
    "runner": "local-js-exports",
    "cases_glob_or_manifest": "suite/cases.json"
  },
  "score": {
    "metric": "pass_rate",
    "min": 0,
    "max": 1
  },
  "artifact_refs": []
}
```

Trusted cases call `double`, `isEven`, `sum`, `max`, and `clamp` on the
Candidate module. A model-authored `score` / `answer.txt` / "I scored 1.0"
cannot replace the measured `pass_rate`.

## What this does not do

- Does not thaw External Submission / true submit
- Does not open DeployArena
- Does not unfreeze `#40` / Progressive default
- Does not change Admission / Budget / hang / T48 predicates
- Does not implement the research lift toward ≥0.8
