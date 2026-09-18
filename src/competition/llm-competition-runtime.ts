/**
 * LLM.1 competition-arm runtime seam.
 * Physical home: `src/competition/` (ET-A5 / #125).
 *
 * `MockLlmCompetitionRuntime` is the default: deterministic `propose`, zero
 * network. Live newapi stays off; enabling it without `NEWAPI_API_KEY` fails
 * closed and never silently falls back to the mock. Live proposal `files`
 * are parseable-only (`parseLiveProposalFiles`).
 *
 * Does not assemble Outer E2E (#81), change gates, unfreeze #40, or change
 * default parent-selection A (tree+fixed_uct).
 */
import { deepFreeze } from "../security-boundary";
import {
  NewapiClient,
  assertAllowlistedModel,
  resolveDefaultNewapiModel,
  resolveNewapiLive,
  type FetchLike,
} from "../newapi-client";
import type { ToyAgentRuntime } from "../toy-harness";
import oofManifest from "../fixtures/methodology/manifest-oof.json";

export const MOCK_LLM_CANDIDATE_FILES: Readonly<Record<string, string>> = deepFreeze({
  score: "1",
  source: "mock-llm-competition",
});

/** Optional mock files: default score plus OOF-present methodology convention key. */
export const MOCK_LLM_METHODOLOGY_FILES: Readonly<Record<string, string>> = deepFreeze({
  ...MOCK_LLM_CANDIDATE_FILES,
  "methodology.json": JSON.stringify(oofManifest),
});

export interface MockLlmCompetitionRuntimeOptions {
  readonly emitMethodologyManifest?: boolean;
}

export class MockLlmCompetitionRuntime implements ToyAgentRuntime {
  readonly #files: Readonly<Record<string, string>>;

  constructor(options: MockLlmCompetitionRuntimeOptions = {}) {
    this.#files = options.emitMethodologyManifest === true
      ? MOCK_LLM_METHODOLOGY_FILES
      : MOCK_LLM_CANDIDATE_FILES;
  }

  selfVerify(_input: Parameters<ToyAgentRuntime["selfVerify"]>[0]): { ok: boolean; objections: string[] } {
    return { ok: true, objections: [] };
  }

  propose(_input: Parameters<ToyAgentRuntime["propose"]>[0]): { files: Record<string, string> } {
    return { files: { ...this.#files } };
  }

  falsify(_input: Parameters<ToyAgentRuntime["falsify"]>[0]): { ok: boolean; objections: string[] } {
    return { ok: true, objections: [] };
  }
}

export class LiveLlmCompetitionRuntime implements ToyAgentRuntime {
  readonly #client: NewapiClient;

  constructor(client: NewapiClient) {
    this.#client = client;
  }

  selfVerify(_input: Parameters<ToyAgentRuntime["selfVerify"]>[0]): { ok: boolean; objections: string[] } {
    return { ok: true, objections: [] };
  }

  async propose(input: Parameters<ToyAgentRuntime["propose"]>[0]): Promise<{ files: Record<string, string> }> {
    const result = await this.#client.chatCompletions({
      messages: [{
        role: "user",
        content: `Produce the candidate. Return JSON {"files":{"score":"number"}} with no prose. Optional files key "methodology.json" (also "manifest.json" / "methodology") is JSON text of the methodology manifest. Objective: ${input.taskContract.objective}`,
      }],
    });
    return { files: parseLiveProposalFiles(result.choices[0]?.message.content ?? "") };
  }

  falsify(_input: Parameters<ToyAgentRuntime["falsify"]>[0]): { ok: boolean; objections: string[] } {
    return { ok: true, objections: [] };
  }
}

export interface LlmCompetitionRuntimeOptions {
  readonly live?: boolean;
  readonly model?: string;
  readonly fetch?: FetchLike;
  /** Mock-only: emit `methodology.json` aligned with the OOF-present fixture. */
  readonly emitMethodologyManifest?: boolean;
}

export function createLlmCompetitionRuntime(options: LlmCompetitionRuntimeOptions = {}): ToyAgentRuntime {
  const model = options.model ?? resolveDefaultNewapiModel();
  assertAllowlistedModel(model);
  if (!resolveNewapiLive(options)) {
    return new MockLlmCompetitionRuntime({
      emitMethodologyManifest: options.emitMethodologyManifest === true,
    });
  }
  return new LiveLlmCompetitionRuntime(new NewapiClient({
    model,
    live: true,
    fetch: options.fetch,
  }));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Live proposal files contract: parseable `{"files":{...}}` only.
 * Malformed JSON, unstructured prose, or missing/empty files fail closed
 * and never fall back to mock candidate files.
 */
export function parseLiveProposalFiles(text: string): Record<string, string> {
  const candidate = text.match(/```(?:json)?\s*([\s\S]*?)```/)?.[1]
    ?? (text.includes("{") ? text.slice(text.indexOf("{")) : "");
  try {
    const parsed: unknown = JSON.parse(candidate.trim());
    const files = isRecord(parsed) ? parsed.files : undefined;
    if (isRecord(files)) {
      const entries = Object.entries(files).map(([key, value]) => [key, String(value)] as const);
      if (entries.length > 0) {
        return Object.fromEntries(entries);
      }
    }
  } catch {
    // fall through to the explicit failure below
  }
  throw new Error("live newapi did not return candidate files");
}
