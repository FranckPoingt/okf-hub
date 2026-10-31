/// <reference lib="deno.ns" />
import assert from "node:assert/strict";
import { DraftSaveQueue } from "../src/lib/draft-save.ts";

Deno.test("serializes checkpoints and saves edits made during an in-flight request", async () => {
  const writes: string[] = [];
  const states: string[] = [];
  let release!: () => void;
  const gate = new Promise<void>((resolve) => release = resolve);
  const queue = new DraftSaveQueue(
    async (_id, markdown) => {
      writes.push(markdown);
      if (writes.length === 1) await gate;
    },
    (_id, state) => states.push(state),
    60_000,
  );
  queue.stage("one", "first");
  const flushed = queue.flush("one");
  queue.stage("one", "latest");
  assert.deepEqual(writes, ["first"]);
  assert.equal(queue.hasPending(), true);
  release();
  assert.equal(await flushed, true);
  assert.deepEqual(writes, ["first", "latest"]);
  assert.equal(states.at(-1), "saved");
  assert.equal(queue.hasPending(), false);
  queue.clear();
});

Deno.test("keeps failed content available for retry and flushes independent documents", async () => {
  let fail = true;
  const writes: string[] = [];
  const queue = new DraftSaveQueue(
    (id, markdown) => {
      if (fail) return Promise.reject(new Error("offline"));
      writes.push(`${id}:${markdown}`);
      return Promise.resolve();
    },
    () => {},
    60_000,
  );
  queue.stage("one", "retained");
  assert.equal(await queue.flush("one"), false);
  assert.equal(queue.state("one"), "failed");
  assert.equal(queue.error("one"), "offline");
  assert.equal(queue.hasPending(), true);
  fail = false;
  queue.stage("two", "second");
  assert.equal(await queue.flushAll(), true);
  assert.equal(queue.error("one"), undefined);
  assert.deepEqual(writes.sort(), ["one:retained", "two:second"]);
  assert.equal(queue.hasPending(), false);
  queue.clear();
});

Deno.test("clearing a session suppresses stale save callbacks", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => release = resolve);
  const states: string[] = [];
  const queue = new DraftSaveQueue(
    () => gate,
    (_id, state) => states.push(state),
    60_000,
  );
  queue.stage("one", "private");
  const flushed = queue.flush("one");
  queue.clear();
  const count = states.length;
  release();
  await flushed;
  assert.equal(states.length, count);
  assert.equal(queue.hasPending(), false);
});

Deno.test("accepts a restored server basis before deduplicating later edits", async () => {
  const writes: string[] = [];
  let stored = "";
  const queue = new DraftSaveQueue(
    (_id, markdown) => {
      stored = markdown;
      writes.push(markdown);
      return Promise.resolve();
    },
    () => {},
    60_000,
  );
  queue.stage("one", "A");
  assert.equal(await queue.flush("one"), true);
  stored = "B"; // A server restore or another editing session changed the draft.
  assert.equal(queue.accept("one", stored), true);
  queue.stage("one", "A");
  assert.equal(await queue.flush("one"), true);
  assert.equal(stored, "A");
  assert.deepEqual(writes, ["A", "A"]);
  queue.clear();
});

Deno.test("refuses a server basis while local edits are pending or a checkpoint is running", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => release = resolve);
  const writes: string[] = [];
  let acceptedDuringCompletion: boolean | undefined;
  const queue = new DraftSaveQueue(async (_id, markdown) => {
    writes.push(markdown);
    await gate;
  }, (id, state) => {
    if (state === "saved") {
      acceptedDuringCompletion = queue.accept(id, "server replacement");
    }
  }, 60_000);
  assert.equal(queue.accept("one", "initial"), true);
  queue.stage("one", "unsaved local changes");
  assert.equal(queue.accept("one", "stale server body"), false);
  const flushed = queue.flush("one");
  assert.equal(queue.accept("one", "another server body"), false);
  release();
  assert.equal(await flushed, true);
  assert.deepEqual(writes, ["unsaved local changes"]);
  assert.equal(acceptedDuringCompletion, false);
  assert.equal(queue.accept("one", "acknowledged server body"), true);
  queue.stage("one", "acknowledged server body");
  assert.equal(queue.hasPending(), false);
  queue.clear();
});

// The editor drops the leading `# Title` and re-serializes list markers when it
// opens a document; neither may be saved as a draft change.
const editorNormalize = (markdown: string) =>
  markdown.replace(/^#\s+[^\n]*\n+/, "").replace(/^\* /gm, "- ");

for (
  const apiMarkdown of ["# Title\n\nBody\n", "# Title\n\n* one\n* two\n"]
) {
  Deno.test(
    `opening an API-written document is not a draft change: ${
      JSON.stringify(apiMarkdown)
    }`,
    async () => {
      const writes: string[] = [];
      const queue = new DraftSaveQueue(
        (_id, markdown) => {
          writes.push(markdown);
          return Promise.resolve();
        },
        () => {},
        60_000,
      );
      queue.accept("doc", apiMarkdown);
      const opened = editorNormalize(apiMarkdown);
      assert.notEqual(opened, apiMarkdown);
      queue.accept("doc", opened); // editor reports its baseline after loading
      assert.equal(queue.differs("doc", opened), false);
      queue.stage("doc", opened);
      assert.equal(queue.hasPending(), false);
      assert.equal(await queue.flush("doc"), true);
      assert.deepEqual(writes, []);

      queue.stage("doc", `${opened}More\n`);
      assert.equal(queue.differs("doc", `${opened}More\n`), true);
      assert.equal(await queue.flush("doc"), true);
      assert.deepEqual(writes, [`${opened}More\n`]);
      queue.clear();
    },
  );
}
