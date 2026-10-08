import Fastify, { type FastifyRequest } from "fastify";
import { randomUUID } from "node:crypto";
import type { ServerResponse } from "node:http";
import { ApiError, errorBody, providerError } from "./errors.js";
import {
  parseRequest,
  resolveModel,
  buildPrompt,
  listModels,
} from "./protocol.js";
import { workspace } from "./config.js";
import { Store } from "./store.js";
import { Queue } from "./queue.js";
import {
  providerNames,
  type Config,
  type Conversation,
  type Provider,
  type ProviderName,
  type Usage,
} from "./types.js";
import { CodexProvider } from "./providers/codex.js";
import { ClaudeProvider } from "./providers/claude.js";
import { AntigravityProvider } from "./providers/antigravity.js";

async function sendEvent(
  response: ServerResponse,
  data: unknown,
  signal: AbortSignal,
) {
  signal.throwIfAborted();
  const payload = typeof data === "string" ? data : JSON.stringify(data);
  if (response.write(`data: ${payload}\n\n`)) return;
  await new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      response.off("drain", drain);
      signal.removeEventListener("abort", abort);
    };
    const drain = () => {
      cleanup();
      resolve();
    };
    const abort = () => {
      cleanup();
      reject(signal.reason);
    };
    response.once("drain", drain);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
  });
}
export function createServer(
  root: string,
  config: Config,
  providers: Record<ProviderName, Provider> = {
    codex: new CodexProvider(),
    claude: new ClaudeProvider(),
    antigravity: new AntigravityProvider(),
  },
  log: (line: string) => void = console.log,
) {
  const app = Fastify({
    logger: false,
    bodyLimit: 1_048_576,
    forceCloseConnections: true,
  });
  const store = new Store(root);
  const queues = Object.fromEntries(
    providerNames.map((p) => [p, new Queue()]),
  ) as Record<ProviderName, Queue>;
  const active = new Map<AbortController, Promise<void>>();
  const calls = new WeakMap<
    FastifyRequest,
    { provider?: ProviderName; model?: string; error?: string }
  >();
  app.addHook("onRequest", async (request, reply) => {
    const started = performance.now();
    const metadata: {
      provider?: ProviderName;
      model?: string;
      error?: string;
    } = {};
    calls.set(request, metadata);
    let logged = false;
    const complete = (completed: boolean) => {
      if (logged) return;
      logged = true;
      log(
        JSON.stringify({
          time: new Date().toISOString(),
          method: request.method,
          route: request.routeOptions.url ?? "unmatched",
          ...metadata,
          status: reply.raw.statusCode,
          outcome: !completed
            ? "disconnected"
            : metadata.error
              ? "error"
              : "completed",
          durationMs: Math.round(performance.now() - started),
        }),
      );
    };
    reply.raw.once("finish", () => complete(true));
    reply.raw.once("close", () => complete(reply.raw.writableEnded));
  });
  app.setErrorHandler((error, request, reply) => {
    const e = error as { statusCode?: number };
    const publicError =
      error instanceof ApiError
        ? error
        : e.statusCode === 413
          ? new ApiError(413, "Request body is too large.", "request_too_large")
          : e.statusCode === 400
            ? new ApiError(400, "Invalid JSON request.", "invalid_json")
            : new ApiError(500, "Internal server error.", "internal_error");
    calls.get(request)!.error = publicError.code;
    reply.code(publicError.status).send(errorBody(publicError));
  });
  app.setNotFoundHandler((_request, reply) =>
    reply
      .code(404)
      .send(errorBody(new ApiError(404, "Endpoint not found.", "not_found"))),
  );
  app.addHook("preClose", async () => {
    for (const controller of active.keys()) controller.abort();
    await Promise.all(active.values());
  });
  app.get("/health", async () => ({ status: "ok" }));
  app.get("/v1/models", async () => listModels(config));
  app.post("/v1/chat/completions", async (request, reply) => {
    const body = parseRequest(request.body);
    const model = resolveModel(body.model ?? "antigravity", config);
    Object.assign(calls.get(request)!, {
      provider: model.provider,
      model: model.id,
    });
    const header = request.headers["x-conversation-id"];
    if (
      header !== undefined &&
      (typeof header !== "string" || !/^conv_[0-9a-f-]{36}$/.test(header))
    )
      throw new ApiError(
        400,
        "Invalid conversation ID.",
        "invalid_conversation_id",
        "X-Conversation-Id",
      );
    const prompt = buildPrompt(body.messages, !!header);
    const controller = new AbortController();
    let finished!: () => void;
    active.set(
      controller,
      new Promise<void>((resolve) => {
        finished = resolve;
      }),
    );
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort(new Error("timeout"));
    }, config.timeoutMs);
    timer.unref();
    const disconnect = () => {
      if (!reply.raw.writableEnded)
        controller.abort(new Error("client disconnected"));
    };
    reply.raw.once("close", disconnect);
    let release: (() => void) | undefined;
    let conversation: Conversation | undefined;
    let streaming = false;
    let started = false;
    const completionId = `chatcmpl-${randomUUID()}`;
    const created = Math.floor(Date.now() / 1000);
    const chunk = (choices: unknown[], usage?: Usage) => ({
      id: completionId,
      object: "chat.completion.chunk",
      created,
      model: body.model ?? model.id,
      choices,
      ...(body.includeUsage ? { usage: usage ?? null } : {}),
    });
    try {
      release = await queues[model.provider].acquire(controller.signal);
      if (header) {
        conversation = await store.get(header);
        if (
          conversation.provider !== model.provider ||
          conversation.model !== model.id
        )
          throw new ApiError(
            409,
            "A conversation must retain its original provider and model.",
            "conversation_model_mismatch",
            "model",
          );
        if (conversation.status !== "ready" || !conversation.sessionId)
          throw new ApiError(
            409,
            "Conversation was interrupted. Start a new conversation to avoid duplicated provider context.",
            "conversation_interrupted",
          );
      } else {
        const now = new Date().toISOString();
        conversation = {
          id: `conv_${randomUUID()}`,
          provider: model.provider,
          model: model.id,
          nativeModel: model.nativeModel,
          status: "ready",
          createdAt: now,
          updatedAt: now,
          messages: [],
        };
      }
      conversation.status = "running";
      await store.save(conversation);
      started = true;
      reply.header("X-Conversation-Id", conversation.id);
      if (body.stream) {
        reply.hijack();
        reply.raw.writeHead(200, {
          "Content-Type": "text/event-stream; charset=utf-8",
          "Cache-Control": "no-cache",
          "X-Conversation-Id": conversation.id,
          "X-Accel-Buffering": "no",
        });
        streaming = true;
        await sendEvent(
          reply.raw,
          chunk([
            {
              index: 0,
              delta: { role: "assistant", content: "" },
              finish_reason: null,
            },
          ]),
          controller.signal,
        );
      }
      let text = "";
      let usage: Usage | undefined;
      let finishReason = "stop";
      let done = false;
      for await (const event of providers[model.provider].run({
        prompt,
        model: model.nativeModel,
        sessionId: conversation.sessionId,
        workspace: workspace(root, model.provider),
        signal: controller.signal,
      })) {
        controller.signal.throwIfAborted();
        if (event.type === "session" && conversation.sessionId !== event.id) {
          if (conversation.sessionId)
            throw new Error("Provider unexpectedly changed conversation ID");
          conversation.sessionId = event.id;
          await store.save(conversation);
        }
        if (event.type === "text") {
          text += event.text;
          if (text.length > 2_000_000)
            throw new ApiError(
              502,
              "Provider response exceeds the local size limit.",
              "response_too_large",
            );
          if (streaming)
            await sendEvent(
              reply.raw,
              chunk([
                {
                  index: 0,
                  delta: { content: event.text },
                  finish_reason: null,
                },
              ]),
              controller.signal,
            );
        }
        if (event.type === "done") {
          usage = event.usage;
          finishReason = event.finishReason ?? "stop";
          done = true;
        }
      }
      if (!done || !conversation.sessionId)
        throw new Error("Provider ended without a completed session");
      conversation.messages.push(...body.messages, {
        role: "assistant",
        content: text,
      });
      conversation.updatedAt = new Date().toISOString();
      conversation.status = "ready";
      await store.save(conversation);
      started = false;
      if (streaming) {
        await sendEvent(
          reply.raw,
          chunk([{ index: 0, delta: {}, finish_reason: finishReason }]),
          controller.signal,
        );
        if (body.includeUsage && usage)
          await sendEvent(reply.raw, chunk([], usage), controller.signal);
        await sendEvent(reply.raw, "[DONE]", controller.signal);
        reply.raw.end();
      } else {
        return {
          id: completionId,
          object: "chat.completion",
          created,
          model: body.model ?? model.id,
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: text },
              finish_reason: finishReason,
              logprobs: null,
            },
          ],
          ...(usage ? { usage } : {}),
        };
      }
    } catch (error) {
      if (conversation && started) {
        conversation.status = "interrupted";
        conversation.updatedAt = new Date().toISOString();
        await store.save(conversation);
      }
      const publicError = timedOut
        ? new ApiError(504, "Provider request timed out.", "provider_timeout")
        : providerError(error);
      calls.get(request)!.error = publicError.code;
      if (streaming) {
        if (!reply.raw.destroyed) {
          reply.raw.write(
            `data: ${JSON.stringify(errorBody(publicError))}\n\n`,
          );
          reply.raw.end();
        }
      } else if (!reply.raw.destroyed) {
        return reply.code(publicError.status).send(errorBody(publicError));
      }
    } finally {
      clearTimeout(timer);
      reply.raw.off("close", disconnect);
      active.delete(controller);
      finished();
      release?.();
    }
  });
  return app;
}
