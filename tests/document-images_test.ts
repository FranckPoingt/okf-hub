/// <reference lib="deno.ns" />

import assert from "node:assert/strict";

Deno.test("editor uploads images to the document store with alt-text captions", async () => {
  const editor = await Deno.readTextFile(
    "src/components/editor/document-editor.tsx",
  );
  assert.doesNotMatch(editor, /Crepe\.Feature\.ImageBlock\]: false/);
  assert.match(editor, /\$\{conceptPath\(conceptId\)\}\/images/);
  // Failed uploads resolve to "" and are filtered, so no blob: URL is saved.
  assert.doesNotMatch(editor, /createObjectURL/);
  assert.match(editor, /urls\.filter\(Boolean\)/);
  assert.match(editor, /role="alert">\{uploadError\}/);

  const scripts: string[] = [];
  for await (const entry of Deno.readDir("dist/assets")) {
    if (entry.isFile && entry.name.endsWith(".js")) {
      scripts.push(await Deno.readTextFile(`dist/assets/${entry.name}`));
    }
  }
  assert.match(scripts.join("\n"), /Describe the image \(alt text\)/);
});
