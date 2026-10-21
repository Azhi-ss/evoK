# reviewer-gate host verdict

Evaluate the gates in order. The LLM reviewer writes reasons only and cannot change the verdict. Held-out is not a requirement.

G0 evidence: the signatures, the relay record and the reward signature all verify. Failure is not a reject; it stops the loop as anti_forgery.
G1 closure: the gap cites the previous round's trace, and the gap's knob paths intersect the patch diff's paths in at least one place.
G2 active: every changed leaf key in the patch shows its new value in the activation effective config. Keys that are observable in run_end must stay within bounds. Any inactive key rejects with code inactive_key.
G3 not worse: the real run is scored and not timed out, and its reward is at least the latest signed baseline reward.
