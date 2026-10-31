/// <reference lib="deno.ns" />

import assert from "node:assert/strict";

const root = new URL("../", import.meta.url);

Deno.test("save-to-okf-hub skill has frontmatter and existing doc paths", async () => {
  const skill = await Deno.readTextFile(
    new URL("integrations/claude-code/skills/save-to-okf-hub/SKILL.md", root),
  );
  const front = skill.match(/^---\n([\s\S]+?)\n---\n/)?.[1] ?? "";
  assert.match(front, /^name: save-to-okf-hub$/m);
  assert.match(front, /^description: .{20,}/m);
  for (
    const path of [
      "docs/codex-artifacts.md",
      "docs/mcp.md",
      "examples/sovereign-artifact/context.md",
      "integrations/codex/AGENTS.md",
      "integrations/README.md",
    ]
  ) await Deno.stat(new URL(path, root));
});

Deno.test("Codex AGENTS.md repeats the Claude Code skill instructions", async () => {
  const body = async (path: string) =>
    (await Deno.readTextFile(new URL(path, root))).split("## When to use")[1];
  assert.equal(
    await body("integrations/codex/AGENTS.md"),
    await body("integrations/claude-code/skills/save-to-okf-hub/SKILL.md"),
  );
});
