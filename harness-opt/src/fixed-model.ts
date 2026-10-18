import fixedModel from "../fixed-model.json";

/**
 * One contest model id, written in `fixed-model.json`.
 * The evidence gate and the three LLM agents match this string exactly.
 * A family prefix such as `qwen-*` is not enough (PRD §2, §5.3.2 item 5).
 */
export const FIXED_MODEL_ID: string = fixedModel.modelId;

export function modelIdMatchesFixed(modelId: string, fixedModelId: string = FIXED_MODEL_ID): boolean {
  return modelId === fixedModelId;
}
