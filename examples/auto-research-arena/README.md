# evoK × Auto-Research Arena (`arXiv:2610.35866`)

Portable integration between **evoK** (`startAuthorizedMission` / `resumeAuthorizedMission` + `project-evaluator.ts`) and **Auto-Research Arena** (`https://github.com/Auto-Research-Arena/auto-research-arena`, commit `8bd08b9975857419d698cb2f5dea0587a24bc82d`).

This directory runs **locally/privately only** — it never submits to any public leaderboard and never opens `DeployArena`.

## 1. Host Prerequisites (Volcengine GPU VM)

- **OS & packages**: Ubuntu 22.04/24.04 x86_64, `git`, `curl`, `bubblewrap` (`apt-get install -y bubblewrap build-essential pkg-config python3-venv`), NVIDIA driver with CUDA 12.8 support, `uv` (`>=0.6`), `bun` (`>=1.1`).
  - On Volcengine MLP DevBoxes, verify userns/mount availability first with `bwrap --ro-bind / / true`.
- **GPU**:
  - **Recommended (single-GPU parity with official baseline)**: 1 × **NVIDIA A800-80GB** or **NVIDIA A100-80GB** (reference `params` peak allocation is `45,012.5 MiB` / `47.20 GB`, so 24 GB / 40 GB cards OOM and 48 GB cards leave <3 GiB headroom).
  - **Alternative**: 1 × **NVIDIA H800-80GB** or **NVIDIA H20-96GB** (`train.py` auto-selects Hopper FA3 on SM90; note fixed `600s` wall-clock tasks perform different step counts than A100/A800, so compare against a fresh reference measured on the same GPU).
- **Data (~1.02 GB one-time)**: 10 training shards + 1 pinned validation shard (`shard_06542.parquet`) from `karpathy/climbmix-400b-shuffle` plus local BPE tokenizer (`631,241,817` tokens).

## 2. Configure Pi Model for evoK

Configure `~/.pi/agent/models.json` and `~/.pi/agent/auth.json` (never commit keys). Ensure `cost` fields are finite numbers so evoK's `model-USD` budget accounting succeeds (use nominal rates if self-hosting vLLM/SGLang).

## 3. Prepare Auto-Research Arena & Launch Pilot (`params`)

```bash
# 1) Clone benchmark at verified commit and prepare measurement env + ~1.02 GB data
git clone https://github.com/Auto-Research-Arena/auto-research-arena.git /workspace/auto-research-arena
cd /workspace/auto-research-arena
git checkout 8bd08b9975857419d698cb2f5dea0587a24bc82d
uv sync --python 3.10
uv run python scripts/prepare_local.py --task params

# 2) Register evoK method interface
export EVOK_REPO_ROOT="/workspace/evoK"
cp -R "$EVOK_REPO_ROOT/examples/auto-research-arena/evok" /workspace/auto-research-arena/examples/evok
cp "$EVOK_REPO_ROOT/examples/auto-research-arena/run-config.volcengine.example.json" /workspace/auto-research-arena/run-config.evok-params.json

# 3) Preflight check (validates task packages, evoK interface, GPU, data, CUDA runtime)
uv run python -m engine check --config run-config.evok-params.json

# 4) Run pilot (default settings.json: maxExperiments=15 => 1 reference + 15 candidate launches, ~3.2 GPU-hours)
#    For full official budget (100 launches, ~20.9 GPU-hours), set "maxExperiments": 99 in examples/evok/settings.json.
uv run python -m engine run --config run-config.evok-params.json

# 5) Collect verified metrics and local report (offline, no public submission)
uv run python -m engine collect --run runs/evok-params-pilot
uv run python -m engine verify --run runs/evok-params-pilot
uv run python -m engine submission --run runs/evok-params-pilot --output runs/evok-params-pilot/report
```

Machine-readable outputs:
- AutoArena ledger & report: `runs/evok-params-pilot/launches.jsonl` and `runs/evok-params-pilot/report/submission.json`
- evoK Mission summary & ledger: `runs/evok-params-pilot/workspace/evok-autoarena-summary.json` and `runs/evok-params-pilot/workspace/evok-project/.evok/missions/autoarena-params/mission.json`
