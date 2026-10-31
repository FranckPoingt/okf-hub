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

Deno.test("disabled, empty or failing semantic retrieval keeps lexical results identical", async () => {
  const item = {
    id: "guide",
    kind: "hub-native" as const,
    sourceId: "hub",
    sourceLabel: "Team",
    title: "Password",
  };
  const search = () => Promise.resolve([item]);
  const load = () => Promise.resolve("Reset your password");
  const baseline = await retrieveKnowledge("reset password", search, load);
  assert.deepEqual(
    await retrieveKnowledge("reset password", search, load, 24_000, undefined),
    baseline,
  );
  assert.deepEqual(
    await retrieveKnowledge(
      "reset password",
      search,
      load,
      24_000,
      () => Promise.resolve([]),
    ),
    baseline,
  );
  assert.deepEqual(
    await retrieveKnowledge(
      "reset password",
      search,
      load,
      24_000,
      () => Promise.reject(new Error("offline")),
    ),
    baseline,
  );
});

Deno.test("reciprocal rank fusion favors shared matches and verifies excerpts against current permitted content", async () => {
  const a = {
    id: "a",
    kind: "hub-native" as const,
    sourceId: "hub",
    sourceLabel: "Team",
    title: "Alpha",
  };
  const b = { ...a, id: "b", title: "Beta" };
  const result = await retrieveKnowledge(
    "test",
    () => Promise.resolve([a, b]),
    () => Promise.resolve("Current public content"),
    24_000,
    () => Promise.resolve([{ item: b, excerpt: "Stale secret draft" }]),
  );
  assert.equal(result.citations[0].documentId, "b");
  assert.ok(!result.context.includes("secret"));
  assert.match(result.context, /Current public content/);
});
