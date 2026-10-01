import { ApiError } from "./errors.js";
import {
  providerNames,
  type Config,
  type Message,
  type ProviderName,
} from "./types.js";

export type ChatRequest = {
  model?: string;
  messages: Message[];
  stream: boolean;
  includeUsage: boolean;
};
function invalid(message: string, param: string): never {
  throw new ApiError(400, message, "invalid_request", param);
}
export function parseRequest(body: unknown): ChatRequest {
  if (!body || typeof body !== "object" || Array.isArray(body))
    invalid("Expected a JSON object.", "body");
  const b = body as Record<string, unknown>;
  const allowed = new Set(["model", "messages", "stream", "stream_options"]);
  for (const key of Object.keys(b))
    if (!allowed.has(key)) invalid(`Unsupported parameter: ${key}.`, key);
  if (
    b.model !== undefined &&
    (typeof b.model !== "string" || !b.model.length || b.model.length > 220)
  )
    invalid("model must be a non-empty string.", "model");
  if (
    !Array.isArray(b.messages) ||
    b.messages.length < 1 ||
    b.messages.length > 256
  )
    invalid("messages must contain 1–256 text messages.", "messages");
  const messages: Message[] = b.messages.map((value, index) => {
    if (!value || typeof value !== "object" || Array.isArray(value))
      invalid("Invalid message.", `messages.${index}`);
    const m = value as Record<string, unknown>;
    for (const key of Object.keys(m))
      if (!["role", "content"].includes(key))
        invalid(
          `Unsupported message parameter: ${key}.`,
          `messages.${index}.${key}`,
        );
    if (
      !["system", "developer", "user", "assistant"].includes(m.role as string)
    )
      invalid("Unsupported message role.", `messages.${index}.role`);
    let content = m.content;
    if (Array.isArray(content)) {
      if (
        !content.every(
          (p) =>
            p &&
            typeof p === "object" &&
            p.type === "text" &&
            typeof p.text === "string" &&
            Object.keys(p).every((k) => ["type", "text"].includes(k)),
        )
      )
        invalid(
          "Only text content parts are supported.",
          `messages.${index}.content`,
        );
      content = content.map((p) => p.text).join("\n");
    }
    if (typeof content !== "string")
      invalid("Only text messages are supported.", `messages.${index}.content`);
    return { role: m.role as Message["role"], content };
  });
  if (messages.at(-1)?.role !== "user")
    invalid("The last message must have role user.", "messages");
  if (b.stream !== undefined && typeof b.stream !== "boolean")
    invalid("stream must be boolean.", "stream");
  let includeUsage = false;
  if (b.stream_options !== undefined && b.stream_options !== null) {
    const options = b.stream_options as Record<string, unknown>;
    if (
      !b.stream ||
      typeof options !== "object" ||
      Array.isArray(options) ||
      Object.keys(options).some((k) => k !== "include_usage") ||
      typeof options.include_usage !== "boolean"
    )
      invalid(
        "Only stream_options.include_usage is supported, with stream=true.",
        "stream_options",
      );
    includeUsage = options.include_usage;
  }
  return { model: b.model, messages, stream: b.stream === true, includeUsage };
}
export function resolveModel(model: string, config: Config) {
  const alias = model === "gemini" ? "antigravity" : model;
  const [prefix, ...parts] = alias.split("/");
  if (!providerNames.includes(prefix as ProviderName))
    throw new ApiError(
      400,
      "Use codex, claude, gemini, or provider/model.",
      "invalid_model",
      "model",
    );
  const provider = prefix as ProviderName;
  const settings = config.providers[provider];
  if (!settings.enabled)
    throw new ApiError(
      503,
      "Provider disabled in config.json.",
      "provider_disabled",
      "model",
    );
  const nativeModel = parts.length ? parts.join("/") : settings.defaultModel;
  if (parts.length && !settings.models.includes(nativeModel!))
    throw new ApiError(
      400,
      "Model not configured. Use /v1/models or add it to config.json.",
      "model_not_found",
      "model",
    );
  return {
    provider,
    nativeModel,
    id: nativeModel ? `${provider}/${nativeModel}` : provider,
  };
}
export function buildPrompt(messages: Message[], resumed: boolean): string {
  if (resumed) {
    if (messages.some((m) => m.role !== "user"))
      invalid(
        "With a conversation ID, send only new user messages.",
        "messages",
      );
    return messages.map((m) => m.content).join("\n\n");
  }
  if (messages.length === 1) return messages[0].content;
  return (
    "Answer the final user message using this conversation. Roles and content are encoded as JSON:\n" +
    JSON.stringify(messages)
  );
}
export function listModels(config: Config) {
  return {
    object: "list",
    data: providerNames
      .filter((p) => config.providers[p].enabled)
      .flatMap((provider) =>
        [
          provider,
          ...(provider === "antigravity" ? ["gemini"] : []),
          ...config.providers[provider].models.map((m) => `${provider}/${m}`),
        ].map((id) => ({
          id,
          object: "model",
          created: 0,
          owned_by: provider,
        })),
      ),
  };
}
