/// <reference lib="deno.ns" />

import assert from "node:assert/strict";
import { Schema } from "@milkdown/kit/prose/model";
import { EditorState } from "@milkdown/kit/prose/state";
import { insertReference } from "../src/lib/insert-reference.ts";

const schema = new Schema({
  nodes: {
    doc: { content: "paragraph+" },
    paragraph: { content: "text*" },
    text: {},
  },
  marks: { link: { attrs: { href: {} } } },
});

Deno.test("inserted page references keep their link mark", () => {
  let state = EditorState.create({ schema });
  insertReference(
    {
      get state() {
        return state;
      },
      dispatch: (transaction) => {
        state = state.apply(transaction);
      },
      focus: () => {},
    },
    "Zip artifact",
    "okf://hub/zip-artifact",
  );
  const text = state.doc.firstChild!.firstChild!;
  assert.equal(text.text, "Zip artifact");
  assert.equal(text.marks[0]?.attrs.href, "okf://hub/zip-artifact");
});
