/// <reference lib="deno.ns" />

import assert from "node:assert/strict";
import {
  buildKnowledgeGraph,
  CONFLICT_THRESHOLD,
  definitionContent,
  definitionDifference,
  type GraphDocument,
  potentialConflict,
} from "./knowledge-graph.ts";
import {
  portableKnowledgeLink,
  resolveKnowledgeLink,
} from "../src/lib/knowledge-links.ts";

function document(
  id: string,
  sourceId: string,
  extra: Partial<GraphDocument> = {},
): GraphDocument {
  return {
    id,
    sourceId,
    kind: sourceId === "hub" ? "hub-native" : "imported",
    path: sourceId === "hub" ? undefined : `${id.split("/").pop()}.md`,
    title: id,
    type: "Glossary",
    sourceLabel: sourceId,
    trust: "current",
    body: "A customer who placed an order in the last thirty days.",
    linkHrefs: [],
    ...extra,
  };
}

Deno.test("resolves portable links between repositories and hub-native knowledge", () => {
  const hub = document("active-customer", "hub", {
    linkHrefs: ["okf://repo-a/glossary/customer.md"],
  });
  const repoA = document("repo-a/customer", "repo-a", {
    path: "glossary/customer.md",
    linkHrefs: ["okf://repo-b/customer", "okf://hub/active-customer"],
  });
  const repoB = document("repo-b/customer", "repo-b", {
    linkHrefs: [
      "okf://repo-a/glossary/customer.md",
      "okf://hub/active-customer",
    ],
  });
  const visible = [hub, repoA, repoB];
  const graph = buildKnowledgeGraph(visible);
  assert.deepEqual(graph.get(hub.id)!.links.map((item) => item.id), [repoA.id]);
  assert.deepEqual(graph.get(hub.id)!.backlinks.map((item) => item.id), [
    repoA.id,
    repoB.id,
  ]);
  assert.deepEqual(graph.get(repoA.id)!.links.map((item) => item.id), [
    repoB.id,
    hub.id,
  ]);
  assert.equal(
    resolveKnowledgeLink(repoB, "okf://hub/active-customer#definition", visible)
      ?.href,
    "/knowledge/active-customer#definition",
  );
  assert.equal(
    resolveKnowledgeLink(hub, "okf://repo-a/glossary/customer.md", visible)
      ?.href,
    "/imports/repo-a/glossary/customer.md",
  );
  assert.equal(
    portableKnowledgeLink(repoA),
    "okf://repo-a/glossary/customer.md",
  );
  assert.equal(portableKnowledgeLink(hub), "okf://hub/active-customer");
});

Deno.test("keeps source-relative links and encoded portable paths consistent", () => {
  const source = document("repo-a/start", "repo-a", {
    path: "guides/start.md",
  });
  const target = document("repo-a/title", "repo-a", {
    path: "glossary/Active customer.md",
  });
  const visible = [source, target];
  for (
    const href of [
      "../glossary/Active%20customer.md",
      "okf://repo-a/glossary/Active%20customer.md",
    ]
  ) {
    assert.equal(
      resolveKnowledgeLink(source, href, visible)?.target.id,
      target.id,
    );
  }
  for (
    const href of [
      "okf://repo-a/../glossary/Active%20customer.md",
      "okf://repo-a/%2e%2e/title.md",
      "okf://repo-a/%zz",
      "okf://repo-a/title.md?query=1",
      "okf://repo-a/a\\b",
      "okf://user@repo-a/title.md",
      "okf://repo-a/",
      "https://example.com",
      "#local",
    ]
  ) {
    assert.equal(resolveKnowledgeLink(source, href, visible), null, href);
  }
});

Deno.test("hidden and missing concepts produce identical graph output with no backlinks or entity signals", () => {
  const publicDoc = document("public", "hub", {
    stableId: "company.customer",
    linkHrefs: ["okf://secret/customer.md", "okf://unknown/customer.md"],
  });
  const secret = document("secret/customer", "secret", {
    stableId: "company.customer",
    linkHrefs: ["okf://hub/public"],
    body: "Never used the product.",
  });
  const authorized = [publicDoc, secret];
  assert.equal(
    buildKnowledgeGraph(authorized).get("public")!.conflicts.length,
    1,
  );
  const permitted = authorized.filter((item) => item.sourceId !== "secret");
  assert.deepEqual(
    buildKnowledgeGraph(permitted),
    buildKnowledgeGraph([publicDoc]),
  );
  const graph = buildKnowledgeGraph(permitted).get("public")!;
  assert.deepEqual(graph.backlinks, []);
  assert.deepEqual(graph.alsoDefinedIn, []);
  assert.deepEqual(graph.conflicts, []);
  assert.equal(Object.keys(graph.linkTargets).length, 0);
  assert.equal(JSON.stringify(graph).includes("secret"), false);
});

Deno.test("groups shared ids and normalized type/title across sources, including transitive identity", () => {
  const a = document("a/customer", "a", {
    title: "Active customer",
    stableId: "customer.v1",
  });
  const b = document("b/customer", "b", {
    title: "  ACTIVE   CUSTOMER ",
    type: "glossary",
    stableId: "other-id",
  });
  const c = document("c/customer", "c", {
    title: "Paying account",
    type: "Metric",
    stableId: "customer.v1",
  });
  const unrelated = document("d/customer", "d", {
    title: "Active customer",
    type: "Policy",
  });
  const local = document("a/duplicate", "a", { title: "Active customer" });
  const graph = buildKnowledgeGraph([a, b, c, unrelated, local]);
  assert.deepEqual(graph.get(a.id)!.alsoDefinedIn.map((item) => item.id), [
    b.id,
    c.id,
  ]);
  assert.deepEqual(graph.get(unrelated.id)!.alsoDefinedIn, []);
});

Deno.test("conflict threshold ignores formatting and identifies materially different definitions", () => {
  assert.equal(
    definitionDifference(
      "# Customer\n\nAn **active** CUSTOMER.",
      "an active customer",
    ),
    0,
  );
  assert.equal(definitionDifference("", " \n"), 0);
  assert.equal(definitionDifference("", "customer"), 1);
  assert.equal(potentialConflict("customer", "customer"), false);
  assert.equal(potentialConflict("customer", "supplier"), true);
  assert.ok(
    definitionDifference("one two three four five", "one two three four six") <
      CONFLICT_THRESHOLD,
  );
  assert.ok(
    definitionDifference("one two three four five", "one two three six seven") >
      CONFLICT_THRESHOLD,
  );
  const a = document("a/customer", "a", { title: "Customer" });
  const b = document("b/customer", "b", {
    title: "Customer",
    body: "An account that has never signed in or bought anything.",
  });
  assert.equal(buildKnowledgeGraph([a, b]).get(a.id)!.conflicts[0].id, b.id);
  b.body = undefined;
  assert.deepEqual(buildKnowledgeGraph([a, b]).get(a.id)!.conflicts, []);
});

Deno.test("extracts stable frontmatter ids without confusing nested ids or leaking metadata into comparisons", () => {
  assert.deepEqual(
    definitionContent(
      '---\ntype: Glossary\nid: "company:customer"\nsources:\n  - id: unrelated\n---\n\nDefinition.',
    ),
    { stableId: "company:customer", body: "Definition." },
  );
  assert.equal(
    definitionContent("---\ntype: Glossary\nid: 123\n---\nBody").stableId,
    undefined,
  );
  assert.equal(
    definitionContent("---\nid: [invalid\n---\nBody").stableId,
    undefined,
  );
});
