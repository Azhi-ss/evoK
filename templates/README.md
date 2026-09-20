# Copyable evaluation contract

Documented path: `templates/evaluation.json` (file-metric) and
`templates/evaluation.suite-metric.json` (suite-metric).

The file-metric fields match the Mission local contract (`id`, `version`, a
**relative** `artifact`, optional `metric` / `min` / `max`). The artifact is
read from the immutable Candidate snapshot, never from a model-supplied score
and never as an absolute path.

`suite-metric` is a parallel Competition Adapter: `score.metric` is
`pass_rate` in `[0, 1]`, measured by a trusted local suite
(`templates/suite-metric.cases.json`). A model self-score cannot replace
that measurement. The start path still defaults to file-metric;
suite-metric is callable on a Candidate snapshot via
`src/competition/suite-metric.ts`.

Copy onto an **absolute** project:

```bash
PROJECT="$(pwd)/my-research-project"   # or any other absolute directory
mkdir -p "$PROJECT/.evok"
cp templates/evaluation.json "$PROJECT/.evok/evaluation.json"
# or, for the local suite adapter:
# cp templates/evaluation.suite-metric.json "$PROJECT/.evok/evaluation.json"
# mkdir -p "$PROJECT/suite"
# cp templates/suite-metric.cases.json "$PROJECT/suite/cases.json"
```

Do not pass a relative `--project` and do not point `--project` at an isolated
Run workspace. A newcomer scaffold that already includes the file-metric
contract lives at `examples/demo-start/`. The true-domain suite-metric
scaffold lives at `examples/demo-suite/`.
