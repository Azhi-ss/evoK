# reviewer-gate host verdict

Evaluate the gates in order. The LLM reviewer writes a reason only and cannot change the verdict.

G0 evidence: the signatures, the relay record and the reward signature all verify. Failure is not a reject; it stops the loop as anti_forgery.
G1 closure: the gap cites the previous round's trace, and the gap's knob paths intersect the patch diff's paths in at least one place.
G2 active: patchActive is true, and every changed leaf key in the patch shows its new value in the activation effective config. Keys that are observable in run_end must stay within bounds. patchActive is false when the relay, the mounted config, the session hash, or the effective knob fails, even if the effective value matches. Any inactive key rejects with code inactive_key.
G3 not worse: the real run is scored, its wall time is strictly under the task's official [agent].timeout_sec, the timedOut flag is false, and its reward is at least the latest signed baseline reward. A missing official timeout does not pass.

Before a run, `--stop-before-run` records G1 and a static G2 on closure.json as preflight gates with final false. Static G2 checks every changed leaf against the effective-knob whitelist and the harness file's effective["..."] keys. G0 and G3 stay undecided until a real run.
