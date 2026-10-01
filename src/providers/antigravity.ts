import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Provider, ProviderEvent, ProviderInput } from "../types.js";
import { loginEnvironment } from "./environment.js";

export const textAgent = `---
name: llm-server-text
description: Text-only assistant for the local LLM gateway.
tools: []
mainAgent: true
subagent: false
model: inherit
commandExecutionPolicy: off
mcpServers: []
skills: []
plugins: []
---
You are a text-only assistant. Answer the user directly.
No file, command, web, MCP, or delegation tools are permitted.
`;
export async function prepareTextAgent(workspace: string) {
  const directory = join(workspace, ".agents", "agents", "llm-server-text");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await writeFile(join(directory, "agent.md"), textAgent, { mode: 0o600 });
}
export function parseAntigravityEvent(event: any): ProviderEvent[] {
  const result: ProviderEvent[] = [];
  const id =
    event.conversation_id ??
    event.step_update?.conversation_id ??
    event.result?.conversation_id;
  if (typeof id === "string" && id) result.push({ type: "session", id });
  if (
    event.event === "step_update" &&
    typeof event.step_update?.text_delta === "string"
  )
    result.push({ type: "text", text: event.step_update.text_delta });
  if (event.event === "result") {
    const r = event.result;
    if (!r || r.status !== "SUCCESS")
      throw new Error(
        typeof r?.error === "string" ? r.error : "Antigravity execution failed",
      );
    const u = r.usage;
    result.push({
      type: "done",
      usage: u
        ? {
            prompt_tokens: u.input_tokens,
            completion_tokens: u.output_tokens,
            total_tokens: u.total_tokens,
          }
        : undefined,
    });
  }
  return result;
}
export class AntigravityProvider implements Provider {
  async *run(input: ProviderInput): AsyncGenerator<ProviderEvent> {
    await prepareTextAgent(input.workspace);
    const args = [
      "--input-format",
      "stream-json",
      "--agent",
      "llm-server-text",
      "--output-format",
      "stream-json",
      "--disable-slash-commands",
      "--mode",
      "plan",
      "--sandbox",
      "--add-dir",
      input.workspace,
    ];
    if (input.model) args.push("--model", input.model);
    if (input.sessionId) args.push("--conversation", input.sessionId);
    const child = spawn("agy", args, {
      cwd: input.workspace,
      env: loginEnvironment(),
      stdio: ["pipe", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr = (stderr + chunk.toString()).slice(-8192);
    });
    const exited = new Promise<{ code: number | null; error?: Error }>(
      (resolve) => {
        child.once("error", (error) => resolve({ code: null, error }));
        child.once("close", (code) => resolve({ code }));
      },
    );
    function kill(signal: NodeJS.Signals) {
      if (!child.pid) return;
      try {
        if (process.platform !== "win32") process.kill(-child.pid, signal);
        else child.kill(signal);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
      }
    }
    let escalation: NodeJS.Timeout | undefined;
    const abort = () => {
      kill("SIGTERM");
      escalation = setTimeout(() => kill("SIGKILL"), 2000);
      escalation.unref();
    };
    input.signal.addEventListener("abort", abort, { once: true });
    if (input.signal.aborted) abort();
    let inputError: Error | undefined;
    child.stdin.on("error", (error) => {
      inputError = error;
    });
    child.stdin.end(
      JSON.stringify({ event: "user", message: { content: input.prompt } }) +
        "\n",
    );
    const lines = createInterface({ input: child.stdout });
    let text = "";
    let done = false;
    try {
      for await (const line of lines) {
        if (line.length > 2_000_000)
          throw new Error("Antigravity event too large");
        const event = JSON.parse(line);
        for (const parsed of parseAntigravityEvent(event)) {
          if (parsed.type === "text") text += parsed.text;
          if (parsed.type === "done") {
            if (!text && typeof event.result.response === "string")
              yield { type: "text", text: event.result.response };
            done = true;
          }
          yield parsed;
        }
      }
      const exit = await exited;
      if (exit.error) throw exit.error;
      if (inputError) throw inputError;
      if (exit.code !== 0 || !done)
        throw new Error(stderr || "Antigravity did not finish");
    } finally {
      input.signal.removeEventListener("abort", abort);
      lines.close();
      kill("SIGKILL");
      if (escalation) clearTimeout(escalation);
      await exited;
    }
  }
}
