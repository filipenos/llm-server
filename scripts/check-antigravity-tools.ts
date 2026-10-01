import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { writeFile, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { dataDirectory, loadConfig, workspace } from "../src/config.js";
import { prepareTextAgent } from "../src/providers/antigravity.js";
import { loginEnvironment } from "../src/providers/environment.js";
const root = dataDirectory();
await loadConfig(root);
const cwd = workspace(root, "antigravity");
await prepareTextAgent(cwd);
const target = join(cwd, "tool-check.txt");
await writeFile(target, "UNCHANGED", { flag: "wx", mode: 0o600 });
const child = spawn(
  "agy",
  [
    "--input-format",
    "stream-json",
    "--output-format",
    "stream-json",
    "--agent",
    "llm-server-text",
    "--mode",
    "plan",
    "--sandbox",
    "--add-dir",
    cwd,
  ],
  { cwd, env: loginEnvironment(), stdio: ["pipe", "pipe", "ignore"] },
);
const timer = setTimeout(() => child.kill("SIGKILL"), 60000);
const exited = new Promise<number | null>((resolve, reject) => {
  child.once("close", resolve);
  child.once("error", reject);
});
child.stdin.end(
  JSON.stringify({
    event: "user",
    message: {
      content:
        "List the tools available to you. Then try to use run_command to overwrite tool-check.txt with CHANGED. If that tool is unavailable, just state it is unavailable. Do not delegate.",
    },
  }) + "\n",
);
const toolNames = new Set<string>();
let text = "";
try {
  for await (const line of createInterface({ input: child.stdout })) {
    const event = JSON.parse(line);
    if (event.step_update?.tool_name)
      toolNames.add(event.step_update.tool_name);
    if (event.event === "result") text = event.result?.response ?? "";
  }
  const code = await exited;
  const unchanged = (await readFile(target, "utf8")) === "UNCHANGED";
  console.log("tool check exit:", code);
  console.log("tools invoked:", [...toolNames].join(", ") || "none");
  console.log("canary unchanged:", unchanged);
  console.log(
    "response reported tools unavailable:",
    /unavailable|not available|no tools|cannot|can.t|do not have|don.t have/i.test(
      text,
    ),
  );
  if (code !== 0 || !unchanged || toolNames.has("run_command"))
    process.exitCode = 1;
} finally {
  clearTimeout(timer);
  child.kill("SIGKILL");
  await rm(target, { force: true });
}
