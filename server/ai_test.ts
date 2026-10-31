/// <reference lib="deno.ns" />

import assert from "node:assert/strict";
import { createAIEmbedder, createAIResponder } from "./ai.ts";

Deno.test("embeddings are opt-in and never switch providers for unsupported profiles", () => {
  assert.equal(createAIEmbedder({ provider: "openai" }), null);
  for (
    const provider of [
      "anthropic",
      "openrouter",
      "groq",
      "webllm",
      "invalid",
    ]
  ) {
    assert.equal(
      createAIEmbedder({ provider, model: "embed-test", apiKey: "test" }),
      null,
    );
  }
  for (const provider of ["openai", "google-gemini", "ollama"]) {
    assert.equal(
      typeof createAIEmbedder({
        provider,
        model: "embed-test",
        apiKey: "test",
      }),
      "function",
    );
  }
});

Deno.test("Ax embeddings use the configured endpoint, model and credential", async () => {
  const received: { path: string; auth: string | null; body: unknown }[] = [];
  const server = Deno.serve(
    { hostname: "127.0.0.1", port: 0, onListen() {} },
    async (request) => {
      const body = await request.json();
      received.push({
        path: new URL(request.url).pathname,
        auth: request.headers.get("authorization"),
        body,
      });
      return Response.json({
        data: body.input.map((_: string, index: number) => ({
          index,
          embedding: [1, 0],
        })),
        usage: { prompt_tokens: 2, total_tokens: 2 },
      });
    },
  );
  try {
    const embed = createAIEmbedder({
      provider: "openai",
      model: "local-embed",
      apiKey: "stub-key",
      apiURL: `http://127.0.0.1:${(server.addr as Deno.NetAddr).port}/v1`,
    })!;
    assert.deepEqual(await embed(["Test evidence"]), [[1, 0]]);
    assert.equal(received.length, 1);
    assert.deepEqual(received[0], {
      path: "/v1/embeddings",
      auth: "Bearer stub-key",
      body: { model: "local-embed", input: ["Test evidence"] },
    });
  } finally {
    await server.shutdown();
  }
});

Deno.test("Ollama embeddings call /api/embed on the configured local endpoint", async () => {
  const received: { path: string; auth: string | null; body: unknown }[] = [];
  const server = Deno.serve(
    { hostname: "127.0.0.1", port: 0, onListen() {} },
    async (request) => {
      const body = await request.json();
      received.push({
        path: new URL(request.url).pathname,
        auth: request.headers.get("authorization"),
        body,
      });
      return Response.json({
        embeddings: body.input.map(() => [0.5, 0.5]),
      });
    },
  );
  try {
    const port = (server.addr as Deno.NetAddr).port;
    const local = createAIEmbedder({
      provider: "ollama",
      model: "embeddinggemma",
      apiURL: `http://127.0.0.1:${port}/`,
    })!;
    assert.deepEqual(await local(["a", "b"]), [[0.5, 0.5], [0.5, 0.5]]);
    // An inherited OpenAI-compatible /v1 URL still reaches the native endpoint.
    const cloud = createAIEmbedder({
      provider: "ollama",
      model: "embeddinggemma",
      apiKey: "stub-key",
      apiURL: `http://127.0.0.1:${port}/v1`,
    })!;
    await cloud(["c"]);
    assert.deepEqual(received, [
      {
        path: "/api/embed",
        auth: null,
        body: { model: "embeddinggemma", input: ["a", "b"] },
      },
      {
        path: "/api/embed",
        auth: "Bearer stub-key",
        body: { model: "embeddinggemma", input: ["c"] },
      },
    ]);
  } finally {
    await server.shutdown();
  }
});

Deno.test("configures Ax server providers without an Ollama-only allowlist", () => {
  for (
    const [provider, model] of [
      ["openai", "gpt-5"],
      ["anthropic", "claude-sonnet-4-5"],
      ["google-gemini", "gemini-2.5-flash"],
      ["ollama", "glm-5.2"],
    ]
  ) {
    assert.equal(
      typeof createAIResponder({ provider, model, apiKey: "test" }),
      "function",
    );
  }

  assert.throws(
    () => createAIResponder({ provider: "not-a-provider", model: "test" }),
  );
  assert.throws(
    () => createAIResponder({ provider: "webllm", model: "test" }),
    /not available in the OKF server runtime/,
  );
});
