import assert from "node:assert/strict";
import { retrieveKnowledge } from "./knowledge-retrieval.ts";

Deno.test("retrieval ranks accessible results, maps citations and respects budgets", async () => {
  const hub = {
    id: "hub",
    kind: "hub-native" as const,
    sourceId: "hub",
    sourceLabel: "Team",
    title: "Alpha",
  };
  const imported = {
    id: "repo/doc",
    kind: "imported" as const,
    sourceId: "repo",
    sourceLabel: "Repo",
    title: "Beta",
    path: "docs/my file.md",
  };
  const result = await retrieveKnowledge(
    "alpha beta",
    (term) => Promise.resolve(term === "alpha" ? [hub, imported] : [imported]),
    (item) =>
      Promise.resolve(item.id === hub.id ? "H".repeat(5000) : "I".repeat(5000)),
    5000,
  );
  assert.equal(result.citations[0].documentId, imported.id);
  assert.equal(result.citations[0].url, "/imports/repo/docs/my%20file.md");
  assert.equal(result.citations[1].url, "/knowledge/hub");
  assert.ok(result.context.length <= 5000);
  assert.ok(result.context.includes("I".repeat(4000)));
  assert.ok(!result.context.includes("I".repeat(4001)));
  assert.match(result.context, /\[2\] Alpha/);
});
