import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { createChangeProposalRoutes } from "./change-proposals.ts";
import type { GitHubAppClient } from "./github-app.ts";

const ORIGINAL =
  "---\ntype: Service\ntitle: Billing\n---\n\n# Billing\n\nOld.\n";
const app: GitHubAppClient = {
  slug: "test",
  installUrl: "",
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

function setup(github = true) {
  const db = new DatabaseSync(":memory:");
  db.exec(
    "CREATE TABLE okf_imported_concept (id TEXT, sourceId TEXT, path TEXT, title TEXT, status TEXT, objectKey TEXT, sourceRevision TEXT)",
  );
  db.prepare(
    "INSERT INTO okf_imported_concept VALUES ('repository/billing', 'repository', 'billing.md', 'Billing', 'current', 'key', 'rev1')",
  ).run();
  const state = { allowed: true, head: "rev1", prState: "open" };
  const events: string[] = [];
  const calls: {
    path: string;
    method: string;
    body: Record<string, unknown>;
  }[] = [];
  const fetcher = (url: string | URL | Request, init?: RequestInit) => {
    const path = new URL(String(url)).pathname;
    calls.push({
      path,
      method: init?.method ?? "GET",
      body: JSON.parse(String(init?.body ?? "{}")),
    });
    return Promise.resolve(Response.json(
      path.endsWith("/ref/heads/main")
        ? { object: { sha: state.head } }
        : path.endsWith("/commits/rev1")
        ? { tree: { sha: "tree" } }
        : path.endsWith("/pulls")
        ? { html_url: "https://github.com/org/repo/pull/7" }
        : path.endsWith("/pulls/7")
        ? {
          state: state.prState === "merged" ? "closed" : state.prState,
          merged_at: state.prState === "merged" ? "now" : null,
        }
        : { sha: "new" },
    ));
  };
  const routes = createChangeProposalRoutes({
    db,
    security: {
      session: () => Promise.resolve({ user: { id: "u1", name: "Ada @team" } }),
      check: () => Promise.resolve(true),
      checkSpace: () => Promise.resolve(state.allowed),
      ensureImportedSource: () => Promise.resolve(),
      audit: (_id: string, event: string) => events.push(event),
    } as unknown as Parameters<
      typeof createChangeProposalRoutes
    >[0]["security"],
    repositorySource: () => ({
      folder: "okf",
      githubInstallationId: github ? 1 : null,
      githubRepositoryId: github ? 1 : null,
      githubFullName: github ? "org/repo" : null,
    }),
    read: () => Promise.resolve(ORIGINAL),
    app,
    baseUrl: "https://hub.example",
    fetcher: fetcher as typeof fetch,
  });
  const post = (patch: Record<string, unknown> = {}) =>
    routes.handle(
      new Request("http://localhost/x", {
        method: "POST",
        body: JSON.stringify({
          path: "billing.md",
          baseRevision: "rev1",
          body: "# Billing\n\nNew.",
          rationale: "Pricing changed, ping @finance",
          ...patch,
        }),
      }),
      "repository",
    );
  return { routes, db, state, events, calls, post };
}

Deno.test("suggestions need source editors and a safe, current concept", async () => {
  const { state, calls, post } = setup();
  state.allowed = false;
  assert.equal((await post()).status, 403);
  state.allowed = true;
  for (
    const path of [
      "../billing.md",
      "a/../../billing.md",
      "/billing.md",
      "billing.txt",
    ]
  ) {
    assert.equal((await post({ path })).status, 400, path);
  }
  assert.equal((await post({ rationale: " " })).status, 400);
  assert.equal((await post({ body: "# Billing\n\nOld." })).status, 400);
  assert.equal((await post({ baseRevision: "old" })).status, 409);
  assert.equal(calls.length, 0);
  state.head = "rev2";
  const moved = await post();
  assert.equal(moved.status, 409);
  assert.match((await moved.json()).error, /Refresh the source/);
  assert(calls.every((call) => call.method === "GET"));
});

Deno.test("GitHub suggestion opens a draft PR, keeps frontmatter, tracks status", async () => {
  const { routes, state, events, calls, post } = setup();
  const response = await post();
  assert.equal(response.status, 200);
  assert.equal(
    (await response.json()).url,
    "https://github.com/org/repo/pull/7",
  );
  assert.deepEqual(events, ["source.change-proposed"]);
  const tree = calls.find((call) => call.path.endsWith("/git/trees"))!
    .body as { tree: { path: string; content: string }[] };
  assert.deepEqual(
    tree.tree.map((
      file: { path: string; content: string },
    ) => [file.path, file.content]),
    [[
      "okf/billing.md",
      "---\ntype: Service\ntitle: Billing\n---\n\n# Billing\n\nNew.\n",
    ]],
  );
  const pull = calls.find((call) => call.path.endsWith("/pulls"))!
    .body as { draft: boolean; body: string };
  assert.equal(pull.draft, true);
  assert.match(pull.body, /Pricing changed, ping @​finance/);
  assert.match(pull.body, /\*\*Ada @​team\*\*/);
  assert.match(
    pull.body,
    /https:\/\/hub\.example\/imports\/repository\/billing\.md/,
  );
  assert.match(pull.body, /`rev1`/);
  const status = () =>
    routes.handle(
      new Request("http://localhost/x?path=billing.md"),
      "repository",
    ).then((item) => item.json());
  assert.equal((await status()).openCount, 1);
  state.prState = "merged";
  await routes.refresh("repository");
  const after = await status();
  assert.equal(after.openCount, 0);
  assert.equal(after.proposals[0].status, "merged");
});

Deno.test("manual Git sources get a git-apply compatible patch", async () => {
  const { post, events, calls } = setup(false);
  const response = await post();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-disposition")!, /\.patch/);
  const patch = await response.text();
  assert.match(patch, /^From rev1 /);
  assert.match(patch, /Subject: \[PATCH\] Suggest change: Billing/);
  assert.match(patch, /diff --git a\/okf\/billing\.md b\/okf\/billing\.md/);
  assert.match(patch, /^-Old\.$/m);
  assert.match(patch, /^\+New\.$/m);
  assert.equal(calls.length, 0);
  assert.deepEqual(events, ["source.change-patch-exported"]);
  const dir = await Deno.makeTempDir();
  try {
    await Deno.mkdir(`${dir}/okf`);
    await Deno.writeTextFile(`${dir}/okf/billing.md`, ORIGINAL);
    await Deno.writeTextFile(`${dir}/x.patch`, patch);
    const apply = await new Deno.Command("git", {
      args: ["apply", "--check", "x.patch"],
      cwd: dir,
      stdout: "null",
      stderr: "piped",
    }).output();
    assert(apply.success, new TextDecoder().decode(apply.stderr));
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("patches build with write access limited to the data directory", async () => {
  const data = await Deno.makeTempDir();
  try {
    const module = new URL("./change-proposals.ts", import.meta.url).href;
    const script = `import { buildPatch } from ${JSON.stringify(module)};
      const patch = await buildPatch({ revision: "r1", path: "a.md", before: "Old\\n", after: "New\\n", name: "Ada", subject: "S", rationale: "R", tempDir: ${
      JSON.stringify(data)
    } });
      console.log(patch.includes("+New"));`;
    await Deno.writeTextFile(`${data}/run.ts`, script);
    const result = await new Deno.Command("deno", {
      args: [
        "run",
        `--allow-write=${data}`,
        "--allow-run=git",
        "--allow-read",
        "--allow-env",
        `${data}/run.ts`,
      ],
      stdout: "piped",
      stderr: "piped",
    }).output();
    assert(result.success, new TextDecoder().decode(result.stderr));
    assert.equal(new TextDecoder().decode(result.stdout).trim(), "true");
  } finally {
    await Deno.remove(data, { recursive: true });
  }
});

Deno.test("catalog suggestion adapter shares validation, permission checks and patch fallback", async () => {
  const { routes, db, state } = setup(false);
  const context = { userId: "u1", userName: "Ada" };
  const input = {
    sourceId: "repository",
    path: "billing.md",
    baseRevision: "rev1",
    body: "# Billing\n\nNew.",
    rationale: "Update",
  };
  try {
    const result = await routes.suggest(context, input);
    assert.match(result.patch, /diff --git/);
    await assert.rejects(
      () => routes.suggest(context, { ...input, baseRevision: "old" }),
      /source changed/,
    );
    await assert.rejects(
      () => routes.suggest(context, { ...input, rationale: "" }),
      /rationale/,
    );
    state.allowed = false;
    await assert.rejects(() => routes.suggest(context, input), /editor access/);
  } finally {
    db.close();
  }
});
