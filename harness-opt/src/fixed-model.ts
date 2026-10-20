import fixedModel from "../fixed-model.json";

/**
 * One mapping, read by the evidence gate and checked against the three
 * agent files. Contest id and the local Pi model are the same pinned model.
 * A family prefix such as `qwen-*` is not enough.
 */
export const CONTEST_MODEL_ID: string = fixedModel.contestModelId;
export const LOCAL_MODEL_ID: string = fixedModel.localModelId;
export const TEST_MODEL_ID: string = fixedModel.testModelId;
/** Contest id. Kept for callers that still say `FIXED_MODEL_ID`. */
export const FIXED_MODEL_ID: string = fixedModel.modelId;

export function acceptedModelIds(): readonly string[] {
  return [CONTEST_MODEL_ID, LOCAL_MODEL_ID, TEST_MODEL_ID];
}

export function modelIdMatchesFixed(modelId: string, fixedModelId?: string): boolean {
  if (fixedModelId !== undefined) return modelId === fixedModelId;
  return acceptedModelIds().includes(modelId);
}
