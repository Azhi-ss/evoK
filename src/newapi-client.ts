/**
 * OpenAI-compatible newapi client skeleton (LLM.1 control-plane).
 *
 * Live is **off** unless `{ live: true }` or `EVOK_NEWAPI_LIVE=1|true`.
 * The API key is read-only from `process.env.NEWAPI_API_KEY` and must never
 * be written to logs, ledger events, PRs, or agent memory.
 *
 * Allowlist: DeepSeek* / Gemini* only. GPT* and every other name is rejected
 * at construct (or before propose via the runtime factory).
 */
import { SecretRedactor } from "./security-boundary";

export const NEWAPI_BASE_URL = "https://newapi.ai-modeling.top/v1";
/** Read-only secret. Never commit a value; never echo it. */
export const NEWAPI_API_KEY_ENV = "NEWAPI_API_KEY";
/** Opt-in live switch. Unset / anything other than `1` or `true` keeps live off. */
export const NEWAPI_LIVE_ENV = "EVOK_NEWAPI_LIVE";
export const DEFAULT_NEWAPI_MODEL = "DeepSeek-V3";

export type ProcessEnvLike = Record<string, string | undefined>;
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export class ModelNotAllowlistedError extends Error {
  readonly model: string;

  constructor(model: string) {
    super(`model is not allowlisted: ${model}`);
    this.name = "ModelNotAllowlistedError";
    this.model = model;
  }
}

export class LiveLlmKeyMissingError extends Error {
  constructor() {
    super(`${NEWAPI_API_KEY_ENV} is required when live newapi is enabled`);
    this.name = "LiveLlmKeyMissingError";
  }
}

function envOf(env?: ProcessEnvLike): ProcessEnvLike {
  return env ?? process.env;
}

export function isAllowlistedModel(model: string): boolean {
  if (typeof model !== "string") return false;
  const name = model.trim();
  if (name === "") return false;
  const lower = name.toLowerCase();
  return lower.startsWith("deepseek") || lower.startsWith("gemini");
}

export function assertAllowlistedModel(model: string): void {
  if (!isAllowlistedModel(model)) {
    throw new ModelNotAllowlistedError(typeof model === "string" ? model : "");
  }
}

export function isNewapiLiveEnabled(env?: ProcessEnvLike): boolean {
  const value = envOf(env)[NEWAPI_LIVE_ENV];
  return value === "1" || value === "true";
}

export function readNewapiApiKey(env?: ProcessEnvLike): string | undefined {
  const key = envOf(env)[NEWAPI_API_KEY_ENV];
  if (typeof key !== "string" || key.trim() === "") return undefined;
  return key;
}

export function resolveNewapiLive(options: { readonly live?: boolean; readonly env?: ProcessEnvLike } = {}): boolean {
  if (options.live === true) return true;
  if (options.live === false) return false;
  return isNewapiLiveEnabled(options.env);
}

export interface ChatMessage {
  readonly role: "system" | "user" | "assistant";
  readonly content: string;
}

export interface ChatCompletionsRequest {
  readonly messages: readonly ChatMessage[];
  readonly model?: string;
}

export interface ChatCompletionsChoice {
  readonly message: { readonly role: string; readonly content: string };
}

export interface ChatCompletionsResponse {
  readonly id?: string;
  readonly choices: readonly ChatCompletionsChoice[];
}

export interface NewapiClientOptions {
  readonly model: string;
  /** Default false. Live also turns on when `EVOK_NEWAPI_LIVE` is `1` or `true`. */
  readonly live?: boolean;
  readonly env?: ProcessEnvLike;
  readonly fetch?: FetchLike;
  readonly baseURL?: string;
}

export class NewapiClient {
  readonly baseURL: string;
  readonly model: string;
  readonly live: boolean;
  readonly #apiKey: string | undefined;
  readonly #fetch: FetchLike;
  readonly #redactor: SecretRedactor;

  constructor(options: NewapiClientOptions) {
    assertAllowlistedModel(options.model);
    this.model = options.model.trim();
    this.baseURL = (options.baseURL ?? NEWAPI_BASE_URL).replace(/\/$/, "");
    this.live = resolveNewapiLive(options);
    this.#fetch = options.fetch ?? ((input, init) => fetch(input, init));
    const key = this.live ? readNewapiApiKey(options.env) : undefined;
    if (this.live && key === undefined) throw new LiveLlmKeyMissingError();
    this.#apiKey = key;
    this.#redactor = new SecretRedactor(key === undefined ? [] : [key]);
  }

  async chatCompletions(request: ChatCompletionsRequest): Promise<ChatCompletionsResponse> {
    if (!this.live || this.#apiKey === undefined) {
      throw new Error("live newapi is disabled");
    }
    const model = request.model ?? this.model;
    assertAllowlistedModel(model);
    try {
      const response = await this.#fetch(`${this.baseURL}/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${this.#apiKey}`,
        },
        body: JSON.stringify({ model, messages: request.messages }),
      });
      if (!response.ok) {
        throw new Error(`newapi chat/completions failed with status ${response.status}`);
      }
      const payload: unknown = await response.json();
      if (!isChatCompletionsResponse(payload)) {
        throw new Error("newapi chat/completions returned a malformed response");
      }
      return payload;
    } catch (error) {
      throw this.#redactor.error(error);
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isChatCompletionsResponse(value: unknown): value is ChatCompletionsResponse {
  if (!isRecord(value) || !Array.isArray(value.choices)) return false;
  return value.choices.every((choice) => {
    if (!isRecord(choice) || !isRecord(choice.message)) return false;
    return typeof choice.message.role === "string" && typeof choice.message.content === "string";
  });
}
