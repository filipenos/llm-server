import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AntigravityProvider } from "../src/providers/antigravity.js";

test("Antigravity uses a workspace agent and JSON stdin without global permission requirements", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "agy-adapter-"));
  const bin = join(root, "bin");
  await mkdir(bin);
  const executable = join(bin, "agy");
  await writeFile(
    executable,
    `#!/usr/bin/env node
const assert = require('node:assert/strict');
const fs = require('node:fs');
const args = process.argv.slice(2);
assert.equal(args[args.indexOf('--agent') + 1], 'llm-server-text');
assert.equal(args[args.indexOf('--input-format') + 1], 'stream-json');
assert.ok(!args.includes('--dangerously-skip-permissions'));
const agent = fs.readFileSync('.agents/agents/llm-server-text/agent.md', 'utf8');
assert.ok(agent.includes('tools: []'));
assert.ok(agent.includes('commandExecutionPolicy: off'));
let input = '';
process.stdin.on('data', chunk => input += chunk);
process.stdin.on('end', () => {
  const request = JSON.parse(input);
  assert.equal(request.event, 'user');
  assert.equal(request.message.content, 'Only this prompt');
  console.log(JSON.stringify({event:'step_update',step_update:{conversation_id:'native',text_delta:'Hello'}}));
  console.log(JSON.stringify({event:'result',result:{conversation_id:'native',status:'SUCCESS',response:'Hello',usage:{input_tokens:1,output_tokens:1,total_tokens:2}}}));
});
`,
    { mode: 0o700 },
  );
  const previous = process.env.PATH;
  process.env.PATH = `${bin}:${previous}`;
  t.after(async () => {
    process.env.PATH = previous;
    await rm(root, { recursive: true, force: true });
  });
  const provider = new AntigravityProvider();
  const events = [];
  for await (const event of provider.run({
    prompt: "Only this prompt",
    workspace: root,
    signal: new AbortController().signal,
  }))
    events.push(event);
  assert.equal(
    events
      .filter((e) => e.type === "text")
      .map((e) => e.text)
      .join(""),
    "Hello",
  );
  assert.equal(events.at(-1)?.type, "done");
  const agent = await readFile(
    join(root, ".agents/agents/llm-server-text/agent.md"),
    "utf8",
  );
  assert.ok(agent.includes("mcpServers: []"));
});
