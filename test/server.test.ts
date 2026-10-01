import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, stat, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import OpenAI from "openai";
import { createServer } from "../src/server.js";
import { loadConfig } from "../src/config.js";
import { Store } from "../src/store.js";
import type { Provider, ProviderInput, ProviderEvent } from "../src/types.js";
import { parseAntigravityEvent } from "../src/providers/antigravity.js";
import { Queue } from "../src/queue.js";

const usage = { prompt_tokens: 12, completion_tokens: 2, total_tokens: 14 };
class Fake implements Provider {
  inputs: ProviderInput[] = [];
  async *run(input: ProviderInput): AsyncGenerator<ProviderEvent> {
    this.inputs.push(input);
    yield { type: "session", id: input.sessionId ?? "native-session" };
    yield { type: "text", text: "Olá " };
    yield { type: "text", text: "mundo" };
    yield { type: "done", usage };
  }
}
async function fixture(t: any, custom?: Provider) {
  const root = await mkdtemp(join(tmpdir(), "llm-server-test-"));
  const config = await loadConfig(root);
  config.providers.codex.models = ["test-model"];
  const fake = custom ?? new Fake();
  const providers = {
    codex: fake,
    claude: new Fake(),
    antigravity: new Fake(),
  };
  const logs: string[] = [];
  const app = createServer(root, config, providers, (line) => logs.push(line));
  t.after(async () => {
    await app.close();
    await rm(root, { recursive: true, force: true });
  });
  return { root, config, providers, app, logs, fake: fake as Fake };
}
const body = { model: "codex", messages: [{ role: "user", content: "Oi" }] };

test("request logs describe JSON and SSE calls without private input", async (t) => {
  const { app, logs } = await fixture(t);
  for (const stream of [false, true]) {
    await app.inject({
      method: "POST",
      url: "/v1/chat/completions?secret=private-query",
      headers: { authorization: "Bearer private-token" },
      payload: {
        model: "codex/test-model",
        stream,
        messages: [{ role: "user", content: "private-prompt" }],
      },
    });
  }
  await app.inject({
    method: "POST",
    url: "/v1/chat/completions",
    payload: { model: "private-model", messages: body.messages },
  });
  assert.equal(logs.length, 3);
  for (const line of logs.slice(0, 2)) {
    const entry = JSON.parse(line);
    assert.equal(entry.model, "codex/test-model");
    assert.equal(entry.provider, "codex");
    assert.equal(entry.route, "/v1/chat/completions");
    assert.equal(entry.status, 200);
    assert.equal(entry.outcome, "completed");
    assert.ok(entry.durationMs >= 0);
    assert.ok(!Number.isNaN(Date.parse(entry.time)));
  }
  assert.equal(JSON.parse(logs[2]).error, "invalid_model");
  assert.equal(JSON.parse(logs[2]).status, 400);
  assert.doesNotMatch(logs.join("\n"), /private-|Olá mundo|authorization/);
});

test("OpenAI JSON response, private persistence and resume after restart", async (t) => {
  const f = await fixture(t);
  const first = await f.app.inject({
    method: "POST",
    url: "/v1/chat/completions",
    payload: body,
  });
  assert.equal(first.statusCode, 200);
  assert.equal(first.json().choices[0].message.content, "Olá mundo");
  assert.deepEqual(first.json().usage, usage);
  const id = first.headers["x-conversation-id"] as string;
  const path = join(f.root, "providers/codex/conversations", `${id}.json`);
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  assert.equal(JSON.parse(await readFile(path, "utf8")).status, "ready");
  await f.app.close();
  const restarted = createServer(f.root, f.config, f.providers);
  t.after(() => restarted.close());
  const resumed = await restarted.inject({
    method: "POST",
    url: "/v1/chat/completions",
    headers: { "X-Conversation-Id": id },
    payload: { ...body, messages: [{ role: "user", content: "Continue" }] },
  });
  assert.equal(resumed.statusCode, 200);
  assert.equal(f.fake.inputs[1].sessionId, "native-session");
  assert.equal(f.fake.inputs[1].prompt, "Continue");
  assert.equal((await new Store(f.root).get(id)).messages.length, 4);
});

test("official OpenAI SDK consumes models, JSON and streaming with usage", async (t) => {
  const { app } = await fixture(t);
  const address = await app.listen({ host: "127.0.0.1", port: 0 });
  const client = new OpenAI({
    baseURL: `${address}/v1`,
    apiKey: "local",
    maxRetries: 0,
  });
  const models = await client.models.list();
  assert.ok(models.data.some((m) => m.id === "codex/test-model"));
  assert.ok(models.data.some((m) => m.id === "gemini"));
  const first = await client.chat.completions
    .create({
      model: "codex/test-model",
      messages: [{ role: "user", content: "Oi" }],
    })
    .withResponse();
  assert.equal(first.data.choices[0].message.content, "Olá mundo");
  assert.ok(first.response.headers.get("x-conversation-id"));
  const stream = await client.chat.completions.create({
    ...body,
    messages: [{ role: "user", content: "Oi" }],
    stream: true,
    stream_options: { include_usage: true },
  });
  let text = "";
  let final = false;
  let streamUsage;
  for await (const chunk of stream) {
    text += chunk.choices[0]?.delta.content ?? "";
    if (chunk.choices[0]?.finish_reason === "stop") final = true;
    if (chunk.usage) streamUsage = chunk.usage;
  }
  assert.equal(text, "Olá mundo");
  assert.equal(final, true);
  assert.deepEqual(streamUsage, usage);
});

test("rejects unsupported parameters, invalid content and model names before provider invocation", async (t) => {
  const { app, fake } = await fixture(t);
  for (const payload of [
    { ...body, temperature: 0 },
    { ...body, tools: [] },
    { ...body, stream: "yes" },
    { ...body, model: "codex/unconfigured" },
    { ...body, model: "other/model" },
    { ...body, messages: [{ role: "tool", content: "x" }] },
    {
      ...body,
      messages: [
        {
          role: "user",
          content: [
            { type: "image_url", image_url: { url: "file:///etc/passwd" } },
          ],
        },
      ],
    },
    { ...body, stream_options: { include_usage: true } },
  ]) {
    const response = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      payload,
    });
    assert.equal(response.statusCode, 400);
    assert.ok(response.json().error.code);
  }
  assert.equal(fake.inputs.length, 0);
});

test("normalizes text content parts and preserves the provided history", async (t) => {
  const { app, fake } = await fixture(t);
  const messages = [
    { role: "system", content: "Be concise" },
    { role: "assistant", content: "Hello" },
    {
      role: "user",
      content: [
        { type: "text", text: "One" },
        { type: "text", text: "Two" },
      ],
    },
  ];
  const response = await app.inject({
    method: "POST",
    url: "/v1/chat/completions",
    payload: { ...body, messages },
  });
  assert.equal(response.statusCode, 200);
  assert.ok(fake.inputs[0].prompt.includes("Be concise"));
  assert.ok(fake.inputs[0].prompt.includes("One\\nTwo"));
});

test("conversation ID validates paths and prevents model switching or history duplication", async (t) => {
  const { app } = await fixture(t);
  const initial = await app.inject({
    method: "POST",
    url: "/v1/chat/completions",
    payload: body,
  });
  const id = initial.headers["x-conversation-id"] as string;
  const headers = { "x-conversation-id": id };
  assert.equal(
    (
      await app.inject({
        method: "POST",
        url: "/v1/chat/completions",
        headers: { "x-conversation-id": "../../secret" },
        payload: body,
      })
    ).statusCode,
    400,
  );
  assert.equal(
    (
      await app.inject({
        method: "POST",
        url: "/v1/chat/completions",
        headers: {
          "x-conversation-id": "conv_00000000-0000-0000-0000-000000000000",
        },
        payload: body,
      })
    ).statusCode,
    404,
  );
  assert.equal(
    (
      await app.inject({
        method: "POST",
        url: "/v1/chat/completions",
        headers,
        payload: { ...body, model: "claude" },
      })
    ).statusCode,
    409,
  );
  assert.equal(
    (
      await app.inject({
        method: "POST",
        url: "/v1/chat/completions",
        headers,
        payload: {
          ...body,
          messages: [
            { role: "assistant", content: "Old reply" },
            ...body.messages,
          ],
        },
      })
    ).statusCode,
    400,
  );
});

test("provider errors are sanitized and interrupted sessions cannot silently resume", async (t) => {
  const provider: Provider = {
    async *run() {
      yield { type: "session", id: "failure-session" };
      throw new Error("credential SECRET and private prompt");
    },
  };
  const { app, root } = await fixture(t, provider);
  const response = await app.inject({
    method: "POST",
    url: "/v1/chat/completions",
    payload: body,
  });
  assert.equal(response.statusCode, 503);
  assert.ok(!response.body.includes("SECRET"));
  const id = response.headers["x-conversation-id"] as string;
  assert.equal((await new Store(root).get(id)).status, "interrupted");
  const resumed = await app.inject({
    method: "POST",
    url: "/v1/chat/completions",
    payload: body,
    headers: { "x-conversation-id": id },
  });
  assert.equal(resumed.statusCode, 409);
});

test("stream errors contain neither a success finish event nor DONE", async (t) => {
  const provider: Provider = {
    async *run() {
      yield { type: "session", id: "failure-session" };
      yield { type: "text", text: "Partial" };
      throw new Error("SECRET");
    },
  };
  const { app, logs } = await fixture(t, provider);
  const response = await app.inject({
    method: "POST",
    url: "/v1/chat/completions",
    payload: { ...body, stream: true },
  });
  assert.equal(response.statusCode, 200);
  assert.ok(response.body.includes("provider_error"));
  assert.ok(!response.body.includes("[DONE]"));
  assert.ok(!response.body.includes("SECRET"));
  assert.equal(logs.length, 1);
  assert.equal(JSON.parse(logs[0]).outcome, "error");
  assert.equal(JSON.parse(logs[0]).error, "provider_error");
  assert.ok(!logs[0].includes("SECRET"));
});

test("same-provider calls are serialized and see the latest native session", async (t) => {
  let running = 0;
  let peak = 0;
  const provider: Provider = {
    async *run(input) {
      running++;
      peak = Math.max(peak, running);
      try {
        yield { type: "session", id: input.sessionId ?? "native" };
        await new Promise((r) => setTimeout(r, 15));
        yield { type: "text", text: "ok" };
        yield { type: "done", usage };
      } finally {
        running--;
      }
    },
  };
  const { app } = await fixture(t, provider);
  const first = await app.inject({
    method: "POST",
    url: "/v1/chat/completions",
    payload: body,
  });
  const headers = {
    "x-conversation-id": first.headers["x-conversation-id"] as string,
  };
  const responses = await Promise.all(
    [1, 2].map(() =>
      app.inject({
        method: "POST",
        url: "/v1/chat/completions",
        headers,
        payload: body,
      }),
    ),
  );
  assert.ok(responses.every((r) => r.statusCode === 200));
  assert.equal(peak, 1);
});

test("timeout aborts the provider and releases its queue", async (t) => {
  const provider: Provider = {
    async *run(input) {
      yield { type: "session", id: "native" };
      await new Promise((_, reject) => {
        input.signal.addEventListener(
          "abort",
          () => reject(input.signal.reason),
          { once: true },
        );
      });
    },
  };
  const { app, config } = await fixture(t, provider);
  config.timeoutMs = 30;
  for (let i = 0; i < 2; i++) {
    const response = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      payload: body,
    });
    assert.equal(response.statusCode, 504);
    assert.equal(response.json().error.code, "provider_timeout");
  }
});

test("client disconnect aborts its live provider", async (t) => {
  let ready!: () => void;
  const started = new Promise<void>((resolve) => {
    ready = resolve;
  });
  let aborted!: () => void;
  const observed = new Promise<void>((resolve) => {
    aborted = resolve;
  });
  const provider: Provider = {
    async *run(input) {
      yield { type: "session", id: "native" };
      yield { type: "text", text: "started" };
      await new Promise((_, reject) => {
        input.signal.addEventListener(
          "abort",
          () => {
            aborted();
            reject(input.signal.reason);
          },
          { once: true },
        );
        ready();
      });
    },
  };
  const { app } = await fixture(t, provider);
  const address = await app.listen({ host: "127.0.0.1", port: 0 });
  const controller = new AbortController();
  const response = await fetch(`${address}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...body, stream: true }),
    signal: controller.signal,
  });
  await response.body!.getReader().read();
  await started;
  controller.abort();
  await Promise.race([
    observed,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error("Provider was not cancelled")), 1000),
    ),
  ]);
});

test("cancelled queue entries cannot acquire a released slot", async () => {
  const queue = new Queue();
  const first = new AbortController();
  const second = new AbortController();
  const release = await queue.acquire(first.signal);
  const waiting = queue.acquire(second.signal);
  second.abort();
  await assert.rejects(waiting);
  release();
  const next = await queue.acquire(first.signal);
  next();
});

test("Antigravity parser handles documented deltas, usage and failure events", () => {
  assert.deepEqual(
    parseAntigravityEvent({
      event: "step_update",
      step_update: { conversation_id: "native", text_delta: "hello" },
    }),
    [
      { type: "session", id: "native" },
      { type: "text", text: "hello" },
    ],
  );
  const events = parseAntigravityEvent({
    event: "result",
    result: {
      conversation_id: "native",
      status: "SUCCESS",
      usage: {
        input_tokens: 10,
        output_tokens: 3,
        thinking_tokens: 2,
        total_tokens: 13,
      },
    },
  });
  assert.deepEqual(events.at(-1), {
    type: "done",
    usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 },
  });
  assert.throws(() =>
    parseAntigravityEvent({
      event: "result",
      result: { status: "ERROR", error: "failed" },
    }),
  );
});

test(
  "shutdown aborts in-flight generation before draining connections",
  { timeout: 3000 },
  async (t) => {
    let ready!: () => void;
    const started = new Promise<void>((resolve) => {
      ready = resolve;
    });
    const provider: Provider = {
      async *run(input) {
        yield { type: "session", id: "native" };
        await new Promise((_, reject) => {
          input.signal.addEventListener(
            "abort",
            () => reject(input.signal.reason),
            { once: true },
          );
          ready();
        });
      },
    };
    const { app } = await fixture(t, provider);
    const response = app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      payload: body,
    });
    await started;
    await app.close();
    assert.equal((await response).statusCode, 502);
  },
);

test("omitted model defaults to Codex Luna for JSON and streaming", async (t) => {
  const { app, fake } = await fixture(t);
  for (const stream of [false, true]) {
    const response = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      payload: { messages: body.messages, stream },
    });
    assert.equal(response.statusCode, 200);
    assert.equal(fake.inputs.at(-1)?.model, "gpt-6-luna");
    if (stream) assert.ok(response.body.includes('"model":"codex/gpt-6-luna"'));
    else assert.equal(response.json().model, "codex/gpt-6-luna");
  }
  for (const model of [null, "", 12]) {
    assert.equal(
      (
        await app.inject({
          method: "POST",
          url: "/v1/chat/completions",
          payload: { ...body, model },
        })
      ).statusCode,
      400,
    );
  }
});
