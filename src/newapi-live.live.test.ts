/**
 * Opt-in live newapi assertions (control-plane).
 *
 * Default `bun test` excludes `*.live.test.ts`. Live HTTP cases run only when
 * `EVOK_LLM_LIVE_TEST` is `1` or `true` **and** `NEWAPI_API_KEY` is non-empty;
 * otherwise they skip (exit 0). Product live stays `{ live: true }` only.
 *
 * Never echo `NEWAPI_API_KEY`.
 */
import { afterEach, describe, expect, test } from "bun:test";
import {
  ModelNotAllowlistedError,
  NEWAPI_API_KEY_ENV,
  NEWAPI_DEFAULT_MODEL_ENV,
  NEWAPI_LIVE_ENV,
  NewapiClient,
  isAllowlistedModel,
  readNewapiApiKey,
  resolveDefaultNewapiModel,
  type FetchLike,
} from "./newapi-client";
import { SecretRedactor } from "./security-boundary";

const LLM_LIVE_TEST_ENV = "EVOK_LLM_LIVE_TEST";
const LIVE_TEST_TIMEOUT_MS = 25_000;
const REJECTED_MODELS = ["gpt-4", "gpt-4o", "GPT-4o-mini", "claude-3-opus"] as const;

const savedKey = process.env[NEWAPI_API_KEY_ENV];
const savedLive = process.env[NEWAPI_LIVE_ENV];
const savedDefaultModel = process.env[NEWAPI_DEFAULT_MODEL_ENV];
const savedLiveTest = process.env[LLM_LIVE_TEST_ENV];

afterEach(() => {
  restoreEnv(NEWAPI_API_KEY_ENV, savedKey);
  restoreEnv(NEWAPI_LIVE_ENV, savedLive);
  restoreEnv(NEWAPI_DEFAULT_MODEL_ENV, savedDefaultModel);
  restoreEnv(LLM_LIVE_TEST_ENV, savedLiveTest);
});

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

function isLlmLiveTestFlagOn(): boolean {
  const value = process.env[LLM_LIVE_TEST_ENV];
  return value === "1" || value === "true";
}

function shouldRunLiveNewapiAssertions(): boolean {
  return isLlmLiveTestFlagOn() && readNewapiApiKey() !== undefined;
}

function deepSeekOverride(): string | undefined {
  const raw = process.env[NEWAPI_DEFAULT_MODEL_ENV];
  if (typeof raw !== "string" || raw.trim() === "") return undefined;
  const model = raw.trim();
  return model.toLowerCase().startsWith("deepseek") ? model : undefined;
}

function liveTest(name: string, fn: () => void | Promise<void>): void {
  if (!shouldRunLiveNewapiAssertions()) {
    test.skip(name, () => {});
    return;
  }
  test(name, fn, LIVE_TEST_TIMEOUT_MS);
}

function assertNoSecretLeak(value: unknown, redactor: SecretRedactor): void {
  const key = readNewapiApiKey();
  const serialized = JSON.stringify(value);
  expect(serialized).not.toBe("");
  if (key !== undefined) expect(serialized).not.toContain(key);
  expect(redactor.redact(serialized)).not.toMatch(/sk-[A-Za-z0-9_-]+/);
}

async function liveDefaultChat(model?: string): Promise<{
  readonly status: number;
  readonly content: string;
  readonly client: NewapiClient;
  readonly redactor: SecretRedactor;
}> {
  let status = 0;
  const fetchImpl: FetchLike = async (input, init) => {
    const response = await fetch(input, init);
    status = response.status;
    return response;
  };
  delete process.env[NEWAPI_LIVE_ENV];
  const client = new NewapiClient({
    live: true,
    fetch: fetchImpl,
    ...(model === undefined ? {} : { model }),
  });
  const key = readNewapiApiKey();
  const redactor = new SecretRedactor(key === undefined ? [] : [key]);
  try {
    const result = await client.chatCompletions({
      messages: [{ role: "user", content: "Reply with the single word ok." }],
    });
    const content = result.choices[0]?.message.content ?? "";
    assertNoSecretLeak(result, redactor);
    assertNoSecretLeak(client, redactor);
    return { status, content, client, redactor };
  } catch (error) {
    throw redactor.error(error);
  }
}

describe("live newapi opt-in", () => {
  test("rejects GPT* and other non-allowlisted names without a network call", () => {
    let fetches = 0;
    const fetchImpl: FetchLike = async () => {
      fetches += 1;
      throw new Error("allowlist reject must stay offline");
    };
    for (const model of REJECTED_MODELS) {
      expect(isAllowlistedModel(model)).toBe(false);
      expect(() => new NewapiClient({ model, fetch: fetchImpl })).toThrow(ModelNotAllowlistedError);
      expect(() => new NewapiClient({ model, live: true, fetch: fetchImpl })).toThrow(ModelNotAllowlistedError);
    }
    process.env[NEWAPI_DEFAULT_MODEL_ENV] = "gpt-4";
    expect(() => resolveDefaultNewapiModel()).toThrow(ModelNotAllowlistedError);
    expect(fetches).toBe(0);
  });

  liveTest("default chat returns HTTP 200 and non-empty content", async () => {
    delete process.env[NEWAPI_DEFAULT_MODEL_ENV];
    const model = resolveDefaultNewapiModel();
    expect(isAllowlistedModel(model)).toBe(true);
    expect(model.toLowerCase().startsWith("gpt")).toBe(false);

    const { status, content, client } = await liveDefaultChat();
    expect(client.live).toBe(true);
    expect(client.model).toBe(model);
    expect(status).toBe(200);
    expect(content.trim()).not.toBe("");
  });

  if (shouldRunLiveNewapiAssertions() && deepSeekOverride() !== undefined) {
    test("allowlisted DeepSeek* NEWAPI_DEFAULT_MODEL override returns HTTP 200", async () => {
      const model = resolveDefaultNewapiModel();
      expect(model.toLowerCase().startsWith("deepseek")).toBe(true);
      const { status, content, client } = await liveDefaultChat();
      expect(client.model).toBe(model);
      expect(status).toBe(200);
      expect(content.trim()).not.toBe("");
    }, LIVE_TEST_TIMEOUT_MS);
  } else {
    test.skip("allowlisted DeepSeek* NEWAPI_DEFAULT_MODEL override returns HTTP 200", () => {});
  }
});
