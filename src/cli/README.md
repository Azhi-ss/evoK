# cli

Thin Mission CLI shell. Not a second control plane.

Physical home of `evok-cli` and the `evok` executable wrapper.
`bin/evok.ts` remains the installed entry and imports this pack.

The shell parses argv, resolves Pi models / project resources, and calls
the mission API (`startAuthorizedMission`, intake, resume, status).
Authorize / budget / continue · repair · stop stay in `src/mission/`.
Hang / T48 stay in `src/evidence/`.

Flat `src/evok-cli.ts` re-exports this module so existing imports stay green.

Secrets are read from the environment / Pi stores only; never copy or
print credentials. Model/resource wiring (`evok-model`, `evok-resources`)
stays at `src/` because execution also uses it.
