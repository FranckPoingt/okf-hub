/// <reference lib="deno.ns" />

import assert from "node:assert/strict";
import { Schema } from "@milkdown/kit/prose/model";
import { EditorState } from "@milkdown/kit/prose/state";
import { resolvePreviewLinks } from "../src/lib/knowledge-preview.ts";

Deno.test("renders missing and inaccessible knowledge links as plain text without changing source documents", () => {
  const schema = new Schema({
    nodes: { doc: { content: "text*" }, text: {} },
    marks: { link: { attrs: { href: {} } } },
  });
  const hrefs = [
    "okf://repo-a/customer.md",
    "okf://secret/customer.md",
    "okf://missing/customer.md",
    "missing.md",
    "https://example.com",
    "#heading",
  ];
  const doc = schema.node(
    "doc",
    null,
    hrefs.map((href, index) =>
      schema.text(`label${index}`, [schema.mark("link", { href })])
    ),
  );
  const state = EditorState.create({ doc });
  const source = JSON.stringify(state.doc.toJSON());
  const resolved = resolvePreviewLinks(
    state.tr,
    { [hrefs[0]]: "/imports/repo-a/customer.md" },
    true,
  ).doc;
  assert.equal(
    resolved.child(0).marks[0].attrs.href,
    "/imports/repo-a/customer.md",
  );
  assert.equal(resolved.child(1).textContent, "label1label2label3");
  assert.equal(resolved.child(1).marks.length, 0);
  assert.equal(resolved.child(2).marks[0].attrs.href, hrefs[4]);
  assert.equal(resolved.child(3).marks[0].attrs.href, hrefs[5]);
  assert.equal(JSON.stringify(state.doc.toJSON()), source);
  const failClosed = resolvePreviewLinks(state.tr, {}, false).doc;
  assert.equal(failClosed.child(0).textContent, "label0label1label2");
  assert.equal(failClosed.child(0).marks.length, 0);
  assert.equal(failClosed.textContent, doc.textContent);
});
