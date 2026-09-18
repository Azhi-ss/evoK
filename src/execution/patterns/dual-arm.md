# Pattern spec — dual-arm

Read-only empty shell. Not a runtime track, not a Promotion key, not
orchestration code. The Coordinator does not switch tracks because this
file exists.

## Who plays

- Two complementary Branches or Roles, raised on demand (for example
  propose / check, or explore / exploit).
- Team Coordinator may propose `branchWidth = 2` only when the caller
  requests Fan-Out. The thin default remains width 1.
- Verification Roles stay off unless callbacks are provided.

## Advance conditions

- Declared Fan-In / Join Policy reconciles the two arms.
- Partial evidence closes through the Join Policy, not through waiting
  for every named Role to appear.
- Independent Evaluator + Promotion policy remain the only Promotion
  route.

A standing verification roster is not an advance condition. Dual-arm
width is a capability description, not a Promotion key.
