# Scientific Mission protocol

The Mission runner separates execution health, protocol validity, and scientific
results. A measured number is not sufficient evidence for a research claim.

## Run sequence

1. **Runtime preflight (no model session).** Every `PiAgentRuntime.execute`
   validates the effective workspace, role tools, bash policy, read boundaries,
   and any explicitly granted SSH/SCP hosts before creating a model session.
   This checks the actual runtime policy, not only the Mission draft. It does
   not test remote connectivity or replace a domain-specific data canary.
2. **Task contract.** Each baseline/Director task declares a `kind`:
   - `measure` (default): an actual controlled measurement evaluated by the
     Mission's independent evaluator.
   - `investigate`: literature review, diagnosis, or evidence collection with
     declared `artifacts`.
   - `repair`: execution or candidate repair with declared `artifacts`.
3. **Independent evaluation.** `measure` uses the Mission evaluator.
   Investigation/repair use `task-<kind>-artifacts`, which checks the immutable
   snapshot for the declared non-empty workspace-relative artifacts and never
   invents a scientific score.
4. **Outcome classification.** Contract violations prefixed with `protocol:`
   are operational protocol failures, not scientific refutations. Only an
   actual measurement can become scientific negative evidence.

## Draft and Director schema

```json
{
  "taskId": "review-failed-run",
  "kind": "investigate",
  "objective": "Review the failed condition interface and record the confounds",
  "artifacts": ["notes/interface-review.md"]
}
```

A Director proposal uses the same fields:

```json
{
  "stateVersion": 3,
  "action": "investigate",
  "rationale": "The adapter is untrained, so the diversity lift is confounded",
  "task": {
    "kind": "investigate",
    "objective": "Audit the adapter and RCS coverage",
    "artifacts": ["notes/adapter-audit.md"]
  }
}
```

Investigation/repair without declared artifacts is rejected before dispatch.
Artifact paths must be relative to the isolated Run workspace; absolute paths
and `..` are refused. Do not put a numeric score in these artifacts to request
promotion: artifact acceptance is not a scientific result or an Admission gate.

## Domain-specific scientific gates

Use `templates/scientific-suite.evaluation.json` for controlled experiments. The
trusted evaluator reads an immutable `suite.json` with `matched_budget`, a
`groups` object, and one `mmd` result. Each required group contains independent
`metrics` (`scaffold_diversity`, `rcs_coverage`, `rcs` in the NOSE example) and
optional `protocol` metadata. The evaluator enforces:

- every required condition/control group and matched sampling budget;
- `adapter_trained=true` for the primary condition when required;
- minimum RCS measurement coverage and RCS non-inferiority tolerance;
- the exact MMD feature, estimator, permutation count, seed, and significance;
- primary-condition lift over each declared control.

Protocol violations are prefixed with `protocol:` and remain operational.
Only after the protocol passes can a lost comparison or non-significant MMD
become scientific negative evidence.

The core runner does not infer scientific validity from a scalar. The trusted
Mission evaluator must still enforce the domain protocol, for example:

- trained versus random/shuffled condition ablations;
- matched generator, data, sampling budget, and seeds;
- minimum condition-measurement coverage;
- pre-registered statistical tests and parameters;
- external rather than self-referential validation.

A domain evaluator should report protocol violations with the `protocol:`
prefix so they cannot be mislabeled as measured refutations. The candidate must
never write its own score or protocol verdict.
