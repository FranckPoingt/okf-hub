import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { createSearchIndex, searchState } from "./search-index.ts";

function fixture() {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE okf_concept (id TEXT PRIMARY KEY);
    CREATE TABLE okf_imported_concept (
      id TEXT PRIMARY KEY, title TEXT, type TEXT, status TEXT,
      tags TEXT NOT NULL DEFAULT '[]', searchText TEXT NOT NULL DEFAULT ''
    );
  `);
  const index = createSearchIndex(db);
  const hub = (id: string, state: "draft" | "published", body: string) =>
    index.replace(id, state, { title: id, type: "Guide", tags: [], body });
  return { db, index, hub };
}

Deno.test("porter stemming and word roots match related forms", () => {
  const { index, hub } = fixture();
  hub("terms", "draft", "Payment is due within 30 days.");
  hub("other", "draft", "Vacation policy.");
  assert.deepEqual([...index.rank("paying").keys()], ["terms\ndraft"]);
  assert.deepEqual([...index.rank("payments").keys()], ["terms\ndraft"]);
  // Typed prefixes keep matching, as the former substring search did.
  assert.deepEqual([...index.rank("pay").keys()], ["terms\ndraft"]);
  assert.deepEqual([...index.rank("vacat").keys()], ["other\ndraft"]);
  assert.equal(index.rank("payment vacation").size, 0);
});

Deno.test("BM25 ranks focused and title matches first", () => {
  const { index } = fixture();
  index.replace("passing", "draft", {
    title: "Office guide",
    type: "Guide",
    tags: [],
    body: `Parking and lunch. ${"Other office notes. ".repeat(40)} Invoice.`,
  });
  index.replace("focused", "draft", {
    title: "Invoice approvals",
    type: "Process",
    tags: ["finance"],
    body: "Every invoice needs an approver. Invoices over budget escalate.",
  });
  const ranked = [...index.rank("invoice").entries()].sort((a, b) =>
    b[1] - a[1]
  );
  assert.deepEqual(ranked.map(([key]) => key), [
    "focused\ndraft",
    "passing\ndraft",
  ]);
  assert.ok(ranked.every(([, score]) => score > 0));
});

Deno.test("query syntax is quoted and never throws", () => {
  const { index, hub } = fixture();
  hub("doc", "draft", "Near the payment desk: title secrets.");
  for (
    const query of [
      '"',
      "*",
      "NEAR(",
      "NEAR(payment desk",
      "title:secrets",
      ":",
      '"payment" OR',
      "AND OR NOT",
      "payment^ -desk",
      "{title}: x",
      "",
    ]
  ) {
    assert.doesNotThrow(() => index.rank(query), query);
  }
  assert.deepEqual([...index.rank('NEAR("payment').keys()], ["doc\ndraft"]);
  assert.equal(index.rank("*").size, 0);
});

Deno.test("draft and published rows stay separate and imports follow SQL", () => {
  const { db, index, hub } = fixture();
  hub("guide", "published", "Public wording");
  hub("guide", "draft", "Confidential wording");
  assert.deepEqual([...index.rank("confidential").keys()], ["guide\ndraft"]);
  assert.deepEqual([...index.rank("public").keys()], ["guide\npublished"]);
  hub("guide", "draft", "Rewritten wording");
  assert.equal(index.rank("confidential").size, 0);

  db.prepare(
    "INSERT INTO okf_imported_concept VALUES ('repo/a', 'Runbook', 'Guide', 'current', '[\"ops\"]', 'Runbook\nRestart the payment worker')",
  ).run();
  assert.deepEqual([...index.rank("paying worker").keys()], [
    "repo/a\nsource",
  ]);
  db.prepare("UPDATE okf_imported_concept SET status = 'deleted'").run();
  assert.equal(index.rank("worker").size, 0);
  db.prepare("UPDATE okf_imported_concept SET status = 'current'").run();
  db.prepare("DELETE FROM okf_imported_concept").run();
  assert.equal(index.rank("worker").size, 0);
  db.prepare("INSERT INTO okf_concept VALUES ('guide')").run();
  db.prepare("DELETE FROM okf_concept").run();
  assert.equal(index.rank("wording").size, 0);
});

Deno.test("startup indexes existing imports once", () => {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE okf_concept (id TEXT PRIMARY KEY);
    CREATE TABLE okf_imported_concept (
      id TEXT PRIMARY KEY, title TEXT, type TEXT, status TEXT,
      tags TEXT NOT NULL DEFAULT '[]', searchText TEXT NOT NULL DEFAULT ''
    );
    INSERT INTO okf_imported_concept VALUES ('a', 'Alpha', 'Guide', 'current', '[]', 'alpha body');
    INSERT INTO okf_imported_concept VALUES ('b', 'Beta', 'Guide', 'invalid', '[]', 'beta body');
  `);
  createSearchIndex(db);
  const index = createSearchIndex(db);
  assert.deepEqual([...index.rank("body").keys()], ["a\nsource"]);
});

Deno.test("users match the state they may see", () => {
  assert.equal(searchState({ kind: "imported" }), "source");
  assert.equal(
    searchState({ kind: "hub-native", canEdit: false }),
    "published",
  );
  assert.equal(
    searchState({
      kind: "hub-native",
      canEdit: true,
      status: "active",
      publishedRevision: 2,
    }),
    "draft",
  );
  assert.equal(
    searchState({
      kind: "hub-native",
      canEdit: true,
      status: "archived",
      publishedRevision: 2,
    }),
    "published",
  );
});
