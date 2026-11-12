/**
 * Controller-owned metering relay for delegated children. Physical home: `src/execution/`.
 *
 * A delegated child must never hold the operator's provider credentials, and the
 * controller must be able to attribute what it spent. So the controller starts
 * ONE loopback relay for its own lifetime, registers the unique `evok-meter-*`
 * provider against it BEFORE any child dispatch — the native transport requires
 * that registration — and keeps both until the controller shuts down, so
 * consecutive children reuse one registration instead of one per child call.
 *
 * The relay forwards the child's request to the real provider with the host's
 * resolved credentials (which never leave this process) and records the tokens
 * the children actually consumed. Cost pricing stays with the caller.
 */
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:http";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { ProviderConfig } from "@earendil-works/pi-coding-agent";
import { measureResponseUsage } from "../harness";

/** The extension surface the controller owns; a Pi `ExtensionAPI` satisfies it. */
export interface ChildMeteringHost {
  registerProvider(name: string, config: ProviderConfig): void;
  unregisterProvider(name: string): void;
}

/** Request-time upstream auth the host resolved; it only ever lives in memory. */
export interface ChildMeteringAuth {
  readonly apiKey?: string;
  /** Request-time provider headers; a null value means "not set". */
  readonly headers?: Record<string, string | null>;
  readonly baseUrl?: string;
}

export interface ChildMeteringOptions {
  /** The model the controller itself runs, so children spend the same budget. */
  readonly model: Model<Api>;
  readonly auth: ChildMeteringAuth;
  /**
   * Alias suffix; the provider is registered as `evok-meter-<name>`. Defaults
   * to a unique slug so two controllers in one process never share an alias.
   */
  readonly name?: string;
}

export interface ChildMetering {
  /** Registered provider alias, e.g. `evok-meter-child`. */
  readonly alias: string;
  /** Fully qualified child model, e.g. `evok-meter-child/<model id>`. */
  readonly model: string;
  /** Relay-scoped provider config, for a child that registers its own provider. */
  readonly provider: ProviderConfig;
  /** Tokens the relay has served across every child request so far. */
  usage(): { readonly input: number; readonly output: number };
  dispose(): Promise<void>;
}

/** A child returns text only; anything larger is a hostile or broken request. */
const MAX_BODY = 32 * 1024 * 1024;

export async function createChildMetering(
  host: ChildMeteringHost,
  options: ChildMeteringOptions,
): Promise<ChildMetering> {
  const name = options.name ?? "child-" + randomUUID().slice(0, 8);
  if (!/^[a-z0-9-]+$/.test(name)) throw Error("child metering name must be a lowercase slug");
  const upstream = new URL(options.auth.baseUrl ?? options.model.baseUrl);
  if (upstream.protocol !== "http:" && upstream.protocol !== "https:")
    throw Error("child metering upstream must be an http(s) provider endpoint");
  // Fail before dispatch: an unauthenticated relay would silently spend nothing
  // or leak the child's request to whatever answers on that endpoint.
  if (!options.auth.apiKey && !options.auth.headers)
    throw Error("child metering needs resolved upstream authentication");
  const prefix = upstream.pathname.replace(/\/+$/, "");
  const alias = "evok-meter-" + name;
  const key = randomUUID();
  const usage = { input: 0, output: 0 };
  const server = createServer(async (request, response) => {
    try {
      if (request.method !== "POST") return void response.writeHead(405).end();
      // Loopback is shared: only our own children may spend the host's credentials.
      if (request.headers.authorization !== "Bearer " + key) return void response.writeHead(403).end();
      const path = (request.url ?? "").split("?")[0] ?? "";
      if (!path.startsWith(prefix + "/")) return void response.writeHead(404).end();
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of request) {
        size += chunk.length;
        if (size > MAX_BODY) throw Error("oversized child request");
        chunks.push(Buffer.from(chunk));
      }
      // A child that goes away must not keep spending on the upstream call.
      // The response closes on completion too, so only an unfinished one aborts.
      const stop = new AbortController();
      response.once("close", () => {
        if (!response.writableEnded) stop.abort();
      });
      const forwarded = await fetch(upstream.origin + prefix + path.slice(prefix.length), {
        method: "POST",
        // A redirect could hand the upstream credential to another host.
        redirect: "error",
        signal: stop.signal,
        headers: {
          "content-type": request.headers["content-type"] ?? "application/json",
          ...(typeof request.headers.accept === "string" ? { accept: request.headers.accept } : {}),
          ...(options.auth.apiKey ? { authorization: "Bearer " + options.auth.apiKey } : {}),
          ...Object.fromEntries(
            Object.entries(options.auth.headers ?? {}).filter(([, value]) => value !== null),
          ),
        },
        body: Buffer.concat(chunks),
      });
      const text = await forwarded.text();
      const served = measureResponseUsage(text);
      usage.input += served.input;
      usage.output += served.output;
      response.writeHead(forwarded.status, {
        "content-type": forwarded.headers.get("content-type") ?? "application/json",
      });
      // shortcut: the child response is buffered, not streamed live; tee the body
      // through if a child ever needs incremental tokens or huge outputs.
      response.end(text);
    } catch {
      // Redacted by design: a thrown detail can carry the upstream key.
      if (!response.headersSent && !response.destroyed) response.writeHead(502).end();
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw Error("child metering relay has no loopback port");
  }
  const provider: ProviderConfig = {
    name: "EvoK metered child",
    baseUrl: "http://127.0.0.1:" + address.port + prefix,
    api: options.model.api,
    apiKey: key,
    authHeader: true,
    models: [childModelConfig(options.model)],
  };
  try {
    host.registerProvider(alias, provider);
  } catch (error) {
    server.closeAllConnections();
    server.close();
    throw error;
  }
  return {
    alias,
    model: alias + "/" + options.model.id,
    provider,
    usage: () => ({ ...usage }),
    async dispose() {
      host.unregisterProvider(alias);
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

function childModelConfig(model: Model<Api>): NonNullable<ProviderConfig["models"]>[number] {
  return {
    id: model.id,
    name: model.name,
    api: model.api,
    reasoning: model.reasoning,
    ...(model.thinkingLevelMap ? { thinkingLevelMap: model.thinkingLevelMap } : {}),
    input: model.input,
    cost: model.cost,
    ...(model.promptCache ? { promptCache: model.promptCache } : {}),
    contextWindow: model.contextWindow,
    maxTokens: model.maxTokens,
    ...(model.samplingParams ? { samplingParams: model.samplingParams } : {}),
    ...(model.compat ? { compat: model.compat } : {}),
  };
}
