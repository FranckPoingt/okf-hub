/// <reference lib="deno.ns" />

import assert from "node:assert/strict";
import { inspectOkf } from "../server/repository-source.ts";

Deno.test("keeps the public documentation bundle conformant with OKF v0.2", async () => {
  const root = new URL("../docs/", import.meta.url);
  const index = await Deno.readTextFile(new URL("index.md", root));
  assert.match(index, /^---\nokf_version: "0\.2"\n---\n\n# /);

  let concepts = 0;
  for await (const entry of Deno.readDir(root)) {
    if (
      !entry.isFile || !entry.name.endsWith(".md") ||
      entry.name === "index.md" || entry.name === "log.md"
    ) continue;
    await inspectOkf(
      entry.name,
      await Deno.readTextFile(new URL(entry.name, root)),
    );
    concepts++;
  }
  assert.ok(concepts > 0);
});
