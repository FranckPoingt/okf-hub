/// <reference lib="deno.ns" />

import assert from "node:assert/strict";
import { presentationSlides } from "../src/lib/presentation.ts";

Deno.test("splits presentations on headings and dividers outside code", () => {
  assert.deepEqual(
    presentationSlides(`---
title: Example
---
# Example

Intro

## First

One

---

Two

\`\`\`md
## Not a slide
---
\`\`\`

### Last

Three`),
    [
      "Intro",
      "## First\n\nOne",
      "Two\n\n```md\n## Not a slide\n---\n```",
      "### Last\n\nThree",
    ],
  );
});

Deno.test("uses the presentation stage before scrolling slide content", async () => {
  const styles = await Deno.readTextFile("src/styles.css");
  assert.match(
    styles,
    /\.presentation-content-slide\s*{[^}]*height:\s*100%;[^}]*align-items:\s*safe center;[^}]*overflow:\s*auto;/s,
  );
  assert.match(
    styles,
    /\.presentation-content-slide \.milkdown\s*{[^}]*margin-block:\s*auto;/s,
  );
});
