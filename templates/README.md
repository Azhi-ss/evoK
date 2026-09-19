# Copyable evaluation contract

Documented path: `templates/evaluation.json`.

Fields match the Mission local file-metric contract (`id`, `version`, a
**relative** `artifact`, optional `metric` / `min` / `max`). The artifact is
read from the immutable Candidate snapshot, never from a model-supplied score
and never as an absolute path.

Copy onto an **absolute** project:

```bash
PROJECT="$(pwd)/my-research-project"   # or any other absolute directory
mkdir -p "$PROJECT/.evok"
cp templates/evaluation.json "$PROJECT/.evok/evaluation.json"
```

Do not pass a relative `--project` and do not point `--project` at an isolated
Run workspace. A newcomer scaffold that already includes this file lives at
`examples/demo-start/`.
