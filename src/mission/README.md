# mission

产品控制面 = Research Loop：授权、预算、continue / repair / stop。
聊天 transcript 不是权威。Hang / T48 属 evidence，不进本包。

Physical home of Mission Director, Mission draft/intake/start/resume,
Research Loop, File Blueprint, Branch recovery, baseline-track, and
golden-path / outer-min orchestration glue (`v1-golden-path`,
`outer-*-path`, `llm-propose-outer-min`).

Flat `src/*.ts` files re-export these modules so existing imports stay green.

`runGoldenPath` / assemble stay **mock default**. Live opens only with
explicit `{ live: true }` (plus key fail-closed). `EVOK_NEWAPI_LIVE` alone
does not open the product path. MethodologyEvidence auto-seam (ME-1) stays
wired through the existing propose → hang path.

Secrets are read from the environment only and must be redacted in errors.
Elite / side-slots / Team Fan-Out are not Promotion keys. `#40` stays off.
True contest External Submission stays frozen. Pattern C is not thickened
here.

Do not move hang / T48 into this pack. Do not grow a second control plane
in `src/cli/`. Contest-arm runtime stays in `src/competition/`; this pack
keeps `llm-propose-outer-min` as the propose/assemble seam.
