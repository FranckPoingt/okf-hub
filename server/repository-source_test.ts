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
      "---\ntype: Runbook\ntitle: On-call\nowner: Platform\ntags: [operations, incident]\n---\n\n# Steps\n\nSee [Escalation](escalation.md).\n",
    );
    await git(origin, "add", ".");
    await git(origin, "commit", "-m", "first");

    const first = await syncRepository(checkout, origin, "okf");
    assert.equal(first.files[0].title, "On-call");
    assert.equal(
      first.files[0].body,
      "# Steps\n\nSee [Escalation](escalation.md).\n",
    );
    assert.deepEqual(first.files[0].tags, ["operations", "incident"]);
    assert.equal(first.files[0].owner, "Platform");
    assert.deepEqual(first.files[0].links, ["escalation.md"]);
    assert.match(first.files[0].searchText, /Platform/);
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

Deno.test("sends private repository credentials outside Git arguments", async () => {
  let authorization = "";
  const server = Deno.serve(
    { hostname: "127.0.0.1", port: 0, onListen() {} },
    (request) => {
      authorization = request.headers.get("authorization") ?? "";
      return new Response("Authentication required", {
        status: 401,
        headers: { "www-authenticate": 'Basic realm="private"' },
      });
    },
  );
  const checkout = await Deno.makeTempDir();
  await Deno.remove(checkout);
  try {
    const repositoryUrl = `http://127.0.0.1:${
      (server.addr as Deno.NetAddr).port
    }/private.git`;
    let error: unknown;
    try {
      await syncRepository(checkout, repositoryUrl, "okf", {
        username: "git-user",
        token: "private-token",
      });
    } catch (caught) {
      error = caught;
    }
    assert.ok(error instanceof Error);
    assert.equal(error.message.includes("private-token"), false);
    assert.equal(authorization, "Basic Z2l0LXVzZXI6cHJpdmF0ZS10b2tlbg==");
  } finally {
    await server.shutdown();
    await Deno.remove(checkout, { recursive: true }).catch(() => {});
  }
});
