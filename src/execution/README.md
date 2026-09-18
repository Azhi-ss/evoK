# execution

Dynamic Team: Pattern, Team Coordinator, Roles, runtime, Policy Guard.
Does not own gate override or replace the Evaluator.

Physical home of `team-execution`, `model-orchestra`, `pi-agent-runtime`,
`security-boundary`, `dag-scheduler`, and the `pi-security*` /
`team-security*` contracts. Flat `src/*.ts` files re-export these modules
so existing imports stay green.

**Thin execution default (B)** stays in force:

- `DEFAULT_BRANCH_WIDTH=1`. Multi-branch Fan-Out is raised on demand.
- Verification Roles (Falsifier, Critic, Challenger, and kin) run only
  when callbacks are provided. PolicyGuard defaults do not force a
  Falsifier roster.
- Execution Plan, Pattern, and Role names describe capability; they are
  not Promotion or gate-pass proof. Elite / side-slots / Team Fan-Out
  are not Promotion keys.

`patterns/` holds empty-shell Pattern specs (who plays / advance
conditions only). They are read-only. They do not contain orchestration
code and do not force a Coordinator runtime track-switch. A standing
verification roster is not an advance condition. C thickening — a full
Antigravity roster as a v1 must-have — is rejected.

Hang / T48 stay in `src/evidence/`. Search structure stays in
`src/search/`. Mission authorize / continue / repair / stop stay in
`src/mission/`. Do not start `src/competition/` from this pack.
`#40` SelectionPolicy stays off. True External Submission stays frozen.
