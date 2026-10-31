import assert from "node:assert/strict";
import type { AIRequest } from "./ai.ts";
import { retrieveKnowledge, searchTerms } from "./knowledge-retrieval.ts";

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

Deno.test("query rewriting sends only the conversation and falls back on failure", async () => {
  const requests: AIRequest[] = [];
  const messages = [
    { role: "user" as const, content: "Earlier question" },
    { role: "assistant" as const, content: "Earlier answer" },
    { role: "user" as const, content: "When do we pay suppliers?" },
  ];
  assert.deepEqual(
    await searchTerms((request) => {
      requests.push(request);
      return Promise.resolve(
        '```json\n{"terms":["vendor payment terms"," net 30 ","vendor payment terms",4]}\n```',
      );
    }, messages),
    ["vendor payment terms", "net 30"],
  );
  assert.equal(requests[0].task, "search-terms");
  assert.deepEqual(requests[0].messages, messages);
  assert.equal(requests[0].document.markdown, "");
  for (
    const respond of [
      () => Promise.resolve("not json"),
      () => Promise.resolve('{"terms":[]}'),
      () => Promise.resolve('{"other":1}'),
      () => Promise.reject(new Error("provider down")),
      () => new Promise<string>(() => {}),
    ]
  ) {
    await assert.rejects(searchTerms(respond, messages, 20));
  }
});

Deno.test("rewritten terms are unioned with keywords and failures keep keyword retrieval", async () => {
  const item = (id: string) => ({
    id,
    kind: "hub-native" as const,
    sourceId: "hub",
    sourceLabel: "Team",
    title: id,
  });
  const searched: string[] = [];
  const search = (term: string) => {
    searched.push(term);
    return Promise.resolve(
      term === "vendor payment terms"
        ? [item("Supplier invoices")]
        : term === "suppliers"
        ? [item("Supplier list")]
        : [],
    );
  };
  const load = (result: { title: string }) => Promise.resolve(result.title);
  const rewritten = await retrieveKnowledge(
    "When do we pay suppliers?",
    search,
    load,
    24_000,
    undefined,
    () => Promise.resolve(["Vendor payment terms"]),
  );
  assert.deepEqual(searched, [
    "vendor payment terms",
    "when",
    "pay",
    "suppliers",
  ]);
  assert.deepEqual(
    rewritten.citations.map((citation) => citation.title).sort(),
    ["Supplier invoices", "Supplier list"],
  );
  searched.length = 0;
  const fallback = await retrieveKnowledge(
    "When do we pay suppliers?",
    search,
    load,
    24_000,
    undefined,
    () => Promise.reject(new Error("bad JSON")),
  );
  assert.deepEqual(searched, ["when", "pay", "suppliers"]);
  assert.deepEqual(
    fallback.citations.map((citation) => citation.title),
    ["Supplier list"],
  );
});
