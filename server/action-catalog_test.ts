import assert from "node:assert/strict";
import {
  actionAllowed,
  ActionError,
  createActionCatalog,
} from "./action-catalog.ts";

Deno.test("projects one action into scoped invocation and OpenAPI", async () => {
  const catalog = createActionCatalog([{
    name: "knowledge.echo",
    tag: "Knowledge",
    title: "Echo knowledge",
    description: "Returns the supplied value.",
    mode: "query",
    approval: "none",
    inputSchema: {
      type: "object",
      properties: { value: {} },
      additionalProperties: false,
    },
    run: (_context, input) => input,
  }]);

  assert.equal(actionAllowed(["knowledge.*"], "knowledge.echo"), true);
  assert.deepEqual(catalog.list(["other.*"]), []);
  assert.deepEqual(
    await catalog.invoke(
      "knowledge.echo",
      { userId: "u1", userName: "Franck" },
      { value: 1 },
      ["knowledge.*"],
    ),
    { value: 1 },
  );
  await assert.rejects(
    () =>
      catalog.invoke(
        "knowledge.echo",
        { userId: "u1", userName: "Franck" },
        {},
        ["other.*"],
      ),
    { message: "Action not found" },
  );
  await assert.rejects(
    () =>
      catalog.invoke(
        "knowledge.echo",
        { userId: "u1", userName: "Franck" },
        { value: 1, unexpected: true },
      ),
    (error: unknown) =>
      error instanceof ActionError && error.message.includes("not allowed"),
  );
  assert.equal(
    Object.hasOwn(catalog.openApi().paths, "/api/v1/actions/knowledge.echo"),
    true,
  );
  assert.deepEqual(
    catalog.openApi().paths["/api/v1/actions/knowledge.echo"].post.tags,
    ["Knowledge"],
  );
});
