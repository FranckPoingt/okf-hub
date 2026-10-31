import assert from "node:assert/strict";
import type { GitHubAppClient } from "./github-app.ts";
import { openRepositoryPR } from "./github-pr.ts";

const app: GitHubAppClient = {
  slug: "test",
  installUrl: "https://github.com/apps/test",
  folders: () => Promise.resolve([]),
  verify: () => true,
  repositories: () =>
    Promise.resolve([{
      id: 1,
      fullName: "org/repo",
      defaultBranch: "main",
      cloneUrl: "https://github.com/org/repo.git",
      private: false,
    }]),
  credentials: () =>
    Promise.resolve({ username: "x-access-token", token: "fake" }),
};
const proposal = {
  app,
  installationId: 1,
  repositoryId: 1,
  revision: "base",
  files: [{ path: "okf/overview.md", markdown: "content" }],
  title: "Draft",
  body: "AI-drafted. Review before merging.",
};
Deno.test("fake GitHub writes only a new proposal ref, PR base is default", async () => {
  const calls: {
    path: string;
    method: string;
    body: Record<string, unknown>;
  }[] = [];
  const result = await openRepositoryPR({
    ...proposal,
    fetcher: (url, init) => {
      const path = new URL(String(url)).pathname;
      const body = JSON.parse(String(init?.body ?? "{}"));
      calls.push({ path, method: init!.method!, body });
      const response = path.endsWith("/ref/heads/main")
        ? { object: { sha: "base" } }
        : path.endsWith("/commits/base")
        ? { tree: { sha: "base-tree" } }
        : path.endsWith("/pulls")
        ? { html_url: "https://github.com/org/repo/pull/1" }
        : { sha: "new-sha" };
      return Promise.resolve(Response.json(response));
    },
  });
  assert.equal(result.url, "https://github.com/org/repo/pull/1");
  assert(result.branch.startsWith("okf-proposal/"));
  assert(calls.every((call) => ["GET", "POST"].includes(call.method)));
  assert.deepEqual(
    calls.filter((call) => call.path.endsWith("/git/refs")).map((call) =>
      call.body.ref
    ),
    [`refs/heads/${result.branch}`],
  );
  assert.equal(calls.at(-1)!.body.base, "main");
  assert.equal(calls.at(-1)!.body.head, result.branch);
  assert.equal(calls.at(-1)!.body.draft, true);
});
Deno.test("GitHub denies moved base, inaccessible repositories, permissions and unsafe paths before writes", async () => {
  let writes = 0;
  const fetcher: typeof fetch = (_url, init) => {
    if (init?.method !== "GET") writes++;
    return Promise.resolve(Response.json({ object: { sha: "moved" } }));
  };
  await assert.rejects(
    () => openRepositoryPR({ ...proposal, fetcher }),
    /Repository changed/,
  );
  await assert.rejects(
    () => openRepositoryPR({ ...proposal, repositoryId: 99, fetcher }),
    /not available/,
  );
  await assert.rejects(
    () =>
      openRepositoryPR({
        ...proposal,
        files: [{ path: "../bad", markdown: "" }],
        fetcher,
      }),
    /Unsafe/,
  );
  await assert.rejects(
    () =>
      openRepositoryPR({
        ...proposal,
        fetcher: () =>
          Promise.resolve(
            new Response("secret provider body", { status: 403 }),
          ),
      }),
    /permissions/,
  );
  assert.equal(writes, 0);
});

Deno.test("failed PR deletes only its created proposal branch and keeps original error", async () => {
  for (const refFails of [false, true]) {
    const calls: {
      path: string;
      method: string;
      body: Record<string, string>;
    }[] = [];
    await assert.rejects(
      () =>
        openRepositoryPR({
          ...proposal,
          fetcher: (url, init) => {
            const path = new URL(String(url)).pathname;
            calls.push({
              path,
              method: init!.method!,
              body: JSON.parse(String(init?.body ?? "{}")),
            });
            if (init?.method === "DELETE") throw new Error("cleanup failure");
            if (path.endsWith("/pulls")) {
              return Promise.resolve(new Response(null, { status: 422 }));
            }
            if (refFails && path.endsWith("/git/refs")) {
              return Promise.resolve(new Response(null, { status: 403 }));
            }
            return Promise.resolve(
              Response.json(
                path.endsWith("/ref/heads/main")
                  ? { object: { sha: "base" } }
                  : path.endsWith("/commits/base")
                  ? { tree: { sha: "tree" } }
                  : { sha: "next" },
              ),
            );
          },
        }),
      refFails ? /403/ : /422/,
    );
    const deleted = calls.filter((call) => call.method === "DELETE");
    assert.equal(deleted.length, refFails ? 0 : 1);
    if (!refFails) {
      const created = calls.find((call) =>
        call.path.endsWith("/git/refs")
      )!.body.ref;
      assert.equal(
        deleted[0].path,
        `/repos/org/repo/git/refs/heads/${created.replace("refs/heads/", "")}`,
      );
      assert(!deleted[0].path.endsWith("/main"));
    }
  }
});
