# Demo start scaffold (ET-OPS-START)

Minimal research project a newcomer can copy. It wires the real CLI start
path: copyable `evaluation.json`, a reviewable Mission draft, and absolute-path
operation. `--start --baseline-only` either runs the measured baseline **or**
prints remaining hard gates. It does not invent a green pass and does not
authorize true submit.

## Absolute-path operation

Always pass **absolute** paths. A relative `--project` is resolved from the
current working directory and will miss `.evok/evaluation.json` if you invoked
`evok` from another directory.

| Thing | How to point at it |
| --- | --- |
| `--project` | Absolute directory of this scaffold (or a copy). |
| evaluation contract | `<abs-project>/.evok/evaluation.json` — copy `templates/evaluation.json`. Artifact (`answer.txt`) stays **relative** to the Candidate snapshot, never an absolute file. |
| Mission draft | `<abs-project>/.evok/missions/demo-start/draft.json` |
| Isolated workspace | Created by the controller as a temp dir. Do **not** pass a workspace path as `--project`. |

```bash
# from the evoK repo root — resolve the demo to an absolute path first
DEMO="$(pwd)/examples/demo-start"

# copy this folder if you want a private working copy
cp -R "$DEMO" /tmp/evok-demo-start
DEMO="$(cd /tmp/evok-demo-start && pwd)"

bun run evok --start --baseline-only --project "$DEMO" --mission demo-start
# equivalent: bun run evok /start --baseline-only --project "$DEMO" --mission demo-start
```

If Pi model/auth (or another start prerequisite) is missing, the CLI lists
**remaining hard gates** and dispatches nothing. Admission, Budget Gate, hang,
T48, and Broker stay in force. `#40` Progressive stays off. Start is not
skill-authorization.

## Copyable evaluation template

Documented path: `templates/evaluation.json`. This demo already ships the same
fields at `.evok/evaluation.json`:

```json
{
  "id": "file-metric",
  "version": "1",
  "artifact": "answer.txt",
  "metric": "answer",
  "min": 0,
  "max": 1
}
```

## What this does not do

- Does not thaw External Submission / true submit
- Does not open DeployArena
- Does not unfreeze `#40` / Progressive default
- Does not change Admission / Budget / hang / T48 predicates
