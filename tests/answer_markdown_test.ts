/// <reference lib="deno.ns" />
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  AnswerMarkdown,
  safeAnswerHref,
} from "../src/components/answer-markdown.tsx";

Deno.test("Ask answers format Markdown without executing HTML or loading images", () => {
  const output = renderToStaticMarkup(createElement(AnswerMarkdown, {
    content:
      '## Explanation\n\n**Important** steps:\n\n- Read `policy`\n- Ask a question\n\n```ts\nconst safe = true;\n```\n\n[reference]: https://example.com/reference\n\n<img src="https://tracker.example/pixel" onerror="alert(1)">\n\n![Tracking image](https://tracker.example/image.png)\n\n[Unsafe](javascript:alert%281%29) and [Evidence](https://example.com/evidence)',
  }));
  assert.match(output, /<h2[^>]*>Explanation<\/h2>/);
  assert.match(output, /<strong>Important<\/strong>/);
  assert.match(output, /<ul[^>]*>/);
  assert.match(output, /<pre[^>]*><code>const safe = true;<\/code><\/pre>/);
  assert.match(output, /&lt;img/);
  assert.match(output, /\[reference\]: https:\/\/example.com\/reference/);
  assert.doesNotMatch(output, /<img|<iframe|href="javascript:/);
  assert.match(output, /href="https:\/\/example.com\/evidence"/);
});

Deno.test("Ask answer links permit normal URLs and hub paths only", () => {
  for (
    const href of [
      "javascript:alert(1)",
      "data:text/html,hello",
      "//tracker.example",
      "java\nscript:alert(1)",
      "file:///private/file",
      "/settings/developer",
      "relative.md",
    ]
  ) {
    assert.equal(safeAnswerHref(href), undefined, href);
  }
  assert.equal(
    safeAnswerHref("https://example.com/evidence"),
    "https://example.com/evidence",
  );
  assert.equal(safeAnswerHref("/knowledge/policy"), "/knowledge/policy");
  assert.equal(
    safeAnswerHref("/imports/repository/team/policy.md"),
    "/imports/repository/team/policy.md",
  );
});
