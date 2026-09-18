# Pattern spec — research-thin

Read-only empty shell. Not a runtime track, not a Promotion key, not
orchestration code. The Coordinator does not switch tracks because this
file exists.

## Who plays

- One Branch. Team Coordinator proposes `branchWidth = 1`.
- Worker / explorer Role on that Branch.
- Verification Roles (Falsifier, Critic, Challenger, Auditor, Success
  Auditor) stay off unless a caller supplies a callback.

## Advance conditions

- The Branch execute completes under the Task Contract and Branch budget.
- Policy Guard validates the thin plan; it does not mandate a standing
  verification roster.
- Status may be `COMPLETED` with no verification callbacks.
- An explicit Falsifier (or kin) failure still rejects that Branch.

A standing verification roster is not an advance condition. Elite status,
Fan-Out width, and Role names are not Promotion keys.
