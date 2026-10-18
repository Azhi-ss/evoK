"""Deterministic Orchestrator skeleton for a harness-optimisation loop (no LLM inside).

LLM roles (Gap Finder / Innovator / Reviewer) and the sandbox Runner are injected as
plain callables; this file only does: select -> expand -> evaluate -> backprop,
budget gates, state machine, lineage persistence.

Borrowed ideas (see survey doc for file/line refs):
  - UCT formula + backprop loop: treequest standard_mcts.py, MLEvolve engine/search_node.py
  - progressive widening / per-node child cap: MLEvolve reached_child_limit
  - pending lock to avoid duplicate parallel picks: MLEvolve select() draft lock, AI-Scientist-v2 _select_parallel_nodes
  - softmax+uniform mixed parent sampling: AFlow data_utils.select_round (alpha=0.2, lambda=0.3)
  - sigmoid(score) * 1/(1+children) parent sampling: DGM choose_selfimproves 'score_child_prop'
  - keep-better with noise leeway: DGM update_archive('keep_better', noise_leeway)
  - staged eval (small subset first, full only if good): DGM run_harness_swe test_more_threshold
  - duplicate-modification guard: AFlow experience_utils.check_modification
  - plateau stop: AFlow convergence_utils.check_convergence / OpenEvolve early_stopping_patience
"""
from __future__ import annotations
import json, math, os, random, time, uuid
from dataclasses import dataclass, field, asdict
from enum import Enum
from pathlib import Path
from typing import Callable, Optional


@dataclass
class Node:
    id: str
    parent_id: Optional[str]
    config_path: str                 # harness config snapshot on disk (the "state")
    patch_summary: str = ""          # Innovator's declared modification (for dedupe)
    status: str = "pending"          # pending | running | evaluated | failed | rejected
    dev_scores: list = field(default_factory=list)   # normalised [0,1] per repeat
    stage: str = "none"              # none | small | full  (staged eval)
    visits: int = 0                  # MCTS stats (updated by backprop)
    value_sum: float = 0.0
    children: list = field(default_factory=list)
    locked: bool = False             # in-flight, don't hand out twice
    tokens_used: int = 0
    created_at: float = field(default_factory=time.time)

    @property
    def dev_mean(self) -> Optional[float]:
        return sum(self.dev_scores) / len(self.dev_scores) if self.dev_scores else None


class Phase(str, Enum):
    SELECT = "select"; GAP = "gap"; PROPOSE = "propose"; RUN = "run"
    REVIEW = "review"; BACKPROP = "backprop"; GATE = "gate"; STOP = "stop"


class Lineage:
    """Append-only event log + one json per node. Fully rebuildable from disk (restart-safe)."""
    def __init__(self, root: str):
        self.root = Path(root); (self.root / "nodes").mkdir(parents=True, exist_ok=True)
        self.events = self.root / "events.jsonl"
        self.nodes: dict[str, Node] = {}
        for p in (self.root / "nodes").glob("*.json"):
            n = Node(**json.loads(p.read_text())); self.nodes[n.id] = n

    def put(self, n: Node):
        tmp = self.root / "nodes" / f".{n.id}.tmp"
        tmp.write_text(json.dumps(asdict(n), ensure_ascii=False, indent=1))
        os.replace(tmp, self.root / "nodes" / f"{n.id}.json")   # atomic
        self.nodes[n.id] = n

    def log(self, kind: str, **kw):
        with self.events.open("a") as f:
            f.write(json.dumps({"t": time.time(), "kind": kind, **kw}, ensure_ascii=False) + "\n")

    def root_node(self) -> Node:
        return next(n for n in self.nodes.values() if n.parent_id is None)

    def evaluated(self) -> list:
        return [n for n in self.nodes.values() if n.status == "evaluated" and n.dev_mean is not None]

    def best(self) -> Node:
        return max(self.evaluated(), key=lambda n: n.dev_mean)


@dataclass
class Budget:
    max_local_runs: int = 200
    max_tokens: int = 5_000_000
    max_wall_s: float = 8 * 3600
    max_online_submits_per_day: int = 1      # contest rule (provisional)
    used_runs: int = 0; used_tokens: int = 0
    started: float = field(default_factory=time.time)
    submits: dict = field(default_factory=dict)   # 'YYYY-MM-DD' -> count

    def can_run(self, est_tokens: int = 0) -> bool:
        return (self.used_runs < self.max_local_runs
                and self.used_tokens + est_tokens <= self.max_tokens
                and time.time() - self.started < self.max_wall_s)

    def can_submit(self, day: str) -> bool:
        return self.submits.get(day, 0) < self.max_online_submits_per_day


class Selector:
    def pick(self, lin: Lineage) -> Node: ...

class GreedySelector(Selector):
    """Always expand current best (Karpathy-style hill climb). Default for MVP."""
    def pick(self, lin):
        return max((n for n in lin.evaluated() if not n.locked), key=lambda n: n.dev_mean)

class SoftmaxMixSelector(Selector):
    """AFlow select_round: top-k by score, p = lam*uniform + (1-lam)*softmax(alpha*100*s)."""
    def __init__(self, k=4, alpha=0.2, lam=0.3, rng=random): self.k, self.a, self.l, self.rng = k, alpha, lam, rng
    def pick(self, lin):
        pool = sorted((n for n in lin.evaluated() if not n.locked), key=lambda n: -n.dev_mean)[: self.k]
        s = [n.dev_mean * 100 for n in pool]; m = max(s)
        w = [math.exp(self.a * (x - m)) for x in s]; z = sum(w)
        p = [self.l / len(pool) + (1 - self.l) * x / z for x in w]
        return self.rng.choices(pool, weights=p, k=1)[0]

class ScoreChildPropSelector(Selector):
    """DGM score_child_prop: sigmoid(10*(s-0.5)) * 1/(1+n_children)."""
    def __init__(self, rng=random): self.rng = rng
    def pick(self, lin):
        pool = [n for n in lin.evaluated() if not n.locked]
        w = [1 / (1 + math.exp(-10 * (n.dev_mean - 0.5))) / (1 + len(n.children)) for n in pool]
        return self.rng.choices(pool, weights=w, k=1)[0]

class UCTSelector(Selector):
    """Tree descent with UCB1; expand a node if below widening cap. cap(n)=ceil(k*max(1,visits)^alpha)."""
    def __init__(self, c=math.sqrt(2), pw_k=2.0, pw_alpha=0.5, max_children=6):
        self.c, self.k, self.alpha, self.maxc = c, pw_k, pw_alpha, max_children
    def _cap(self, n): return min(self.maxc, math.ceil(self.k * max(1, n.visits) ** self.alpha))
    def _uct(self, child, parent):
        if child.visits == 0: return float("inf")
        return child.value_sum / child.visits + self.c * math.sqrt(math.log(max(1, parent.visits)) / child.visits)
    def pick(self, lin):
        node = lin.root_node()
        while True:
            kids = [lin.nodes[c] for c in node.children
                    if lin.nodes[c].status == "evaluated" and not lin.nodes[c].locked]
            if len(node.children) < self._cap(node) or not kids:
                return node                       # expand here
            node = max(kids, key=lambda ch: self._uct(ch, node))


def backprop(lin: Lineage, node: Node, reward: float):
    """Standard MCTS backprop: visits+1, value_sum+=reward up to root."""
    cur: Optional[Node] = node
    while cur is not None:
        cur.visits += 1; cur.value_sum += reward; lin.put(cur)
        cur = lin.nodes.get(cur.parent_id) if cur.parent_id else None


@dataclass
class Roles:
    gap_finder: Callable[[Node, Lineage], dict]                 # -> gaps.json content
    innovator: Callable[[Node, dict, list], dict]              # -> {"summary","config_path","tokens"}
    runner: Callable[[str, str], list]                         # (config_path, subset) -> per-repeat scores in [0,1]
    reviewer: Callable[[Node, Node], dict]                     # (child, parent) -> {"accept":bool,"reason":str}


class Orchestrator:
    def __init__(self, lin, roles, selector, budget, noise_leeway=0.01, staged_threshold=0.9, patience=15):
        self.lin, self.r, self.sel, self.b = lin, roles, selector, budget
        self.leeway, self.stage_thr, self.patience = noise_leeway, staged_threshold, patience
        self.since_improve = 0
        self.phase = Phase.SELECT

    def step(self) -> Phase:
        if not self.b.can_run():
            self.phase = Phase.STOP; return self.phase
        parent = self.sel.pick(self.lin); parent.locked = True; self.lin.put(parent)
        self.lin.log("select", node=parent.id, selector=type(self.sel).__name__)
        try:
            gaps = self.r.gap_finder(parent, self.lin)
            tried = [self.lin.nodes[c].patch_summary for c in parent.children]
            prop = self.r.innovator(parent, gaps, tried)
            if prop["summary"] in tried:
                self.lin.log("dup_patch", node=parent.id); return Phase.SELECT
            child = Node(id=uuid.uuid4().hex[:8], parent_id=parent.id,
                         config_path=prop["config_path"], patch_summary=prop["summary"],
                         tokens_used=prop.get("tokens", 0))
            parent.children.append(child.id); self.lin.put(parent); self.lin.put(child)
            self.b.used_tokens += child.tokens_used
            child.status = "running"; self.lin.put(child)
            small = self.r.runner(child.config_path, "dev_small"); self.b.used_runs += 1
            child.dev_scores, child.stage = small, "small"
            if parent.dev_mean is not None and sum(small) / len(small) >= self.stage_thr * parent.dev_mean:
                child.dev_scores = small + self.r.runner(child.config_path, "dev_full")
                child.stage = "full"; self.b.used_runs += 1
            child.status = "evaluated"; self.lin.put(child)
            verdict = self.r.reviewer(child, parent)
            keep_better = child.dev_mean >= (parent.dev_mean or 0) - self.leeway
            if not (verdict["accept"] and keep_better):
                child.status = "rejected"; self.lin.put(child)
            self.lin.log("review", node=child.id, accept=child.status == "evaluated",
                         dev=child.dev_mean, reason=verdict.get("reason", ""))
            backprop(self.lin, child, child.dev_mean)
            best = self.lin.best()
            self.since_improve = 0 if best.id == child.id else self.since_improve + 1
            if self.since_improve >= self.patience:
                self.lin.log("plateau", best=best.id); self.phase = Phase.STOP
            return self.phase
        except Exception as e:
            self.lin.log("error", node=parent.id, err=repr(e)); return Phase.SELECT
        finally:
            parent.locked = False; self.lin.put(parent)

    def run(self):
        while self.step() != Phase.STOP: pass
        return self.lin.best()

    # GATE: held-out + TTS baseline + daily quota. Never visible to Innovator.
    def submit_gate(self, heldout_eval, tts_baseline, base_heldout, day, min_delta=0.0) -> dict:
        best = self.lin.best()
        h = heldout_eval(best.config_path)
        ok = (h >= base_heldout + min_delta) and (h >= tts_baseline) and self.b.can_submit(day)
        self.lin.log("gate", node=best.id, heldout=h, tts=tts_baseline, base=base_heldout, ok=ok)
        return {"node": best.id, "heldout": h, "submit": ok}
