import type { Scorecard, SearchGenes } from "../types";

/**
 * Promotion swap point.
 *
 * TODO(harness-opt/design/2026-10-18-evolution-selector-solutions.md §④):
 * replace the staged-threshold body with paired evaluation + confidence
 * interval lower bound + successive halving. Keep `StagedThresholds` as
 * the input the new criterion reads, and do not hard-code the comparison
 * inside the orchestrator.
 *
 * Pure greedy is registered so tests can show it is not the default.
 * AFlow / DGM / UCT parent samplers stay unimplemented until that doc
 * names the P0/P1/P2 combo. Calling them throws; it does not pretend to sample.
 */

export interface StagedThresholds {
  readonly minScoreDelta: number;
  readonly maxTokenRegressionRatio: number;
}

/** One point on the 0–100 contest scale, and no token regression. */
export const DEFAULT_STAGED_THRESHOLDS: StagedThresholds = {
  minScoreDelta: 1,
  maxTokenRegressionRatio: 1,
};

export interface SelectorSearchConfig {
  /** How many archive parents a sampler would draw. Searchable, not a constant. */
  readonly sampleCount: number;
  readonly temperature: number;
  readonly uctExploration: number;
}

export const DEFAULT_SELECTOR_SEARCH: SelectorSearchConfig = {
  sampleCount: 1,
  temperature: 1,
  uctExploration: 1.414,
};

export interface PromotionInput {
  readonly parent: Scorecard | null;
  readonly candidate: Scorecard;
  readonly thresholds: StagedThresholds;
  readonly genes: SearchGenes;
  readonly search: SelectorSearchConfig;
}

export interface PromotionDecision {
  readonly accept: boolean;
  readonly criterionId: string;
  readonly reason: string;
  readonly genes: SearchGenes;
}

export interface PromotionCriterion {
  readonly id: string;
  decide(input: PromotionInput): PromotionDecision;
}

export const STAGED_THRESHOLD_ID = "staged-threshold";
export const GREEDY_ID = "greedy";
export const PAIRED_CI_HALVING_ID = "paired-ci-halving";

/** Default is staged keep-better, not pure greedy. */
export const DEFAULT_SELECTOR_ID = STAGED_THRESHOLD_ID;

export class StagedThresholdCriterion implements PromotionCriterion {
  readonly id = STAGED_THRESHOLD_ID;

  decide(input: PromotionInput): PromotionDecision {
    return finish(this.id, input, stagedReason(input));
  }
}

export class GreedyCriterion implements PromotionCriterion {
  readonly id = GREEDY_ID;

  decide(input: PromotionInput): PromotionDecision {
    if (!eligible(input.candidate)) {
      return finish(this.id, input, eligibleReason(input.candidate));
    }
    if (input.parent === null) return finish(this.id, input, null);
    const delta = input.candidate.devScore - input.parent.devScore;
    if (delta <= 0) return finish(this.id, input, "greedy requires a strictly higher dev score");
    return finish(this.id, input, null);
  }
}

/**
 * Reserved id for evolution-selector §④.
 * Refuses every candidate so an unfinished criterion cannot promote.
 */
export class PairedCiHalvingCriterion implements PromotionCriterion {
  readonly id = PAIRED_CI_HALVING_ID;

  decide(input: PromotionInput): PromotionDecision {
    return finish(
      this.id,
      input,
      "TODO(evolution-selector §④): paired evaluation + CI lower bound + successive halving is not implemented",
    );
  }
}

export type SamplerId = "greedy" | "aflow-sample" | "dgm-sample" | "uct";

export interface ParentSampler {
  readonly id: SamplerId;
  sample(archiveIds: readonly string[], config: SelectorSearchConfig): readonly string[];
}

export function greedySampler(): ParentSampler {
  return {
    id: "greedy",
    sample(archiveIds) {
      const top = archiveIds[0];
      return top === undefined ? [] : [top];
    },
  };
}

export function unimplementedSampler(id: Exclude<SamplerId, "greedy">): ParentSampler {
  return {
    id,
    sample() {
      throw new Error(
        `TODO(harness-opt/design/2026-10-18-evolution-selector-solutions.md): ${id} parent sampling is not implemented in this skeleton`,
      );
    },
  };
}

const CRITERIA: Readonly<Record<string, PromotionCriterion>> = {
  [STAGED_THRESHOLD_ID]: new StagedThresholdCriterion(),
  [GREEDY_ID]: new GreedyCriterion(),
  [PAIRED_CI_HALVING_ID]: new PairedCiHalvingCriterion(),
};

const SAMPLERS: Readonly<Record<SamplerId, ParentSampler>> = {
  greedy: greedySampler(),
  "aflow-sample": unimplementedSampler("aflow-sample"),
  "dgm-sample": unimplementedSampler("dgm-sample"),
  uct: unimplementedSampler("uct"),
};

export function getPromotionCriterion(id: string = DEFAULT_SELECTOR_ID): PromotionCriterion {
  const criterion = CRITERIA[id];
  if (!criterion) throw new Error(`unknown promotion criterion: ${id}`);
  return criterion;
}

export function getParentSampler(id: SamplerId): ParentSampler {
  return SAMPLERS[id];
}

function stagedReason(input: PromotionInput): string | null {
  const blocked = eligibleReason(input.candidate);
  if (blocked) return blocked;
  if (input.parent === null) return null;
  const delta = input.candidate.devScore - input.parent.devScore;
  if (delta < input.thresholds.minScoreDelta) {
    return `dev delta ${delta} is below staged min ${input.thresholds.minScoreDelta}`;
  }
  const tokenCap = input.parent.tokens * input.thresholds.maxTokenRegressionRatio;
  if (input.candidate.tokens > tokenCap) {
    return `token cost ${input.candidate.tokens} exceeds staged cap ${tokenCap}`;
  }
  return null;
}

function eligible(card: Scorecard): boolean {
  return Number.isFinite(card.devScore) && card.attributionComplete;
}

function eligibleReason(card: Scorecard): string | null {
  if (!Number.isFinite(card.devScore)) return "candidate dev score is not finite";
  if (!card.attributionComplete) return "attribution coverage is incomplete";
  return null;
}

function finish(id: string, input: PromotionInput, reason: string | null): PromotionDecision {
  if (reason === null) {
    return { accept: true, criterionId: id, reason: `${id} accepted the candidate`, genes: input.genes };
  }
  return { accept: false, criterionId: id, reason, genes: input.genes };
}
