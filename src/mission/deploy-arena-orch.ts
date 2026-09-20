/**
 * ET-DEPLOY-ORCH / #182 — control-plane hang for DeployArena.
 *
 * Mission owns the Task Contract switch (`competitionId=deploy-arena`).
 * Competition owns the graph / workers / local aggregation / COI assemble.
 * Evidence owns auto-submit (`attemptContestAutoSubmit`) — this file only
 * wires the COI playground seam into that existing fail-closed path.
 *
 * Not a second control plane. Env never opens live. Execution Pattern C
 * is not thickened. `#40` / Progressive stay opt-in.
 */
import {
  DEPLOY_ARENA_COMPETITION_ID,
  DEPLOY_ARENA_SMOKE_GRAPH,
  assembleDeployArenaSubmission,
  createPlaygroundContestSubmitSeam,
  runDeployArenaGraph,
  type DeployArenaAggregation,
  type DeployArenaCredentials,
  type DeployArenaExec,
  type DeployArenaGraph,
  type DeployArenaGraphResult,
  type DeployArenaServingKnobs,
  type DeployArenaSubmission,
} from "../competition/deploy-arena";
import {
  InMemoryContestAutoSubmitLedger,
  attemptContestAutoSubmit,
  type ContestAutoSubmitAttempt,
  type ContestAutoSubmitInput,
  type ContestAutoSubmitLedger,
  type ContestSubmitSeam,
} from "../evidence/contest-auto-submit";
import { deepFreeze } from "../execution/security-boundary";

export const DEPLOY_ARENA_ORCH_KIND = "deploy-arena-orch" as const;

export interface DeployArenaOrchInput {
  readonly competitionId?: string;
  readonly knobs: DeployArenaServingKnobs;
  readonly graph?: DeployArenaGraph;
  readonly scores?: Readonly<Record<string, Readonly<Record<string, number>>>>;
  readonly gates?: ContestAutoSubmitInput;
  readonly submit?: ContestSubmitSeam;
  readonly ledger?: ContestAutoSubmitLedger;
  readonly live?: boolean;
  readonly credentials?: DeployArenaCredentials;
  readonly exec?: DeployArenaExec;
}

export interface DeployArenaOrchResult {
  readonly kind: typeof DEPLOY_ARENA_ORCH_KIND;
  readonly competitionId: typeof DEPLOY_ARENA_COMPETITION_ID;
  readonly live: boolean;
  readonly graph: DeployArenaGraphResult;
  readonly aggregation: DeployArenaAggregation;
  readonly submission: DeployArenaSubmission;
  readonly autoSubmit: ContestAutoSubmitAttempt;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function credentialsPresent(credentials: DeployArenaCredentials | undefined): boolean {
  return credentials?.playground === true || credentials?.bohr === true;
}

export async function runDeployArenaOrch(input: DeployArenaOrchInput): Promise<DeployArenaOrchResult> {
  if (!isRecord(input)) {
    throw new TypeError("runDeployArenaOrch requires an object");
  }
  if (input.competitionId !== DEPLOY_ARENA_COMPETITION_ID) {
    throw new TypeError(
      "DeployArena orch refuses to open unless competitionId=deploy-arena (fail-closed; AtCoder / default stay closed)",
    );
  }
  const live = input.live === true;
  const graph = await runDeployArenaGraph({
    graph: input.graph ?? DEPLOY_ARENA_SMOKE_GRAPH,
    ...(input.scores === undefined ? {} : { scores: input.scores }),
  });
  const submission = assembleDeployArenaSubmission(input.knobs);
  const ledger = input.ledger ?? new InMemoryContestAutoSubmitLedger();
  const liveCredentialsMissing = live && input.submit === undefined && !credentialsPresent(input.credentials);
  const submit = liveCredentialsMissing
    ? undefined
    : input.submit ?? createPlaygroundContestSubmitSeam({
      credentials: input.credentials,
      exec: input.exec,
      submission,
    });
  const autoSubmit = await attemptContestAutoSubmit({
    ...(input.gates ?? {}),
    live,
    ...(submit === undefined ? {} : { submit }),
    ledger,
  });
  return deepFreeze({
    kind: DEPLOY_ARENA_ORCH_KIND,
    competitionId: DEPLOY_ARENA_COMPETITION_ID,
    live,
    graph,
    aggregation: graph.aggregation,
    submission,
    autoSubmit,
  }) as DeployArenaOrchResult;
}
