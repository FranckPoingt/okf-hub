/// <reference lib="deno.ns" />

import assert from "node:assert/strict";
import { parse } from "@std/yaml";

Deno.test("releases validated main commits from semantic version tags", async () => {
  const workflow = parse(
    await Deno.readTextFile(".github/workflows/release.yml"),
  ) as Record<string, unknown>;
  const trigger = workflow.on as {
    push: { tags: string[] };
  };
  const release = (workflow.jobs as {
    release: { steps: { run?: string }[] };
  }).release;
  const commands = release.steps.flatMap((step) => step.run ?? []).join("\n");

  assert.deepEqual(trigger.push.tags, ["v*.*.*"]);
  assert.match(commands, /merge-base --is-ancestor/);
  assert.match(commands, /deno task test/);
  assert.match(commands, /gh release create/);
});
