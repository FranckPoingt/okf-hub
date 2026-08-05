/// <reference lib="deno.ns" />

import assert from "node:assert/strict";
import { syncRepository } from "./repository-source.ts";

async function git(cwd: string, ...args: string[]) {
  const result = await new Deno.Command("git", {
    cwd,
    args,
    stderr: "piped",
  }).output();
  assert.equal(result.success, true, new TextDecoder().decode(result.stderr));
}

Deno.test("clones, refreshes, and isolates invalid OKF files", async () => {
  const root = await Deno.makeTempDir();
  const origin = `${root}/origin`;
  const checkout = `${root}/checkout`;
  try {
    await Deno.mkdir(`${origin}/okf`, { recursive: true });
    await git(origin, "init", "--initial-branch=main");
    await git(origin, "config", "user.email", "test@example.com");
    await git(origin, "config", "user.name", "Test");
    await Deno.writeTextFile(
      `${origin}/okf/on-call.md`,
      "---\ntype: Runbook\ntitle: On-call\nteam: platform\n---\n\n# Steps\n",
    );
    await git(origin, "add", ".");
    await git(origin, "commit", "-m", "first");

    const first = await syncRepository(checkout, origin, "okf");
    assert.equal(first.files[0].title, "On-call");
    assert.equal(first.files[0].body, "# Steps\n");
    assert.deepEqual(first.issues, []);

    await Deno.writeTextFile(
      `${origin}/okf/broken.md`,
      "---\ntitle: Broken\n---\n",
    );
    await git(origin, "add", ".");
    await git(origin, "commit", "-m", "second");
    const second = await syncRepository(checkout, origin, "okf");
    assert.notEqual(second.revision, first.revision);
    assert.equal(second.files.length, 1);
    assert.match(second.issues[0].error, /non-empty type/);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});
