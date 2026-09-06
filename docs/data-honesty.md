# Data honesty gate — leakage audit + test-signal policy (T40, #33)

The data honesty gate detects and prevents **training/label leakage** and
**test-signal peeking** (using test / private / leaderboard feedback to hill-climb
a public score). Kaggle/MLE-bench agents routinely cheat this way (research gap
G1); honesty cannot rely on an agent "feeling honest".

Implementation: `src/data-honesty.ts`; wired into the mission seam in
`src/toy-harness.ts` (audit runs after candidate proposal, before any snapshot
or evaluation); ledger event classification in `src/ledger-kinds.ts`.

## Scope — what this gate is NOT

This ticket governs **data honesty only**. It explicitly does **not** replace:

- **#7 — sandbox / evaluator trust boundary** (`src/security-boundary.ts`):
  filesystem/network/tool isolation, protected paths, secret redaction, trusted
  snapshot integrity. Data honesty *adds* a semantic layer (what counts as
  leakage) on top of the sandbox; a `LeakageViolation` is a `TrustViolation`.
- **#11 — evaluation noise protocol** (`src/evaluation-noise.ts`): repeat
  budgets, ladder, A/B agreement, margins. The honesty gate says nothing about
  score noise or statistical significance.

## Contract face (adapter / evaluation contract)

A `ToyCompetitionAdapter` optionally declares:

| field | snake / camel | meaning |
|---|---|---|
| `leakage_audit` | `leakageAudit` | `{ protectedPaths: string[], goldLabels?: array }` — held-out data that must never appear in candidate code/files |
| `test_signal_policy` | `testSignalPolicy` | `{ mode: "forbid" \| "disclose_only", testSignals: string[] }` — feedback channels (leaderboard, private score, submission API) and how using them is handled |

Absent declarations → the gate is inactive (`resolveDataHonestyContract` returns
`undefined`); a partial declaration (one field without the other) fails closed
with a configuration error.

## Detected signals (`auditCandidateFiles`)

Static, deterministic scan of candidate files (replay-safe). It is a
deliberately naive v0 heuristic — any mention of a declared token counts as a
finding (comments included; forbid mode fails closed), and obfuscated labels or
URLs escape it; the ceiling and AST/dataflow upgrade path are noted with a
`ponytail:` comment in `src/data-honesty.ts`.

1. **`protected_path`** — a file (or its path/name) references a declared
   protected path (`test.csv`, `private/solution.csv`, …): training on test rows
   or reading held-out answers.
2. **`gold_labels`** — a candidate file embeds the *entire* held-out gold-label
   row verbatim (whitespace-insensitive). Partial/short binary prefixes are
   **not** findings, so legitimate `0/1` predictions never false-positive.
   Finding/disclosure payloads never quote the gold values.
3. **`test_signal`** — a file references a declared test/private feedback
   channel (`leaderboard`, `private_score`, submission API): probing the test
   signal to overfit the public score.

## Modes

- **`forbid`** (default enforcement): any confirmed finding →
  `LeakageViolation` → `BRANCH_QUARANTINED` before evaluation. The branch is
  terminal: the proposal is not re-invoked and no `RETRY_SCHEDULED` is emitted —
  a violation path is never an automatic retry (unlike `InfrastructureError`,
  which is retried up to `maxAttempts`); a `QUARANTINED` branch is also refused
  reservation on replay/crash recovery. The quarantine event carries
  `leakageFindings` and a stable `violationFingerprint` (digest of the finding
  kinds+tokens) for audit/forensics — repeated identical violations carry the
  same fingerprint. ponytail: v0 keeps no cross-mission violation store; add a
  persisted fingerprint ledger when missions must refuse a known-bad agent path
  across runs.
- **`disclose_only`**: findings are recorded in a durable `LEAKAGE_DISCLOSURE`
  Evidence event (`findingKinds`, non-sensitive tokens/details, files digest)
  and the candidate still evaluates. Test feedback **still never feeds grading
  or promotion** — promotion is a trusted-score verdict only; the
  `feedback_view` channel (T24) is never read by the promotion gate and never
  appears on `PROMOTED_LOCAL`.

## Ledger

- `LEAKAGE_DISCLOSURE` — Evidence kind (an observation of leakage), replay-safe
  and classified in `src/ledger-kinds.ts`.
- `BRANCH_QUARANTINED` — Evaluation-kind verdict, unchanged kind; in forbid mode
  its payload additionally carries the leakage findings and fingerprint.
