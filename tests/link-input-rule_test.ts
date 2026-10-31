/// <reference lib="deno.ns" />

import assert from "node:assert/strict";
import { Schema } from "@milkdown/kit/prose/model";
import { EditorState } from "@milkdown/kit/prose/state";
import {
  markdownLinkHandler,
  markdownLinkPattern,
} from "../src/lib/link-input-rule.ts";

const schema = new Schema({
  nodes: {
    doc: { content: "paragraph+" },
    paragraph: { content: "text*" },
    text: {},
  },
  marks: { link: { attrs: { href: {} } } },
});

// Mirrors ProseMirror: the rule sees text-before plus the typed ")", the doc lacks that ")".
function type(text: string) {
  const typed = text.slice(0, -1);
  const state = EditorState.create({
    schema,
    doc: schema.node("doc", null, [
      schema.node("paragraph", null, typed ? [schema.text(typed)] : []),
    ]),
  });
  const match = markdownLinkPattern.exec(text);
  if (!match) return null;
  const start = 1 + match.index;
  const tr = markdownLinkHandler(state, match, start, 1 + typed.length);
  return tr && state.apply(tr).doc.firstChild!;
}

Deno.test("typing [label](url) becomes a link", () => {
  const paragraph = type("see [the docs](https://example.com/a)")!;
  assert.equal(paragraph.textContent, "see the docs");
  const linked = paragraph.child(1);
  assert.equal(linked.text, "the docs");
  assert.equal(linked.marks[0].attrs.href, "https://example.com/a");
});

Deno.test("link input rule skips images and script URLs", () => {
  assert.equal(type("![alt](https://example.com/a.png)"), null);
  for (
    const href of [
      "javascript:alert1",
      "JaVaScRiPt:alert1",
      "data:text/html,x",
      "vbscript:x",
      "file:///etc/passwd",
    ]
  ) assert.equal(type(`[x](${href})`), null, href);
  for (const href of ["okf://repository/a.md", "/knowledge/a", "a.md", "#h"]) {
    assert.ok(type(`[x](${href})`), href);
  }
  assert.equal(type("[x](no spaces)"), null);
});
