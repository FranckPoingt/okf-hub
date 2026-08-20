import assert from "node:assert/strict";
import { createConnectorRegistry } from "./connector-registry.ts";

Deno.test("normalizes source adapters through one connector seam", async () => {
  const calls: string[] = [];
  const snapshot = { revision: "r1", files: [], issues: [] };
  const registry = createConnectorRegistry({
    git: (_checkout, url) => {
      calls.push(`git:${url}`);
      return Promise.resolve(snapshot);
    },
    s3: (config) => {
      calls.push(`s3:${config.bucket}`);
      return Promise.resolve(snapshot);
    },
    notion: (config) => {
      calls.push(`notion:${config.token}`);
      return Promise.resolve(snapshot);
    },
  });

  await registry.sync({
    kind: "git",
    checkout: "/tmp/repo",
    repositoryUrl: "https://example.com/repo.git",
    folder: "okf",
  });
  await registry.sync({
    kind: "s3",
    config: {
      endpoint: "https://s3.example.com",
      bucket: "knowledge",
      path: "okf",
      region: "auto",
      accessKey: "key",
      secretKey: "secret",
    },
  });
  await registry.sync({ kind: "notion", config: { token: "token" } });
  assert.deepEqual(calls, [
    "git:https://example.com/repo.git",
    "s3:knowledge",
    "notion:token",
  ]);
  assert.deepEqual(
    registry.definitions.map(({ id, capabilities }) => [id, capabilities]),
    [
      ["git", ["import"]],
      ["s3", ["import"]],
      ["notion", ["import"]],
      ["miro", ["embed"]],
      ["google-sheets", ["embed"]],
    ],
  );
});
