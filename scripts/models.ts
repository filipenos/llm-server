import { promisify } from "node:util";
import { execFile, spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { writeFile, rename } from "node:fs/promises";
import { join } from "node:path";
import { query } from "@anthropic-ai/claude-agent-sdk";
import {
  dataDirectory,
  loadConfig,
  workspace,
  validateConfig,
} from "../src/config.js";
import { loginEnvironment } from "../src/providers/environment.js";
import { providerError } from "../src/errors.js";

async function codexModels(): Promise<string[]> {
  const child = spawn("codex", ["app-server", "--stdio"], {
    env: loginEnvironment(),
    stdio: ["pipe", "pipe", "ignore"],
  });
  const lines = createInterface({ input: child.stdout });
  let nextId = 0;
  const pending = new Map<
    number,
    { resolve: (result: any) => void; reject: (error: Error) => void }
  >();
  const fail = () => {
    for (const p of pending.values())
      p.reject(new Error("Model discovery failed"));
    pending.clear();
  };
  child.on("error", fail);
  child.on("exit", fail);
  lines.on("line", (line) => {
    try {
      const message = JSON.parse(line);
      const p = pending.get(message.id);
      if (!p) return;
      pending.delete(message.id);
      if (message.error) p.reject(new Error("Model discovery failed"));
      else p.resolve(message.result);
    } catch {
      fail();
    }
  });
  child.stdin.on("error", fail);
  function rpc(method: string, params: unknown): Promise<any> {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      child.stdin.write(JSON.stringify({ id, method, params }) + "\n");
    });
  }
  const timer = setTimeout(() => {
    fail();
    child.kill("SIGKILL");
  }, 15000);
  try {
    await rpc("initialize", {
      clientInfo: {
        name: "llm_server",
        title: "Local LLM Server",
        version: "1.0.0",
      },
    });
    child.stdin.write(JSON.stringify({ method: "initialized" }) + "\n");
    const models: string[] = [];
    let cursor: string | undefined;
    do {
      const result = await rpc("model/list", {
        limit: 100,
        includeHidden: false,
        ...(cursor ? { cursor } : {}),
      });
      models.push(...result.data.map((m: { model: string }) => m.model));
      cursor = result.nextCursor ?? undefined;
    } while (cursor);
    return [...new Set(models)];
  } finally {
    clearTimeout(timer);
    lines.close();
    child.kill("SIGKILL");
  }
}
async function claudeModels(root: string): Promise<string[]> {
  const controller = new AbortController();
  // Initialize the official SDK without sending a generation request.
  async function* idle(): AsyncGenerator<never> {
    await new Promise<void>((resolve) =>
      controller.signal.addEventListener("abort", () => resolve(), {
        once: true,
      }),
    );
  }
  const session = query({
    prompt: idle(),
    options: {
      cwd: workspace(root, "claude"),
      tools: [],
      settingSources: [],
      strictMcpConfig: true,
      mcpServers: {},
      env: { ...loginEnvironment(), CLAUDE_CODE_SAFE_MODE: "1" },
      abortController: controller,
    },
  });
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    const models = await session.supportedModels();
    return [
      ...new Set(
        models.flatMap((m) =>
          m.resolvedModel ? [m.value, m.resolvedModel] : [m.value],
        ),
      ),
    ];
  } finally {
    clearTimeout(timer);
    controller.abort();
    session.close();
  }
}
async function antigravityModels(): Promise<string[]> {
  const { stdout } = await promisify(execFile)("agy", ["models"], {
    env: loginEnvironment(),
    timeout: 15000,
    maxBuffer: 1_048_576,
  });
  const models = stdout
    .split("\n")
    .filter((line) => line.includes("\t"))
    .map((line) => line.split("\t")[0].trim());
  if (
    !models.length ||
    models.some((model) => !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,199}$/.test(model))
  )
    throw new Error("Invalid model catalog");
  return [...new Set(models)];
}
const root = dataDirectory();
const config = await loadConfig(root);
for (const [name, discover] of [
  ["codex", () => codexModels()],
  ["claude", () => claudeModels(root)],
  ["antigravity", () => antigravityModels()],
] as const) {
  try {
    const models = await discover();
    const candidate = structuredClone(config);
    candidate.providers[name].models = [
      ...new Set([...config.providers[name].models, ...models]),
    ];
    validateConfig(candidate);
    config.providers[name].models = candidate.providers[name].models;
    console.log(`\n${name}: ${models.length} models discovered`);
    for (const model of config.providers[name].models) {
      console.log(`  ${name}/${model}`);
    }
  } catch (error) {
    console.log(`${name}: ${providerError(error).code}`);
    process.exitCode = 1;
  }
}
const target = join(root, "config.json");
const temporary = `${target}.tmp`;
await writeFile(temporary, JSON.stringify(config, null, 2) + "\n", {
  mode: 0o600,
});
await rename(temporary, target);
console.log(
  `\nUpdated ${target}. Existing model IDs and defaults are preserved.`,
);
console.log(
  "Use a listed ID as the model field. Restart llm-server to reload.",
);
