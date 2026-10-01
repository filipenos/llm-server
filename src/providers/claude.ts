import { query } from "@anthropic-ai/claude-agent-sdk";
import type { Provider, ProviderEvent, ProviderInput } from "../types.js";
import { loginEnvironment } from "./environment.js";

export class ClaudeProvider implements Provider {
  async *run(input: ProviderInput): AsyncGenerator<ProviderEvent> {
    const controller = new AbortController();
    const abort = () => controller.abort();
    input.signal.addEventListener("abort", abort, { once: true });
    if (input.signal.aborted) controller.abort();
    const conversation = query({
      prompt: input.prompt,
      options: {
        cwd: input.workspace,
        model: input.model,
        resume: input.sessionId,
        abortController: controller,
        tools: [],
        mcpServers: {},
        strictMcpConfig: true,
        settingSources: [],
        permissionMode: "dontAsk",
        includePartialMessages: true,
        env: { ...loginEnvironment(), CLAUDE_CODE_SAFE_MODE: "1" },
        canUseTool: async () => ({
          behavior: "deny",
          message: "Tools are disabled in llm-server.",
        }),
        systemPrompt:
          "You are a helpful text assistant. Answer the user directly. No tools are available.",
      },
    });
    let streamed = "";
    try {
      for await (const event of conversation) {
        if ("session_id" in event && event.session_id)
          yield { type: "session", id: event.session_id };
        if (
          event.type === "stream_event" &&
          event.event.type === "content_block_delta" &&
          event.event.delta.type === "text_delta"
        ) {
          const text = event.event.delta.text;
          streamed += text;
          yield { type: "text", text };
        }
        if (event.type === "result") {
          if (event.subtype !== "success")
            throw new Error(event.errors.join("\n"));
          if (event.is_error) throw new Error(event.result);
          if (!streamed && event.result)
            yield { type: "text", text: event.result };
          const u = event.usage;
          const prompt =
            u.input_tokens +
            (u.cache_read_input_tokens ?? 0) +
            (u.cache_creation_input_tokens ?? 0);
          yield {
            type: "done",
            usage: {
              prompt_tokens: prompt,
              completion_tokens: u.output_tokens,
              total_tokens: prompt + u.output_tokens,
            },
            finishReason:
              event.stop_reason === "max_tokens" ? "length" : "stop",
          };
        }
      }
    } finally {
      input.signal.removeEventListener("abort", abort);
      conversation.close();
    }
  }
}
