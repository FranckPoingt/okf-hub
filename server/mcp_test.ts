import assert from "node:assert/strict";
import { ActionError, createActionCatalog } from "./action-catalog.ts";
import {
  ARTIFACT_SAVE_SCOPES,
  artifactSaveAction,
  packArtifactFiles,
} from "./artifact-save.ts";
import { createMcpHandler } from "./mcp.ts";

const actor = {
  user: { id: "reader", name: "Reader", email: "reader@example.com" },
  scopes: ["knowledge.*"],
  via: "api-key" as const,
};
const catalog = createActionCatalog([{
  name: "knowledge.search",
  tag: "Knowledge",
  title: "Search",
  description: "Accessible knowledge",
  mode: "query",
  approval: "none",
  inputSchema: {
    type: "object",
    properties: { query: { type: "string" } },
    additionalProperties: false,
  },
  run: (context) => {
    assert.equal(context.userId, "reader");
    throw new ActionError("Access denied", 403);
  },
}]);
const handle = createMcpHandler(catalog, (request) => {
  assert.equal(request.headers.get("cookie"), null);
  return Promise.resolve(
    request.headers.get("authorization") === "Bearer okf_test" ? actor : null,
  );
});
function request(
  body: unknown,
  headers: Record<string, string> = {},
  method = "POST",
) {
  return handle(
    new Request("http://localhost/api/mcp", {
      method,
      headers: {
        authorization: "Bearer okf_test",
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        ...headers,
      },
      body: method === "POST" ? JSON.stringify(body) : undefined,
    }),
  );
}
const rpc = (method: string, params = {}) => ({
  jsonrpc: "2.0",
  id: 1,
  method,
  params,
});

Deno.test("MCP negotiates, lists scoped catalog tools and preserves action denial", async () => {
  const initialized = await (await request(
    rpc("initialize", {
      protocolVersion: "unknown",
      capabilities: {},
      clientInfo: { name: "test", version: "1" },
    }),
  )).json();
  assert.equal(initialized.result.protocolVersion, "2025-11-25");
  assert.deepEqual(initialized.result.capabilities, { tools: {} });
  assert.equal(
    (await request({ jsonrpc: "2.0", method: "notifications/initialized" }))
      .status,
    202,
  );
  const tools = await (await request(rpc("tools/list"))).json();
  assert.deepEqual(
    tools.result.tools.map((tool: { name: string }) => tool.name),
    ["knowledge.search"],
  );
  const denied = await (await request(
    rpc("tools/call", { name: "knowledge.search", arguments: {} }),
  )).json();
  assert.equal(denied.result.isError, true);
  assert.equal(denied.result.content[0].text, "Access denied");
  assert.equal(
    (await (await request(rpc("tools/call", { name: "apps.create" }))).json())
      .error.code,
    -32602,
  );
  assert.equal(
    (await (await request(
      rpc("tools/call", {
        name: "knowledge.search",
        arguments: { query: true },
      }),
    )).json()).result.isError,
    true,
  );
});

Deno.test("MCP authenticates all methods, strips cookies and validates transport", async () => {
  for (const method of ["POST", "GET", "DELETE"]) {
    assert.equal(
      (await request(
        {},
        { authorization: "", cookie: "session=owner" },
        method,
      )).status,
      401,
    );
    assert.equal(
      (await request({}, { authorization: "Bearer okf_revoked" }, method))
        .status,
      401,
    );
  }
  assert.equal(
    (await request({}, { cookie: "session=owner" }, "GET")).status,
    405,
  );
  assert.equal(
    (await request({}, { origin: "https://evil.example" })).status,
    403,
  );
  assert.equal(
    (await request({}, { "content-type": "text/plain" })).status,
    415,
  );
  assert.equal((await request({}, { accept: "application/json" })).status, 406);
  assert.equal(
    (await request({}, { "mcp-protocol-version": "invalid" })).status,
    400,
  );
  assert.equal((await request([])).status, 400);
  assert.equal(
    (await (await request(rpc("unknown"))).json()).error.code,
    -32601,
  );
  assert.equal((await request(rpc("ping"), {}, "POST")).status, 200);
});

Deno.test("artifact.save needs component scopes and shares static bundle validation", async () => {
  const actions = createActionCatalog([artifactSaveAction(() => actions)]);
  assert.equal(actions.list(["artifact.save"]).length, 0);
  assert.equal(
    actions.list(["artifact.save", ...ARTIFACT_SAVE_SCOPES]).length,
    1,
  );
  const pack = (files: Record<string, string>) =>
    packArtifactFiles(
      Object.entries(files).map(([path, text]) => ({
        path,
        bytes: new TextEncoder().encode(text),
      })),
    );
  await assert.rejects(() => pack({ "index.html": "ok" }), /context.md/);
  await assert.rejects(
    () =>
      pack({
        "index.html": "<script>fetch('/api')</script>",
        "context.md": "# Context",
      }),
    /Network APIs/,
  );
  await assert.rejects(
    () =>
      pack({
        "index.html": "ok",
        "context.md": "# Context",
        "../escape.txt": "unsafe",
      }),
    /Excluded|unsafe/,
  );
  await assert.rejects(
    () =>
      pack({
        "index.html": "<img src='missing.png'>",
        "context.md": "# Context",
      }),
    /included locally/,
  );
  const packed = await pack({
    "index.html": "<h1>Hello</h1>",
    "context.md": "# Context",
  });
  assert.match(packed.content, /^okf-bundle-v1:/);
});

Deno.test("MCP rejects malformed and oversized JSON bodies", async () => {
  const raw = (body: string) =>
    handle(
      new Request("http://localhost/api/mcp", {
        method: "POST",
        headers: {
          authorization: "Bearer okf_test",
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
        },
        body,
      }),
    );
  const malformed = await raw("{");
  assert.equal(malformed.status, 400);
  assert.equal((await malformed.json()).error.code, -32700);
  const oversized = await raw("x".repeat(9 * 1024 * 1024 + 1));
  assert.equal(oversized.status, 413);
});
