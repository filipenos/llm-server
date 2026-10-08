import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { providerNames, type Config, type ProviderName } from "./types.js";

export const defaultConfig: Config = {
  port: 10434,
  timeoutMs: 120_000,
  providers: {
    codex: {
      enabled: true,
      defaultModel: "gpt-6-luna",
      models: ["gpt-6-luna"],
    },
    claude: { enabled: true, models: [] },
    antigravity: {
      enabled: true,
      defaultModel: "gemini-3.8-flash-low",
      models: ["gemini-3.8-flash-low"],
    },
  },
};
export function dataDirectory() {
  return resolve(process.env.LLM_SERVER_HOME ?? join(homedir(), ".llm-server"));
}
export function workspace(root: string, provider: ProviderName) {
  return join(root, "providers", provider, "workspace");
}
export function validateConfig(value: unknown): Config {
  const c = value as Config;
  if (
    !c ||
    typeof c !== "object" ||
    !Number.isInteger(c.port) ||
    c.port < 1 ||
    c.port > 65535 ||
    !Number.isInteger(c.timeoutMs) ||
    c.timeoutMs < 1000 ||
    c.timeoutMs > 3_600_000 ||
    !c.providers
  )
    throw new Error(
      "Invalid config.json: port, timeoutMs and providers are required.",
    );
  for (const name of providerNames) {
    const p = c.providers[name];
    if (
      !p ||
      typeof p.enabled !== "boolean" ||
      !Array.isArray(p.models) ||
      !p.models.every(
        (m) =>
          typeof m === "string" &&
          /^[a-zA-Z0-9][a-zA-Z0-9._:() -]{0,199}$/.test(m),
      ) ||
      (p.defaultModel !== undefined &&
        (typeof p.defaultModel !== "string" ||
          !p.models.includes(p.defaultModel)))
    )
      throw new Error(
        `Invalid config.json provider: ${name}. defaultModel must appear in models.`,
      );
  }
  return c;
}
export async function loadConfig(root: string): Promise<Config> {
  await mkdir(root, { recursive: true, mode: 0o700 });
  const path = join(root, "config.json");
  let config: Config;
  try {
    config = validateConfig(JSON.parse(await readFile(path, "utf8")));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    config = structuredClone(defaultConfig);
    await writeFile(path, JSON.stringify(config, null, 2) + "\n", {
      mode: 0o600,
      flag: "wx",
    });
  }
  for (const name of providerNames) {
    await mkdir(workspace(root, name), { recursive: true, mode: 0o700 });
    await mkdir(join(root, "providers", name, "conversations"), {
      recursive: true,
      mode: 0o700,
    });
  }
  return config;
}
