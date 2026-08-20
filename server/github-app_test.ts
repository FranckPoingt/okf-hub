/// <reference lib="deno.ns" />

import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { createGitHubAppClient } from "./github-app.ts";

Deno.test("GitHub App signs requests, discovers repositories, and verifies webhooks", async () => {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const requests: Request[] = [];
  const client = createGitHubAppClient({
    appId: "42",
    slug: "okf-hub",
    privateKey: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    webhookSecret: "It's a Secret to Everybody",
    now: () => Date.parse("2026-08-08T00:00:00Z"),
    apiBase: "https://github.test",
    fetcher: (input, init) => {
      const request = new Request(input, init);
      requests.push(request);
      if (request.method === "POST") {
        return Promise.resolve(Response.json({ token: "installation-token" }));
      }
      if (new URL(request.url).pathname === "/installation/repositories") {
        return Promise.resolve(Response.json({
          repositories: [{
            id: 7,
            full_name: "acme/knowledge",
            clone_url: "https://github.com/acme/knowledge.git",
            default_branch: "main",
            private: true,
          }],
        }));
      }
      return Promise.resolve(
        Response.json({ tree: [{ path: "okf", type: "tree" }] }),
      );
    },
  });

  const repositories = await client.repositories(9);
  assert.equal(requests[0].headers.get("authorization")?.split(".").length, 3);
  assert.deepEqual(repositories.map((item) => item.fullName), [
    "acme/knowledge",
  ]);
  assert.deepEqual(await client.folders(9, repositories[0]), [".", "okf"]);
  assert.equal(
    client.verify(
      new TextEncoder().encode("Hello, World!"),
      "sha256=757107ea0eb2509fc211221cce984b8a37570b6d7586c22c46f4379c8b043e17",
    ),
    true,
  );
  assert.equal(client.verify(new Uint8Array(), "sha256=bad"), false);
});
