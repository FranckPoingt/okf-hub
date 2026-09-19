/// <reference lib="deno.ns" />

import assert from "node:assert/strict";
import { createAIResponder } from "./ai.ts";

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
