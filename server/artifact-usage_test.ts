/// <reference lib="deno.ns" />

import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { createArtifactStore } from "./artifact-store.ts";
import { createArtifactUsage } from "./artifact-usage.ts";

function setup() {
  const db = new DatabaseSync(":memory:");
  const store = createArtifactStore(db);
  db.exec(`CREATE TABLE okf_revision (
    conceptId TEXT NOT NULL, number INTEGER NOT NULL, actorUserId TEXT NOT NULL
  )`);
  const app = store.create({
    conceptId: "doc",
    title: "App",
    description: "",
    grants: [],
    type: "inline_html",
    content: "<p>v1</p>",
    actorUserId: "creator",
  });
  return { db, store, app: app!, usage: createArtifactUsage(db) };
}

Deno.test("records one open per user per artifact per hour", () => {
  const { usage } = setup();
  const start = new Date("2026-01-01T00:00:00Z");
  assert.equal(usage.record("doc", "ada", start), true);
  assert.equal(
    usage.record("doc", "ada", new Date(+start + 59 * 60_000)),
    false,
  );
  assert.equal(usage.record("doc", "grace", start), true);
  assert.equal(usage.record("other", "ada", start), true);
  assert.equal(
    usage.record("doc", "ada", new Date(+start + 61 * 60_000)),
    true,
  );
});

Deno.test("derives reuse by non-creators over 30 days and all time", () => {
  const { store, app, usage } = setup();
  const day = 86_400_000;
  const start = new Date("2026-01-01T00:00:00Z");
  usage.record("doc", "creator", start);
  usage.record("doc", "ada", start);
  usage.record("doc", "grace", new Date(+start + 40 * day));
  usage.record("doc", "grace", new Date(+start + 42 * day));
  const now = new Date(+start + 45 * day);
  assert.deepEqual(usage.summary("doc", now), {
    viewers30d: 1,
    viewersAllTime: 2,
    othersSaves: 0,
    lastOpenedAt: new Date(+start + 42 * day).toISOString(),
  });
  store.revise(app.id, "<p>v2</p>", "creator");
  store.revise(app.id, "<p>v3</p>", "ada");
  assert.equal(usage.summary("doc", now).othersSaves, 1);
  assert.deepEqual(usage.reused(now), [{ conceptId: "doc", viewers: 1 }]);
  assert.deepEqual(usage.reused(new Date(+start + 100 * day)), []);
  assert.equal(usage.summary("unknown").viewersAllTime, 0);
});

Deno.test("counts published document revisions by others as reuse", () => {
  const { db, usage } = setup();
  db.prepare("INSERT INTO okf_revision VALUES ('doc', 1, 'creator')").run();
  db.prepare("INSERT INTO okf_revision VALUES ('doc', 2, 'grace')").run();
  assert.equal(usage.summary("doc").othersSaves, 1);
});
