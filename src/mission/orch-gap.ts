/**
 * ET-ORCH-GAP / #181 — control-plane orchestration-gap glue.
 *
 * Lands existing ports without flipping product defaults:
 * - #27 ModelOrchestra thin impl (`runModelOrchestra`)
 * - #98 golden-path glue (`runGoldenPath`) — callable, not auto-run
 * - #99 StrongSearch opt-in port — default stays `fixed_uct`
 *
 * This is not a second control plane, not DeployArena, and not Promotion
 * authority. Progressive / StrongSearch stay explicit opt-in. `#40` stays
 * off unless Mission/config opts in. Env never flips the default.
 */
import { deepFreeze } from "../execution/security-boundary";
import {
  runModelOrchestra,
  type ModelCatalog,
  type OrchestraConfig,
  type OrchestraResolution,
  type OrchestraResolveContext,
} from "../execution/model-orchestra";
import {
  resolveSearchSelection,
  type MissionSearchSelectionSource,
  type ResolvedSearchSelection,
} from "../search/progressive-opt-in";
import {
  runGoldenPath,
  type AssembleV1GoldenPathInput,
  type V1GoldenPath,
} from "./v1-golden-path";

export const ORCH_GAP_KIND = "orch-gap" as const;
export const ORCHESTRA_KIND_THIN_IMPL = "thin-impl" as const;

export type OrchGapGoldenPathInput = boolean | AssembleV1GoldenPathInput;

export interface OrchGapInput {
  readonly catalog: ModelCatalog;
  readonly orchestra?: OrchestraConfig | null;
  readonly orchestraContext?: OrchestraResolveContext;
  /** Landed glue. Omit / false does not run hang. `true` or an object runs mock-default `runGoldenPath`. */
  readonly goldenPath?: OrchGapGoldenPathInput;
  /** Explicit Mission/config search opt-in. Absent stays `fixed_uct`. */
  readonly searchSelection?: MissionSearchSelectionSource;
}

export interface OrchGapResult {
  readonly kind: typeof ORCH_GAP_KIND;
  readonly orchestraKind: typeof ORCHESTRA_KIND_THIN_IMPL;
  readonly orchestra: OrchestraResolution;
  readonly search: ResolvedSearchSelection;
  readonly goldenPathLanded: true;
  readonly goldenPath?: V1GoldenPath;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function goldenPathInput(value: OrchGapGoldenPathInput | undefined): AssembleV1GoldenPathInput | undefined {
  if (value === undefined || value === false) return undefined;
  if (value === true) return {};
  if (!isRecord(value)) throw new TypeError("goldenPath must be a boolean or an ordinary object");
  return value;
}

/**
 * Control-plane one-shot for the three orchestration-gap ports.
 * Default: unconfigured orchestra, no golden-path run, `fixed_uct`.
 */
export async function runOrchGap(input: OrchGapInput): Promise<OrchGapResult> {
  if (!isRecord(input) || input.catalog === undefined) {
    throw new TypeError("runOrchGap requires a ModelCatalog");
  }
  const orchestra = runModelOrchestra(input.catalog, input.orchestra, input.orchestraContext ?? {});
  const search = resolveSearchSelection(input.searchSelection);
  const goldenInput = goldenPathInput(input.goldenPath);
  const goldenPath = goldenInput === undefined ? undefined : await runGoldenPath(goldenInput);
  return deepFreeze({
    kind: ORCH_GAP_KIND,
    orchestraKind: ORCHESTRA_KIND_THIN_IMPL,
    orchestra,
    search,
    goldenPathLanded: true,
    ...(goldenPath === undefined ? {} : { goldenPath }),
  }) as OrchGapResult;
}
