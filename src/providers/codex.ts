import { Codex } from "@openai/codex-sdk";
import { fileURLToPath } from "node:url";
import type { Provider, ProviderEvent, ProviderInput } from "../types.js";
import { loginEnvironment } from "./environment.js";

export class CodexProvider implements Provider {
  async *run(input: ProviderInput): AsyncGenerator<ProviderEvent> {
    const codex = new Codex({
      codexPathOverride: fileURLToPath(
        new URL("../../scripts/codex-runner.sh", import.meta.url),
      ),
      env: loginEnvironment(),
      config: {
        features: {
          shell_tool: false,
          unified_exec: false,
          apply_patch_freeform: false,
        },
        apps: { _default: { enabled: false } },
        project_doc_max_bytes: 0,
      },
    });
    const options = {
      model: input.model,
      sandboxMode: "read-only" as const,
      workingDirectory: input.workspace,
      skipGitRepoCheck: true,
      approvalPolicy: "never" as const,
      networkAccessEnabled: false,
      webSearchMode: "disabled" as const,
    };
    const thread = input.sessionId
      ? codex.resumeThread(input.sessionId, options)
      : codex.startThread(options);
    const stream = await thread.runStreamed(input.prompt, {
      signal: input.signal,
    });
    const texts = new Map<string, string>();
    for await (const event of stream.events) {
      if (event.type === "thread.started")
        yield { type: "session", id: event.thread_id };
      if (event.type === "item.updated" || event.type === "item.completed") {
        if (event.item.type === "agent_message") {
          const previous = texts.get(event.item.id) ?? "";
          const text = event.item.text;
          if (!text.startsWith(previous))
            throw new Error("Provider rewrote streamed text");
          texts.set(event.item.id, text);
          if (text.length > previous.length)
            yield { type: "text", text: text.slice(previous.length) };
        }
      }
      if (event.type === "turn.completed") {
        yield {
          type: "done",
          usage: {
            prompt_tokens: event.usage.input_tokens,
            completion_tokens: event.usage.output_tokens,
            total_tokens: event.usage.input_tokens + event.usage.output_tokens,
          },
        };
      }
      if (event.type === "turn.failed") throw new Error(event.error.message);
      if (event.type === "error") throw new Error(event.message);
    }
  }
}
