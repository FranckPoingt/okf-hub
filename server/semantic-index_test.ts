import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import type { Embedder } from "./ai.ts";
import {
  type RetrievalResult,
  retrieveKnowledge,
} from "./knowledge-retrieval.ts";
import {
  createSemanticIndex,
  type IndexedDocument,
  knowledgeChunks,
} from "./semantic-index.ts";

const paraphrase = "How do I recover access?";
const deterministic: Embedder = (texts) =>
  Promise.resolve(
    texts.map((text) =>
      /recover access|password|secret/i.test(text) ? [1, 0] : [0, 1]
    ),
  );

function fixture() {
  const db = new DatabaseSync(":memory:");
  db.exec(`PRAGMA foreign_keys=ON;
    CREATE TABLE okf_concept (id TEXT PRIMARY KEY, publishedRevision INTEGER);
    CREATE TABLE okf_imported_concept (id TEXT PRIMARY KEY, status TEXT, contentHash TEXT);
  `);
  const documents = new Map<string, { title: string; markdown: string }>();
  const logs: string[] = [];
  let clock = Date.now() + 10_000;
  function start(embed = deterministic, modelKey = "test") {
    return createSemanticIndex({
      db,
      embed,
      modelKey,
      intervalMs: 0,
      now: () => clock,
      log: (message) => logs.push(message),
      load: ({ id, state }) =>
        Promise.resolve(documents.get(`${id}:${state}`) ?? null),
    });
  }
  function hub(id: string, markdown: string, published?: string) {
    documents.set(`${id}:draft`, { title: id, markdown });
    if (published !== undefined) {
      documents.set(`${id}:published`, { title: id, markdown: published });
    }
    db.prepare("INSERT INTO okf_concept VALUES (?, ?)").run(
      id,
      published === undefined ? null : 1,
    );
  }
  function imported(id: string, markdown: string, version = "v1") {
    documents.set(`${id}:source`, { title: id, markdown });
    db.prepare(
      "INSERT INTO okf_imported_concept VALUES (?, 'current', ?) ON CONFLICT(id) DO UPDATE SET contentHash = excluded.contentHash, status = 'current'",
    ).run(id, version);
  }
  const item = (id: string): RetrievalResult => ({
    id,
    kind: "hub-native",
    sourceId: "hub",
    sourceLabel: "Team",
    title: id,
  });
  const allow = ({ id }: IndexedDocument) => Promise.resolve(item(id));
  async function drain(index: ReturnType<typeof start>) {
    for (let i = 0; i < 10; i++) await index.refresh();
  }
  return {
    db,
    documents,
    logs,
    start,
    hub,
    imported,
    item,
    allow,
    drain,
    advance: (ms: number) => {
      clock += ms;
    },
  };
}

Deno.test("heading chunks preserve content and bound oversized sections", () => {
  const markdown = `# One\n${"alpha ".repeat(220)}\n## Two\n${
    "beta ".repeat(700)
  }`;
  const chunks = knowledgeChunks(markdown);
  assert.ok(chunks.length >= 3);
  assert.ok(chunks.every((chunk) => chunk.length <= 1800));
  assert.ok(chunks.some((chunk) => chunk.startsWith("## Two")));
  assert.equal(
    chunks.join(" ").replace(/\s+/g, " "),
    markdown.replace(/\s+/g, " ").trim(),
  );
});

Deno.test("hybrid retrieves a paraphrase missed by lexical search, with existing budget and citations", async () => {
  const f = fixture();
  f.hub(
    "Account guide",
    "# Credentials\nReset your password.",
    "# Credentials\nReset your password.",
  );
  const index = f.start();
  try {
    await f.drain(index);
    const search = () => Promise.resolve([]);
    const load = () => Promise.resolve("# Credentials\nReset your password.");
    assert.deepEqual(
      (await retrieveKnowledge(paraphrase, search, load)).citations,
      [],
    );
    const hybrid = await retrieveKnowledge(
      paraphrase,
      search,
      load,
      200,
      (question) =>
        index.search(
          question,
          (doc) =>
            doc.state === "published" ? f.allow(doc) : Promise.resolve(null),
        ),
    );
    assert.equal(hybrid.citations[0].documentId, "Account guide");
    assert.equal(hybrid.citations[0].url, "/knowledge/Account%20guide");
    assert.match(hybrid.context, /Reset your password/);
    assert.ok(hybrid.context.length <= 200);
  } finally {
    await index.close();
    f.db.close();
  }
});

Deno.test("permissions exclude restricted sources, hidden drafts and archived concepts before ranking", async () => {
  const f = fixture();
  const index = f.start();
  try {
    f.imported("restricted", "Secret password recovery");
    f.hub("hidden", "Secret password recovery");
    f.hub("archived", "Secret password recovery", "Secret password recovery");
    f.hub(
      "visible",
      "Secret password recovery",
      "Public unrelated weather forecast",
    );
    await f.drain(index);
    const viewer = (doc: IndexedDocument) =>
      doc.id === "visible" && doc.state === "published"
        ? f.allow(doc)
        : Promise.resolve(null);
    assert.deepEqual(await index.search(paraphrase, viewer), []);
    const editor = (doc: IndexedDocument) =>
      doc.id === "visible" && doc.state === "draft"
        ? f.allow(doc)
        : Promise.resolve(null);
    assert.equal(
      (await index.search(paraphrase, editor))[0].item.id,
      "visible",
    );
    // A restriction applies immediately without rebuilding or deleting the vectors.
    assert.deepEqual(
      await index.search(paraphrase, () => Promise.resolve(null)),
      [],
    );
  } finally {
    await index.close();
    f.db.close();
  }
});

Deno.test("publish and source sync invalidate old vectors immediately, delete removes index rows", async () => {
  const f = fixture();
  const index = f.start();
  const published = (doc: IndexedDocument) =>
    doc.state !== "draft" ? f.allow(doc) : Promise.resolve(null);
  try {
    f.hub("guide", "Weather", "Weather");
    f.imported("repo/doc", "Weather");
    await f.drain(index);
    assert.deepEqual(await index.search(paraphrase, published), []);
    f.documents.set("guide:published", {
      title: "guide",
      markdown: "Reset password",
    });
    f.db.prepare(
      "UPDATE okf_concept SET publishedRevision = 2 WHERE id = 'guide'",
    ).run();
    f.imported("repo/doc", "Reset password", "v2");
    assert.deepEqual(await index.search(paraphrase, published), []);
    await f.drain(index);
    assert.deepEqual(
      (await index.search(paraphrase, published)).map((match) => match.item.id)
        .sort(),
      ["guide", "repo/doc"],
    );
    f.db.exec(
      "DELETE FROM okf_concept WHERE id = 'guide'; UPDATE okf_imported_concept SET status = 'deleted' WHERE id = 'repo/doc'",
    );
    assert.deepEqual(await index.search(paraphrase, published), []);
    assert.equal(
      (f.db.prepare("SELECT COUNT(*) AS n FROM okf_semantic_chunk").get() as {
        n: number;
      }).n,
      0,
    );
    f.db.exec("DELETE FROM okf_imported_concept");
    assert.equal(
      (f.db.prepare("SELECT COUNT(*) AS n FROM okf_semantic_document")
        .get() as { n: number }).n,
      0,
    );
  } finally {
    await index.close();
    f.db.close();
  }
});

Deno.test("draft writes debounce and unchanged content is not embedded again", async () => {
  const f = fixture();
  let calls = 0;
  const index = f.start((texts) => {
    calls++;
    return deterministic(texts);
  });
  try {
    f.hub("guide", "Reset password");
    await f.drain(index);
    assert.equal(calls, 1);
    f.db.exec(
      "UPDATE okf_concept SET publishedRevision = NULL WHERE id = 'guide'",
    );
    await f.drain(index);
    assert.equal(calls, 1);
    f.documents.set("guide:draft", {
      title: "guide",
      markdown: "Updated password procedure",
    });
    f.db.exec(
      "UPDATE okf_concept SET publishedRevision = NULL WHERE id = 'guide'",
    );
    // Use actual trigger timestamps to prove a draft is not sent before its debounce deadline.
    const due =
      (f.db.prepare("SELECT due FROM okf_semantic_document").get() as {
        due: number;
      }).due;
    const early = createSemanticIndex({
      db: f.db,
      embed: (texts) => {
        calls++;
        return deterministic(texts);
      },
      modelKey: "test",
      intervalMs: 0,
      now: () => due - 1,
      load: () => Promise.resolve(f.documents.get("guide:draft")!),
    });
    await early.refresh();
    assert.equal(calls, 1);
    await early.close();
    await index.refresh();
    assert.equal(calls, 2);
  } finally {
    await index.close();
    f.db.close();
  }
});

Deno.test("failed embeddings retry from a persistent backlog after restart without logging provider content", async () => {
  const f = fixture();
  f.hub("guide", "Reset password");
  let calls = 0;
  const failed = f.start(() => {
    calls++;
    return Promise.reject(new Error("SECRET_KEY and PRIVATE TEXT"));
  });
  await failed.refresh();
  await failed.refresh();
  assert.equal(calls, 1);
  assert.match(f.logs[0], /retry scheduled/);
  assert.ok(!f.logs.join("").includes("SECRET_KEY"));
  const search = () => Promise.resolve([f.item("guide")]);
  const load = () => Promise.resolve("Reset password");
  const baseline = await retrieveKnowledge(paraphrase, search, load);
  assert.deepEqual(
    await retrieveKnowledge(
      paraphrase,
      search,
      load,
      24_000,
      (question) => failed.search(question, f.allow),
    ),
    baseline,
  );
  await failed.close();
  f.advance(2_000);
  const resumed = f.start();
  try {
    await f.drain(resumed);
    assert.equal(
      (await resumed.search(paraphrase, f.allow))[0].item.id,
      "guide",
    );
  } finally {
    await resumed.close();
    f.db.close();
  }
});

Deno.test("indexing concurrency is bounded and in-flight deletes cannot resurrect chunks", async () => {
  const f = fixture();
  for (let i = 0; i < 5; i++) f.hub(`doc${i}`, "Reset password");
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let entered = 0;
  let ready!: () => void;
  const started = new Promise<void>((resolve) => {
    ready = resolve;
  });
  const index = f.start(async (texts) => {
    if (++entered === 2) ready();
    await gate;
    return await deterministic(texts);
  });
  try {
    const work = index.refresh();
    await started;
    assert.equal(entered, 2);
    f.db.exec("DELETE FROM okf_concept");
    release();
    await work;
    assert.equal(
      (f.db.prepare("SELECT COUNT(*) AS n FROM okf_semantic_chunk").get() as {
        n: number;
      }).n,
      0,
    );
  } finally {
    release();
    await index.close();
    f.db.close();
  }
});

Deno.test("model changes re-embed existing content; malformed vectors leave lexical fallback", async () => {
  const f = fixture();
  f.hub("guide", "Reset password");
  const original = f.start();
  await f.drain(original);
  await original.close();
  const invalid = f.start(() => Promise.resolve([[NaN]]), "new-model");
  try {
    assert.deepEqual(await invalid.search(paraphrase, f.allow), []);
    await invalid.refresh();
    assert.match(f.logs.at(-1)!, /retry scheduled/);
  } finally {
    await invalid.close();
  }
  f.advance(2_000);
  let calls = 0;
  const replacement = f.start((texts) => {
    calls++;
    return deterministic(texts);
  }, "new-model");
  try {
    await f.drain(replacement);
    assert.equal(calls, 1);
    assert.equal(
      (await replacement.search(paraphrase, f.allow))[0].item.id,
      "guide",
    );
  } finally {
    await replacement.close();
    f.db.close();
  }
});
