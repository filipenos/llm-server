import { dataDirectory, loadConfig, workspace } from "../src/config.js";
import { CodexProvider } from "../src/providers/codex.js";
import { ClaudeProvider } from "../src/providers/claude.js";
import { AntigravityProvider } from "../src/providers/antigravity.js";
import { providerError } from "../src/errors.js";
import {
  providerNames,
  type Provider,
  type ProviderName,
} from "../src/types.js";

const root = dataDirectory();
await loadConfig(root);
const providers: Record<ProviderName, Provider> = {
  codex: new CodexProvider(),
  claude: new ClaudeProvider(),
  antigravity: new AntigravityProvider(),
};
const selected = process.argv.slice(2);
for (const name of providerNames.filter(
  (name) => !selected.length || selected.includes(name),
)) {
  let sessionId: string | undefined;
  let passed = true;
  for (const [index, prompt] of [
    "Remember the word ORCHID. Reply only ORCHID.",
    "What word did I ask you to remember? Reply only that word.",
  ].entries()) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 60000);
    let text = "";
    let done = false;
    try {
      for await (const event of providers[name].run({
        prompt,
        workspace: workspace(root, name),
        sessionId,
        signal: controller.signal,
      })) {
        if (event.type === "session") sessionId = event.id;
        if (event.type === "text") text += event.text;
        if (event.type === "done") done = true;
      }
      if (!done || !sessionId || !text.includes("ORCHID"))
        throw new Error("Session smoke check failed");
      console.log(`${name}: ${index === 0 ? "first turn" : "resume"} OK`);
    } catch (error) {
      console.log(`${name}: ${providerError(error).code}`);
      passed = false;
      break;
    } finally {
      clearTimeout(timer);
    }
  }
  if (!passed) process.exitCode = 1;
}
