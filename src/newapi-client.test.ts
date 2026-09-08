import { afterEach, describe, expect, test } from "bun:test";
import {
  DEFAULT_NEWAPI_MODEL,
  LiveLlmKeyMissingError,
  ModelNotAllowlistedError,
  NEWAPI_API_KEY_ENV,
  NEWAPI_BASE_URL,
  NEWAPI_DEFAULT_MODEL_ENV,
  NEWAPI_LIVE_ENV,
  NewapiClient,
  isAllowlistedModel,
  isNewapiLiveEnabled,
  resolveDefaultNewapiModel,
} from "./newapi-client";

const ALLOWLISTED = ["DeepSeek-V3", "DeepSeek-R1", "deepseek-chat", "Gemini-2.5-pro", "gemini-2.0-flash"] as const;
const REJECTED = ["gpt-4", "gpt-3.5-turbo", "GPT-4o", "claude-3-opus", "llama-3", "o1-preview", ""] as const;
const CATALOG_DEFAULT_MODEL = "deepseek-v4-flash-ga-260731";

const savedKey = process.env[NEWAPI_API_KEY_ENV];
const savedLive = process.env[NEWAPI_LIVE_ENV];
const savedDefaultModel = process.env[NEWAPI_DEFAULT_MODEL_ENV];

afterEach(() => {
  if (savedKey === undefined) delete process.env[NEWAPI_API_KEY_ENV];
  else process.env[NEWAPI_API_KEY_ENV] = savedKey;
  if (savedLive === undefined) delete process.env[NEWAPI_LIVE_ENV];
  else process.env[NEWAPI_LIVE_ENV] = savedLive;
  if (savedDefaultModel === undefined) delete process.env[NEWAPI_DEFAULT_MODEL_ENV];
  else process.env[NEWAPI_DEFAULT_MODEL_ENV] = savedDefaultModel;
});

describe("newapi model allowlist", () => {
  test("accepts DeepSeek* and Gemini* names without hitting the network", () => {
    delete process.env[NEWAPI_API_KEY_ENV];
    delete process.env[NEWAPI_LIVE_ENV];
    let fetches = 0;
    const fetchImpl: typeof fetch = async () => {
      fetches += 1;
      throw new Error("network must not run for allowlist");
    };

    for (const model of ALLOWLISTED) {
      expect(isAllowlistedModel(model)).toBe(true);
      const client = new NewapiClient({ model, fetch: fetchImpl });
      expect(client.model).toBe(model);
      expect(client.live).toBe(false);
      expect(client.baseURL).toBe(NEWAPI_BASE_URL);
    }
    expect(fetches).toBe(0);
  });

  test("rejects gpt-* and other non-allowlisted names at client construct", () => {
    for (const model of REJECTED) {
      expect(isAllowlistedModel(model)).toBe(false);
      expect(() => new NewapiClient({ model })).toThrow(ModelNotAllowlistedError);
    }
  });
});

describe("newapi default model", () => {
  test("unspecified model resolves to the live-catalog DeepSeek flash id", () => {
    delete process.env[NEWAPI_DEFAULT_MODEL_ENV];
    delete process.env[NEWAPI_LIVE_ENV];
    delete process.env[NEWAPI_API_KEY_ENV];
    expect(DEFAULT_NEWAPI_MODEL).toBe(CATALOG_DEFAULT_MODEL);
    expect(isAllowlistedModel(CATALOG_DEFAULT_MODEL)).toBe(true);
    expect(resolveDefaultNewapiModel()).toBe(CATALOG_DEFAULT_MODEL);
    expect(new NewapiClient({}).model).toBe(CATALOG_DEFAULT_MODEL);
    process.env[NEWAPI_DEFAULT_MODEL_ENV] = "   ";
    expect(resolveDefaultNewapiModel()).toBe(CATALOG_DEFAULT_MODEL);
  });

  test("NEWAPI_DEFAULT_MODEL overrides the constant when allowlisted", () => {
    process.env[NEWAPI_DEFAULT_MODEL_ENV] = "  Gemini-2.5-pro  ";
    expect(resolveDefaultNewapiModel()).toBe("Gemini-2.5-pro");
    expect(new NewapiClient({}).model).toBe("Gemini-2.5-pro");
    expect(new NewapiClient({ model: "deepseek-chat" }).model).toBe("deepseek-chat");
  });

  test("NEWAPI_DEFAULT_MODEL gpt-* and other non-allowlisted names fail closed", () => {
    for (const model of ["gpt-4", "gpt-4o", "claude-3-opus", "llama-3"] as const) {
      process.env[NEWAPI_DEFAULT_MODEL_ENV] = model;
      expect(() => resolveDefaultNewapiModel()).toThrow(ModelNotAllowlistedError);
      expect(() => new NewapiClient({})).toThrow(ModelNotAllowlistedError);
    }
  });
});

describe("newapi live path", () => {
  test("is off by default and does not send chat/completions", async () => {
    delete process.env[NEWAPI_LIVE_ENV];
    delete process.env[NEWAPI_API_KEY_ENV];
    expect(isNewapiLiveEnabled()).toBe(false);

    let fetches = 0;
    const client = new NewapiClient({
      model: "DeepSeek-V3",
      fetch: async () => {
        fetches += 1;
        return new Response("{}", { status: 200 });
      },
    });
    expect(client.live).toBe(false);
    await expect(client.chatCompletions({
      messages: [{ role: "user", content: "hi" }],
    })).rejects.toThrow(/live|disabled|off/i);
    expect(fetches).toBe(0);
  });

  test("fails closed when live is enabled without NEWAPI_API_KEY", () => {
    delete process.env[NEWAPI_API_KEY_ENV];
    expect(() => new NewapiClient({ model: "DeepSeek-V3", live: true })).toThrow(LiveLlmKeyMissingError);

    process.env[NEWAPI_LIVE_ENV] = "1";
    expect(() => new NewapiClient({ model: "DeepSeek-V3" })).toThrow(LiveLlmKeyMissingError);
  });

  test("sends an OpenAI-compatible chat/completions request and never echoes the key", async () => {
    const secret = "sk-newapi-test-secret-do-not-echo";
    process.env[NEWAPI_API_KEY_ENV] = secret;
    let url = "";
    let method = "";
    let body = "";
    const client = new NewapiClient({
      model: "DeepSeek-V3",
      live: true,
      fetch: async (input, init) => {
        url = String(input);
        method = String(init?.method ?? "");
        body = String(init?.body ?? "");
        return new Response(JSON.stringify({
          id: "cmpl-1",
          choices: [{ message: { role: "assistant", content: "{\"files\":{\"score\":\"2\"}}" } }],
        }), { status: 200, headers: { "content-type": "application/json" } });
      },
    });

    const result = await client.chatCompletions({
      messages: [{ role: "user", content: "propose" }],
    });

    expect(url).toBe(`${NEWAPI_BASE_URL}/chat/completions`);
    expect(method.toUpperCase()).toBe("POST");
    expect(body).toContain("DeepSeek-V3");
    expect(body).not.toContain(secret);
    expect(result.choices[0]?.message.content).toContain("score");
    expect(JSON.stringify(client)).not.toContain(secret);
    expect(String(client)).not.toContain(secret);
  });

  test("redacts the API key from live request errors", async () => {
    const secret = "sk-newapi-error-secret-do-not-echo";
    process.env[NEWAPI_API_KEY_ENV] = secret;
    const client = new NewapiClient({
      model: "Gemini-2.5-pro",
      live: true,
      fetch: async () => {
        throw new Error(`upstream rejected ${secret}`);
      },
    });

    let message = "";
    try {
      await client.chatCompletions({ messages: [{ role: "user", content: "x" }] });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).not.toBe("");
    expect(message).not.toContain(secret);
    expect(message).toMatch(/REDACTED|upstream/i);
  });
});
