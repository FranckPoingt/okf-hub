/// <reference lib="deno.ns" />

import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { createCollabApp, DEFAULT_MARKDOWN } from "./main.ts";
import type { RepositoryCredentials } from "./repository-source.ts";

type Tuple = { user: string; relation: string; object: string };

function fakeOpenFga() {
  const tuples: Tuple[] = [];
  let receivedModel = false;
  const fetch = async (request: Request) => {
    const url = new URL(request.url);
    const body = request.body ? await request.json() : {};
    if (url.pathname === "/stores") return Response.json({ id: "store" });
    if (url.pathname.endsWith("/authorization-models")) {
      receivedModel = Array.isArray(body.type_definitions);
      return Response.json({ authorization_model_id: "model" });
    }
    if (url.pathname.endsWith("/write")) {
      for (const deleted of body.deletes?.tuple_keys ?? []) {
        const index = tuples.findIndex((tuple) =>
          tuple.user === deleted.user && tuple.relation === deleted.relation &&
          tuple.object === deleted.object
        );
        if (index >= 0) tuples.splice(index, 1);
      }
      tuples.push(...(body.writes?.tuple_keys ?? []));
      return new Response(null, { status: 204 });
    }
    if (url.pathname.endsWith("/check")) {
      const { user, relation, object } = body.tuple_key;
      const has = (candidate: Partial<Tuple>) =>
        tuples.some((tuple) =>
          Object.entries(candidate).every(([key, value]) =>
            tuple[key as keyof Tuple] === value
          )
        );
      const memberOf = (groupUser: string) =>
        has({
          user,
          relation: "member",
          object: groupUser.replace(/#member$/, ""),
        });
      const owner = has({ user, relation: "owner", object: "source:company" });
      const editor = tuples.some((tuple) =>
        tuple.relation === "editor" && tuple.object === "source:company" &&
        memberOf(tuple.user)
      );
      const viewedSpace = object.startsWith("space:")
        ? object
        : tuples.find((tuple) =>
          tuple.relation === "parent" && tuple.object === object &&
          tuple.user.startsWith("space:")
        )?.user;
      const viewer = Boolean(viewedSpace) &&
        tuples.some((tuple) =>
          tuple.relation === "viewer" && tuple.object === viewedSpace &&
          memberOf(tuple.user)
        );
      return Response.json({
        allowed: owner || editor || (relation === "view" && viewer),
      });
    }
    return new Response("Not found", { status: 404 });
  };
  const server = Deno.serve(
    { hostname: "127.0.0.1", port: 0, onListen() {} },
    fetch,
  );
  return { server, tuples, modelReceived: () => receivedModel };
}

class Client {
  cookie = "";
  constructor(readonly base: string) {}

  async request(path: string, init: RequestInit = {}) {
    const headers = new Headers(init.headers);
    if (this.cookie) headers.set("cookie", this.cookie);
    if (init.body) headers.set("content-type", "application/json");
    const response = await fetch(`${this.base}${path}`, { ...init, headers });
    const cookie = response.headers.get("set-cookie")?.match(
      /better-auth\.session_token=[^;]+/,
    )?.[0];
    if (cookie) this.cookie = cookie;
    return response;
  }

  async signUp(name: string, email: string) {
    const response = await this.request("/api/auth/sign-up/email", {
      method: "POST",
      body: JSON.stringify({ name, email, password: "password123" }),
    });
    assert.equal(response.status, 200, await response.text());
  }
}

Deno.test("migrates repository imports to source-scoped paths", async () => {
  const dataDir = await Deno.makeTempDir();
  const legacy = new DatabaseSync(`${dataDir}/hub.db`);
  legacy.exec(`
    CREATE TABLE okf_imported_concept (
      id TEXT PRIMARY KEY,
      path TEXT NOT NULL UNIQUE,
      title TEXT NOT NULL,
      type TEXT NOT NULL,
      status TEXT NOT NULL,
      objectKey TEXT NOT NULL,
      sourceRevision TEXT NOT NULL,
      contentHash TEXT NOT NULL,
      importedAt TEXT NOT NULL,
      nextPath TEXT
    );
    CREATE TABLE okf_import_issue (path TEXT PRIMARY KEY, error TEXT NOT NULL);
    INSERT INTO okf_imported_concept VALUES
      ('repository/guide', 'guide.md', 'Guide', 'Guide', 'current', 'old.md', 'commit', 'hash', '2026-01-01', NULL);
    INSERT INTO okf_import_issue VALUES ('bad.md', 'Invalid');
  `);
  legacy.close();
  const app = await createCollabApp({ dataDir });
  try {
    const migrated = new DatabaseSync(`${dataDir}/hub.db`);
    assert.deepEqual(
      migrated.prepare("SELECT sourceId, path FROM okf_imported_concept").all()
        .map((row) => ({ ...row })),
      [{ sourceId: "repository", path: "guide.md" }],
    );
    assert.equal(
      (migrated.prepare(
        "SELECT searchText FROM okf_imported_concept",
      ).get() as { searchText: string }).searchText,
      "guide guide",
    );
    assert.deepEqual(
      migrated.prepare("SELECT sourceId, path FROM okf_import_issue").all()
        .map((row) => ({ ...row })),
      [{ sourceId: "repository", path: "bad.md" }],
    );
    migrated.close();
  } finally {
    await app.close();
    await Deno.remove(dataDir, { recursive: true });
  }
});

Deno.test("migrates fixed source constraints for multiple repositories", async () => {
  const dataDir = await Deno.makeTempDir();
  const legacy = new DatabaseSync(`${dataDir}/hub.db`);
  legacy.exec(`
    CREATE TABLE okf_space (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      createdAt TEXT NOT NULL
    );
    INSERT INTO okf_space VALUES ('policies', 'Policies', '2026-01-01');
    CREATE TABLE okf_concept (
      id TEXT PRIMARY KEY,
      spaceId TEXT NOT NULL,
      title TEXT NOT NULL,
      type TEXT NOT NULL,
      status TEXT NOT NULL,
      publishedRevision INTEGER,
      createdAt TEXT NOT NULL,
      updatedAt TEXT NOT NULL
    );
    INSERT INTO okf_concept VALUES
      ('legacy-policy', 'policies', 'Legacy policy', 'Policy', 'active', NULL, '2026-01-01', '2026-01-01');
    CREATE TABLE okf_repository_source (
      id TEXT PRIMARY KEY CHECK (id = 'repository'),
      repositoryUrl TEXT NOT NULL,
      folder TEXT NOT NULL,
      credentialsCipher TEXT,
      status TEXT NOT NULL,
      revision TEXT,
      lastSyncedAt TEXT,
      error TEXT
    );
    INSERT INTO okf_repository_source VALUES
      ('repository', 'https://example.com/legacy.git', 'okf', NULL, 'current', 'commit', '2026-01-01', NULL);
    CREATE TABLE okf_imported_concept (
      id TEXT PRIMARY KEY,
      sourceId TEXT NOT NULL CHECK (sourceId IN ('repository', 'shared')),
      path TEXT NOT NULL,
      title TEXT NOT NULL,
      type TEXT NOT NULL,
      status TEXT NOT NULL,
      objectKey TEXT NOT NULL,
      sourceRevision TEXT NOT NULL,
      contentHash TEXT NOT NULL,
      importedAt TEXT NOT NULL,
      nextPath TEXT,
      tags TEXT NOT NULL DEFAULT '[]',
      owner TEXT NOT NULL DEFAULT '',
      links TEXT NOT NULL DEFAULT '[]',
      searchText TEXT NOT NULL DEFAULT '',
      UNIQUE (sourceId, path)
    );
    CREATE TABLE okf_import_issue (
      sourceId TEXT NOT NULL CHECK (sourceId IN ('repository', 'shared')),
      path TEXT NOT NULL,
      error TEXT NOT NULL,
      PRIMARY KEY (sourceId, path)
    );
  `);
  legacy.close();
  const app = await createCollabApp({ dataDir });
  try {
    const migrated = new DatabaseSync(`${dataDir}/hub.db`);
    const schemas = migrated.prepare(
      "SELECT sql FROM sqlite_master WHERE name IN ('okf_repository_source', 'okf_imported_concept', 'okf_import_issue')",
    ).all().map((row) => String((row as { sql: string }).sql)).join("\n");
    assert.equal(schemas.includes("id = 'repository'"), false);
    assert.equal(schemas.includes("sourceId IN"), false);
    assert.equal(
      (migrated.prepare(
        "SELECT intent FROM okf_concept WHERE id = 'legacy-policy'",
      ).get() as { intent: string }).intent,
      "canonical",
    );
    migrated.prepare(
      "INSERT INTO okf_repository_source (id, repositoryUrl, folder, status) VALUES ('repository-second', 'https://example.com/second.git', 'okf', 'syncing')",
    ).run();
    migrated.prepare(
      "INSERT INTO okf_import_issue VALUES ('repository-second', 'bad.md', 'Invalid')",
    ).run();
    assert.equal(
      (migrated.prepare("SELECT COUNT(*) AS count FROM okf_repository_source")
        .get() as { count: number }).count,
      2,
    );
    migrated.close();
  } finally {
    await app.close();
    await Deno.remove(dataDir, { recursive: true });
  }
});

Deno.test("keeps the legacy hub document in the Policies space", async () => {
  const dataDir = await Deno.makeTempDir();
  const path = `${dataDir}/incident-communication.md`;
  await Deno.writeTextFile(path, "# Existing policy\n");
  const app = await createCollabApp({ dataDir });
  try {
    const db = new DatabaseSync(`${dataDir}/hub.db`);
    assert.deepEqual({
      ...db.prepare(
        "SELECT id, spaceId FROM okf_concept WHERE id = 'incident-communication'",
      ).get(),
    }, { id: "incident-communication", spaceId: "policies" });
    db.close();
    assert.equal(await Deno.readTextFile(path), "# Existing policy\n");
  } finally {
    await app.close();
    await Deno.remove(dataDir, { recursive: true });
  }
});

Deno.test("runs scheduled checks and records their history", async () => {
  const dataDir = await Deno.makeTempDir();
  const app = await createCollabApp({ dataDir, automationIntervalMs: 10 });
  try {
    const db = new DatabaseSync(`${dataDir}/hub.db`);
    db.exec("PRAGMA foreign_keys=OFF");
    db.prepare(
      "INSERT INTO member (id, organizationId, userId, role, createdAt) VALUES (?, ?, ?, 'owner', ?)",
    ).run("member", "organization", "owner", new Date().toISOString());
    db.close();
    await new Promise((resolve) => setTimeout(resolve, 35));
    await app.close();
    const history = new DatabaseSync(`${dataDir}/hub.db`);
    const run = history.prepare(
      "SELECT trigger, status FROM okf_automation_run ORDER BY id LIMIT 1",
    ).get() as { trigger: string; status: string };
    assert.deepEqual({ ...run }, {
      trigger: "scheduled",
      status: "succeeded",
    });
    assert.equal(
      (history.prepare(
        "SELECT job FROM okf_automation_attempt WHERE runId = 1",
      ).get() as { job: string }).job,
      "broken_links",
    );
    history.close();
  } finally {
    await app.close().catch(() => {});
    await Deno.remove(dataDir, { recursive: true });
  }
});

Deno.test("enforces access and preserves the published lifecycle", async () => {
  const dataDir = await Deno.makeTempDir();
  const staticDir = `${dataDir}/dist`;
  await Deno.mkdir(staticDir);
  await Deno.writeTextFile(
    `${staticDir}/index.html`,
    "<!doctype html><title>OKF Hub</title>",
  );
  const fga = fakeOpenFga();
  const fgaPort = (fga.server.addr as Deno.NetAddr).port;
  const objects = new Map<string, string>();
  let repositorySyncs = 0;
  let repositoryCredentials: RepositoryCredentials | undefined;
  let sharedSyncs = 0;
  let sharedConfig: Record<string, string> | undefined;
  const imported = (
    path: string,
    title: string,
    content: string,
    hash: string,
    options: { tags?: string[]; owner?: string; links?: string[] } = {},
  ) => ({
    path,
    title,
    type: "Runbook",
    markdown: `---\n${
      path === "operations.md" ? '"type"' : "type"
    }: Runbook\ntitle: ${title}\n---\n\n${content}`,
    body: content,
    tags: options.tags ?? [],
    owner: options.owner ?? "Platform",
    links: options.links ?? [],
    searchText: [
      title,
      "Runbook",
      options.owner ?? "Platform",
      (options.tags ?? []).join(" "),
      content,
    ].join("\n"),
    hash,
  });
  const app = await createCollabApp({
    dataDir,
    staticDir,
    authSecret: "a-secure-test-secret-with-at-least-32-characters",
    openfgaURL: `http://127.0.0.1:${fgaPort}`,
    objectStore: {
      put(key, markdown) {
        objects.set(key, markdown);
        return Promise.resolve();
      },
      get(key) {
        const markdown = objects.get(key);
        return markdown === undefined
          ? Promise.reject(new Error("Object not found"))
          : Promise.resolve(markdown);
      },
      remove(key) {
        objects.delete(key);
        return Promise.resolve();
      },
    },
    automationIntervalMs: 0,
    allowedArtifactHosts: ["apps.example.com"],
    repositorySync(_checkout, repositoryUrl, _folder, credentials) {
      if (repositoryUrl.includes("engineering")) {
        return Promise.resolve({
          revision: "engineering-one",
          files: [
            imported(
              "operations.md",
              "Engineering operations",
              "# Engineering operations\n",
              "engineering-ops",
            ),
          ],
          issues: [],
        });
      }
      repositorySyncs++;
      repositoryCredentials = credentials;
      if (repositorySyncs >= 3 && credentials?.token !== "replacement-token") {
        return Promise.reject(new Error("Repository unavailable"));
      }
      return Promise.resolve(
        repositorySyncs === 1
          ? {
            revision: "commit-one",
            files: [
              imported(
                "operations.md",
                "Operations",
                "# Operations v1\n",
                "ops-1",
              ),
              imported("move-me.md", "Move me", "# Move me\n", "same"),
              imported("delete-me.md", "Delete me", "# Delete me\n", "gone"),
            ],
            issues: [{ path: "broken.md", error: "Missing YAML frontmatter" }],
          }
          : {
            revision: "commit-two",
            files: [
              imported(
                "operations.md",
                "Operations",
                "# Operations v2\n",
                "ops-2",
              ),
              imported("guides/moved.md", "Moved", "# Move me\n", "same"),
            ],
            issues: [{
              path: "invalid.md",
              error: "Frontmatter requires a non-empty type",
            }],
          },
      );
    },
    sharedSourceSync(config) {
      sharedSyncs++;
      sharedConfig = config;
      if (sharedSyncs === 2 || sharedSyncs === 3) {
        return Promise.reject(new Error("Shared store unavailable"));
      }
      return Promise.resolve({
        revision: "objects-one",
        files: [
          imported(
            "operations.md",
            "Shared operations",
            "# Shared operations\n",
            "shared-ops",
            { tags: ["shared", "operations"], owner: "Operations" },
          ),
          imported(
            "handbook.md",
            "Company handbook",
            "# Handbook\n\nSee [Shared operations](operations.md) and [Missing guide](missing.md).\n",
            "handbook",
            {
              tags: ["shared", "handbook"],
              owner: "People team",
              links: ["operations.md", "missing.md"],
            },
          ),
        ],
        issues: [{ path: "bad.md", error: "Missing YAML frontmatter" }],
      });
    },
  });
  const server = Deno.serve(
    { hostname: "127.0.0.1", port: 0, onListen() {} },
    app.fetch,
  );
  const base = `http://127.0.0.1:${(server.addr as Deno.NetAddr).port}`;
  const owner = new Client(base);
  const editor = new Client(base);
  const viewer = new Client(base);
  const outsider = new Client(base);

  try {
    assert.equal(
      (await fetch(`${base}/api/concepts/incident-communication`)).status,
      401,
    );
    assert.equal((await fetch(`${base}/api/search`)).status, 401);
    await owner.signUp("Owner", "owner@example.com");
    assert.equal(
      (await (await owner.request("/api/bootstrap")).json()).setupRequired,
      true,
    );
    assert.equal(
      (await owner.request("/api/setup", { method: "POST" })).status,
      200,
    );
    assert.equal(
      (await owner.request("/api/concepts/incident-communication")).status,
      404,
    );
    const created = await owner.request("/api/concepts", { method: "POST" });
    assert.equal(created.status, 201);
    assert.equal(
      (await created.json()).draft,
      DEFAULT_MARKDOWN,
    );

    const invite = async (email: string, access: "editor" | "viewer") => {
      const response = await owner.request("/api/invitations", {
        method: "POST",
        body: JSON.stringify({ email, access }),
      });
      if (!response.ok) assert.fail(await response.text());
      return (await response.json()).id as string;
    };
    const editorInvitation = await invite("editor@example.com", "editor");
    const viewerInvitation = await invite("viewer@example.com", "viewer");
    await editor.signUp("Editor", "editor@example.com");
    await viewer.signUp("Viewer", "viewer@example.com");
    await outsider.signUp("Outsider", "outsider@example.com");
    assert.equal(
      (await editor.request("/api/invitations/accept", {
        method: "POST",
        body: JSON.stringify({ invitationId: editorInvitation }),
      })).status,
      200,
    );
    assert.equal(
      (await viewer.request("/api/invitations/accept", {
        method: "POST",
        body: JSON.stringify({ invitationId: viewerInvitation }),
      })).status,
      200,
    );

    assert.equal(
      (await editor.request("/api/concepts/incident-communication")).status,
      200,
    );
    assert.deepEqual(await (await viewer.request("/api/concepts")).json(), []);
    assert.equal(
      (await viewer.request("/api/concepts/incident-communication")).status,
      404,
    );
    assert.equal(
      (await editor.request("/api/concepts/incident-communication", {
        method: "PUT",
        body: "# First published draft\n",
      })).status,
      204,
    );
    const firstPublish = await editor.request(
      "/api/concepts/incident-communication/publish",
      {
        method: "POST",
        body: JSON.stringify({ markdown: "# First published draft\n" }),
      },
    );
    assert.equal(firstPublish.status, 200, await firstPublish.text());
    assert.match(
      objects.get("policies/incident-communication/revisions/1.md") ?? "",
      /^---\ntype: Policy\ntitle: "Incident communication"\nstatus: stable\ngenerated: \{ by: "human:[^"]+", at: "[^"]+" \}\n---\n\n# First published draft\n$/,
    );
    assert.equal(
      (await viewer.request("/api/concepts/incident-communication")).status,
      200,
    );
    assert.equal(
      (await (await viewer.request("/api/concepts/incident-communication"))
        .json()).published,
      "# First published draft\n",
    );
    assert.equal(
      (await editor.request("/api/concepts/incident-communication", {
        method: "PUT",
        body: "# Private next draft\n",
      })).status,
      204,
    );
    assert.equal(
      (await (await viewer.request("/api/concepts/incident-communication"))
        .json()).published,
      "# First published draft\n",
    );
    const secondPublish = await editor.request(
      "/api/concepts/incident-communication/publish",
      {
        method: "POST",
        body: JSON.stringify({ markdown: "# Second published revision\n" }),
      },
    );
    const second = await secondPublish.json();
    assert.equal(second.revisions.length, 2);
    assert.equal(second.publishedRevision, 2);
    const restoredDraft = await editor.request(
      "/api/concepts/incident-communication/revisions/1/restore",
      { method: "POST" },
    );
    assert.equal(
      (await restoredDraft.json()).draft,
      "# First published draft\n",
    );
    assert.equal(
      (await viewer.request("/api/concepts/incident-communication", {
        method: "PUT",
        body: "# Forbidden\n",
      })).status,
      403,
    );
    assert.deepEqual(
      await (await viewer.request(
        "/api/artifacts?conceptId=incident-communication",
      )).json(),
      {
        artifacts: [],
        allowedHosts: [],
        canEdit: false,
        canPublish: false,
      },
    );
    assert.equal(
      (await outsider.request(
        "/api/artifacts?conceptId=incident-communication",
      )).status,
      404,
    );
    assert.equal(
      (await viewer.request("/api/artifacts", {
        method: "POST",
        body: JSON.stringify({
          conceptId: "incident-communication",
          title: "Calculator",
          type: "inline_html",
          content: "<p>Forbidden</p>",
        }),
      })).status,
      403,
    );
    const createdArtifact = await editor.request("/api/artifacts", {
      method: "POST",
      body: JSON.stringify({
        conceptId: "incident-communication",
        title: "Incident calculator",
        type: "inline_html",
        content:
          "<button onclick=\"document.body.dataset.used='yes'\">Calculate</button><script>document.body.dataset.ready='yes'</script>",
      }),
    });
    assert.equal(createdArtifact.status, 201, await createdArtifact.text());
    const artifact = await (await editor.request(
      "/api/artifacts?conceptId=incident-communication",
    )).json();
    assert.equal(artifact.artifacts[0].status, "draft");
    assert.match(artifact.artifacts[0].document, /connect-src 'none'/);
    assert.deepEqual(
      (await (await viewer.request(
        "/api/artifacts?conceptId=incident-communication",
      )).json()).artifacts,
      [],
    );
    const artifactId = artifact.artifacts[0].id as string;
    assert.equal(
      (await editor.request(`/api/artifacts/${artifactId}/publish`, {
        method: "POST",
      })).status,
      403,
    );
    assert.equal(
      (await owner.request(`/api/artifacts/${artifactId}/publish`, {
        method: "POST",
      })).status,
      200,
    );
    const viewerArtifactV1 = (await (await viewer.request(
      "/api/artifacts?conceptId=incident-communication",
    )).json()).artifacts[0];
    assert.equal(viewerArtifactV1.version, 1);
    assert.equal(viewerArtifactV1.content, undefined);
    assert.match(viewerArtifactV1.document, /Calculate/);
    const revisedArtifact = await editor.request(
      `/api/artifacts/${artifactId}`,
      {
        method: "PUT",
        body: JSON.stringify({ content: "<p>Version two</p>" }),
      },
    );
    assert.equal((await revisedArtifact.json()).status, "changes_pending");
    assert.doesNotMatch(
      (await (await viewer.request(
        "/api/artifacts?conceptId=incident-communication",
      )).json()).artifacts[0].document,
      /Version two/,
    );
    assert.equal(
      (await owner.request(`/api/artifacts/${artifactId}/publish`, {
        method: "POST",
      })).status,
      200,
    );
    assert.equal(
      (await editor.request("/api/artifacts", {
        method: "POST",
        body: JSON.stringify({
          conceptId: "incident-communication",
          title: "Blocked dashboard",
          type: "https_url",
          content: "https://blocked.example.com/dashboard",
        }),
      })).status,
      400,
    );
    const urlArtifact = await editor.request("/api/artifacts", {
      method: "POST",
      body: JSON.stringify({
        conceptId: "incident-communication",
        title: "Status dashboard",
        type: "https_url",
        content: "https://apps.example.com/status",
      }),
    });
    const urlArtifactBody = await urlArtifact.json();
    assert.equal(urlArtifact.status, 201);
    assert.equal(urlArtifactBody.url, "https://apps.example.com/status");
    assert.equal(
      (await owner.request(`/api/artifacts/${urlArtifactBody.id}/publish`, {
        method: "POST",
      })).status,
      200,
    );
    assert.equal(
      (await outsider.request("/api/concepts/incident-communication")).status,
      404,
    );
    const archived = await editor.request(
      "/api/concepts/incident-communication/archive",
      { method: "POST" },
    );
    assert.equal((await archived.json()).revisions.length, 2);
    assert.deepEqual(await (await editor.request("/api/concepts")).json(), []);
    assert.equal(
      (await (await editor.request("/api/concepts?include=archived")).json())
        .length,
      1,
    );
    assert.deepEqual(await (await viewer.request("/api/concepts")).json(), []);
    assert.equal(
      (await viewer.request("/api/concepts/incident-communication")).status,
      404,
    );
    assert.equal(
      (await editor.request("/api/concepts/incident-communication/restore", {
        method: "POST",
      })).status,
      200,
    );
    assert.equal(
      (await (await viewer.request("/api/concepts/incident-communication"))
        .json()).published,
      "# Second published revision\n",
    );

    assert.equal(
      (await owner.request("/api/sources/repositories", {
        method: "POST",
        body: JSON.stringify({
          repositoryUrl: "https://example.com/company/knowledge.git",
          folder: "okf",
          username: "git-user",
        }),
      })).status,
      400,
    );
    const connected = await owner.request("/api/sources/repositories", {
      method: "POST",
      body: JSON.stringify({
        repositoryUrl: "https://example.com/company/knowledge.git",
        folder: "okf",
        username: "git-user",
        token: "private-git-token",
      }),
    });
    if (!connected.ok) assert.fail(await connected.text());
    const firstSource = await connected.json();
    assert.equal(firstSource.status, "current");
    assert.equal(firstSource.revision, "commit-one");
    assert.equal(firstSource.conceptCount, 3);
    assert.equal(firstSource.credentialsConfigured, true);
    assert.equal(
      JSON.stringify(firstSource).includes("private-git-token"),
      false,
    );
    assert.equal(JSON.stringify(firstSource).includes("git-user"), false);
    assert.deepEqual(repositoryCredentials, {
      username: "git-user",
      token: "private-git-token",
    });
    const repositoryDb = new DatabaseSync(`${dataDir}/hub.db`);
    const repositoryStored = repositoryDb.prepare(
      "SELECT credentialsCipher FROM okf_repository_source WHERE id = 'repository'",
    ).get() as { credentialsCipher: string };
    assert.match(repositoryStored.credentialsCipher, /^v1:/);
    assert.equal(
      repositoryStored.credentialsCipher.includes("private-git-token"),
      false,
    );
    repositoryDb.close();
    assert.deepEqual(firstSource.issues, [{
      path: "broken.md",
      status: "invalid",
      error: "Missing YAML frontmatter",
      nextPath: null,
    }]);
    assert.equal(
      (await editor.request("/api/sources/repositories/repository/refresh", {
        method: "POST",
      })).status,
      403,
    );
    assert.equal(
      (await (await viewer.request("/api/imports")).json()).length,
      3,
    );
    assert.deepEqual(await (await outsider.request("/api/imports")).json(), []);
    const firstImported = await viewer.request(
      "/api/imported?path=operations.md",
    );
    assert.equal(firstImported.status, 200);
    assert.deepEqual(
      Object.assign({}, await firstImported.json(), {
        source: undefined,
        importedAt: undefined,
      }),
      {
        id: "repository/operations",
        sourceId: "repository",
        path: "operations.md",
        title: "Operations",
        type: "Runbook",
        tags: [],
        owner: "Platform",
        status: "current",
        sourceRevision: "commit-one",
        importedAt: undefined,
        kind: "imported",
        markdown: "# Operations v1\n",
        revisionCount: 1,
        source: undefined,
      },
    );
    assert.equal(
      (await outsider.request("/api/imported?path=operations.md")).status,
      404,
    );

    const refreshed = await owner.request(
      "/api/sources/repositories/repository/refresh",
      { method: "POST" },
    );
    if (!refreshed.ok) assert.fail(await refreshed.text());
    const secondSource = await refreshed.json();
    assert.equal(secondSource.revision, "commit-two");
    assert.equal(secondSource.conceptCount, 2);
    assert.deepEqual(
      secondSource.issues.map((
        issue: { path: string; status: string; nextPath: string | null },
      ) => [issue.path, issue.status, issue.nextPath]),
      [
        ["delete-me.md", "deleted", null],
        ["invalid.md", "invalid", null],
        ["move-me.md", "renamed", "guides/moved.md"],
      ],
    );
    const updatedImported = await (await viewer.request(
      "/api/imported?path=operations.md",
    )).json();
    assert.equal(updatedImported.markdown, "# Operations v2\n");
    assert.equal(updatedImported.revisionCount, 2);

    const unavailable = await owner.request(
      "/api/sources/repositories/repository/refresh",
      { method: "POST" },
    );
    assert.equal(unavailable.status, 502);
    const failedSource = await unavailable.json();
    assert.equal(failedSource.status, "sync_failed");
    assert.equal(failedSource.error, "Repository unavailable");
    assert.equal(
      (await (await viewer.request("/api/imports")).json()).length,
      2,
    );

    const sharedConnected = await owner.request("/api/sources/shared", {
      method: "POST",
      body: JSON.stringify({
        endpoint: "https://objects.example.com",
        bucket: "shared-okf",
        path: "company/okf",
        region: "ap-southeast-2",
        accessKey: "browser-access-key",
        secretKey: "browser-secret-key",
      }),
    });
    const sharedText = await sharedConnected.text();
    assert.equal(sharedConnected.status, 201, sharedText);
    const sharedBody = JSON.parse(sharedText);
    assert.equal(sharedBody.status, "current");
    assert.equal(sharedBody.revision, "objects-one");
    assert.equal(sharedBody.conceptCount, 2);
    assert.ok(sharedBody.lastSyncedAt);
    assert.equal(sharedBody.credentialsConfigured, true);
    assert.equal(
      JSON.stringify(sharedBody).includes("browser-secret-key"),
      false,
    );
    assert.equal(
      JSON.stringify(sharedBody).includes("browser-access-key"),
      false,
    );
    assert.deepEqual(sharedConfig, {
      endpoint: "https://objects.example.com/",
      bucket: "shared-okf",
      path: "company/okf",
      region: "ap-southeast-2",
      accessKey: "browser-access-key",
      secretKey: "browser-secret-key",
    });
    const savedDb = new DatabaseSync(`${dataDir}/hub.db`);
    const stored = savedDb.prepare(
      "SELECT credentialsCipher FROM okf_shared_source WHERE id = 'shared'",
    ).get() as { credentialsCipher: string };
    assert.match(stored.credentialsCipher, /^v1:/);
    assert.equal(
      stored.credentialsCipher.includes("browser-secret-key"),
      false,
    );
    savedDb.close();
    assert.equal(
      ((await Deno.stat(`${dataDir}/source-credentials.key`)).mode ?? 0) &
        0o777,
      0o600,
    );
    assert.equal(
      (await editor.request("/api/sources/shared/refresh", {
        method: "POST",
      })).status,
      403,
    );
    const allSourcesText = await (await owner.request("/api/sources")).text();
    assert.equal(allSourcesText.includes("browser-secret-key"), false);
    assert.equal(allSourcesText.includes("browser-access-key"), false);
    assert.equal(allSourcesText.includes("private-git-token"), false);
    assert.equal(allSourcesText.includes("git-user"), false);
    const sharedImported = await viewer.request(
      "/api/imported?source=shared&path=operations.md",
    );
    assert.equal(sharedImported.status, 200);
    const sharedImportedBody = await sharedImported.json();
    assert.equal(sharedImportedBody.id, "shared/operations");
    assert.equal(sharedImportedBody.sourceId, "shared");
    assert.equal(sharedImportedBody.markdown, "# Shared operations\n");
    assert.equal(
      (await (await viewer.request("/api/imported?path=operations.md")).json())
        .markdown,
      "# Operations v2\n",
    );
    assert.equal(
      (await (await viewer.request("/api/imports")).json()).length,
      4,
    );
    const search = async (client: Client, query = "") => {
      const response = await client.request(`/api/search?${query}`);
      const text = await response.text();
      assert.equal(response.status, 200, text);
      return JSON.parse(text);
    };
    const sharedSearch = await search(viewer, "q=shared%20operations");
    assert.equal(sharedSearch.results.length, 2);
    assert.equal(sharedSearch.results[0].id, "shared/operations");
    assert.equal(sharedSearch.results[0].kind, "imported");
    assert.equal(sharedSearch.results[0].sourceId, "shared");
    assert.equal(sharedSearch.results[0].owner, "Operations");
    assert.equal(sharedSearch.results[0].trust, "current");
    assert.deepEqual(
      sharedSearch.results[0].backlinks.map((item: { id: string }) => item.id),
      ["shared/handbook"],
    );
    assert.equal(sharedSearch.results[0].backlinks[0].trust, "current");
    const filteredSearch = await search(
      viewer,
      "type=Runbook&tag=shared",
    );
    assert.deepEqual(
      filteredSearch.results.map((item: { id: string }) => item.id),
      ["shared/handbook", "shared/operations"],
    );
    assert.deepEqual(filteredSearch.facets.tags, [
      "handbook",
      "operations",
      "shared",
    ]);
    const hubSearch = await search(viewer, "q=second%20published");
    assert.equal(hubSearch.results[0].kind, "hub-native");
    assert.equal(hubSearch.results[0].sourceLabel, "OKF Hub");
    const repositorySearch = await search(viewer, "q=operations&type=Runbook");
    assert.equal(
      repositorySearch.results.find((item: { sourceId: string }) =>
        item.sourceId === "repository"
      ).trust,
      "sync_failed",
    );
    assert.deepEqual(await search(outsider), {
      query: "",
      results: [],
      facets: { types: [], tags: [] },
      canIncludeArchived: false,
    });
    const sharedUnavailable = await owner.request(
      "/api/sources/shared/refresh",
      { method: "POST" },
    );
    assert.equal(sharedUnavailable.status, 502);
    assert.equal(
      (await sharedUnavailable.json()).error,
      "Shared store unavailable",
    );
    assert.equal(
      (await (await viewer.request("/api/imports")).json()).length,
      4,
    );
    assert.equal(
      (await search(viewer, "q=shared%20operations")).results[0].trust,
      "sync_failed",
    );
    assert.equal(
      (await editor.request("/api/automation/run", { method: "POST" })).status,
      403,
    );
    const publishedBeforeAutomation = (await (await viewer.request(
      "/api/concepts/incident-communication",
    )).json()).published;
    const automationResponse = await owner.request("/api/automation/run", {
      method: "POST",
    });
    assert.equal(
      automationResponse.status,
      200,
      await automationResponse.text(),
    );
    const automation = await (await owner.request("/api/automation")).json();
    assert.equal(automation.intervalMs, 0);
    assert.equal(automation.running, false);
    assert.equal(automation.runs[0].trigger, "manual");
    assert.equal(automation.runs[0].status, "partial");
    const sourceAttempts = automation.runs[0].attempts.filter(
      (item: { job: string }) => item.job === "source_check",
    );
    assert.deepEqual(
      sourceAttempts.filter((item: { sourceId: string }) =>
        item.sourceId === "repository"
      ).map((item: { status: string }) => item.status),
      ["failed", "failed"],
    );
    assert.deepEqual(
      sourceAttempts.filter((item: { sourceId: string }) =>
        item.sourceId === "shared"
      ).map((item: { status: string }) => item.status),
      ["failed", "succeeded"],
    );
    const linkCheck = automation.runs[0].attempts.find(
      (item: { job: string }) => item.job === "broken_links",
    );
    assert.deepEqual(linkCheck.result.proposals, [{
      sourceId: "shared",
      path: "handbook.md",
      href: "missing.md",
      target: "missing.md",
      action: "fix_broken_link",
    }]);
    const sourcesAfterAutomation = await (await owner.request("/api/sources"))
      .json();
    assert.equal(sourcesAfterAutomation.repositories[0].status, "sync_failed");
    assert.equal(sourcesAfterAutomation.shared.status, "current");
    assert.equal(
      (await (await viewer.request(
        "/api/concepts/incident-communication",
      )).json()).published,
      publishedBeforeAutomation,
    );
    assert.equal(
      (await search(viewer, "q=shared%20operations")).results[0].trust,
      "current",
    );
    assert.equal(
      (await editor.request(
        "/api/concepts/incident-communication/archive",
        { method: "POST" },
      )).status,
      200,
    );
    assert.equal(
      (await search(viewer, "q=second%20published")).results.length,
      0,
    );
    assert.equal(
      (await search(editor, "q=first%20published")).results.length,
      0,
    );
    const archivedSearch = await search(
      editor,
      "q=second%20published&includeArchived=true",
    );
    assert.equal(archivedSearch.canIncludeArchived, true);
    assert.equal(archivedSearch.results[0].status, "archived");
    assert.equal(
      (await editor.request("/api/concepts/incident-communication/restore", {
        method: "POST",
      })).status,
      200,
    );
    assert.deepEqual(
      await (await outsider.request("/api/concepts")).json(),
      [],
    );
    assert.equal(fga.modelReceived(), true);
    assert.equal(
      fga.tuples.filter((tuple) => tuple.relation === "member").length,
      2,
    );
    assert.equal(
      (await viewer.request("/api/spaces", {
        method: "POST",
        body: JSON.stringify({ name: "Onboarding" }),
      })).status,
      403,
    );
    const onboarding = await editor.request("/api/spaces", {
      method: "POST",
      body: JSON.stringify({ name: "Onboarding" }),
    });
    assert.equal(onboarding.status, 201, await onboarding.text());
    const onboardingSpace = await (await editor.request("/api/spaces")).json();
    assert.equal(
      onboardingSpace.find((item: { id: string }) => item.id === "onboarding")
        .count,
      0,
    );
    const starter = await editor.request("/api/concepts", {
      method: "POST",
      body: JSON.stringify({
        spaceId: "onboarding",
        title: "New starter guide",
        type: "Guide",
        intent: "working",
      }),
    });
    assert.equal(starter.status, 201, await starter.text());
    const starterBody = await (await editor.request(
      "/api/concepts/new-starter-guide",
    )).json();
    assert.equal(starterBody.space, "Onboarding");
    assert.equal(starterBody.intent, "working");
    assert.equal(starterBody.draft, "# New starter guide\n");
    assert.equal(
      (await viewer.request("/api/concepts/new-starter-guide")).status,
      404,
    );
    assert.equal(
      (await viewer.request("/api/concepts/new-starter-guide/export")).status,
      404,
    );
    assert.equal(
      (await editor.request("/api/concepts/new-starter-guide/export")).status,
      409,
    );
    assert.equal(
      (await editor.request("/api/concepts/new-starter-guide", {
        method: "PUT",
        body: "# Welcome aboard\n",
      })).status,
      204,
    );
    assert.equal(
      (await editor.request("/api/concepts/new-starter-guide/publish", {
        method: "POST",
        body: JSON.stringify({ markdown: "# Welcome aboard\n" }),
      })).status,
      200,
    );
    assert.equal(
      (await (await viewer.request("/api/concepts/new-starter-guide")).json())
        .published,
      "# Welcome aboard\n",
    );
    assert.equal(
      (await editor.request("/api/concepts/new-starter-guide/traces", {
        method: "POST",
        body: JSON.stringify({
          kind: "decision",
          title: "Choose onboarding vendor",
          summary: "Moved to Vendor B for regional support.",
          occurredAt: "2026-02-31",
          sourceUrl: "http://tickets.example.com/123",
        }),
      })).status,
      400,
    );
    const traceCreated = await editor.request(
      "/api/concepts/new-starter-guide/traces",
      {
        method: "POST",
        body: JSON.stringify({
          kind: "decision",
          title: "Choose onboarding vendor",
          summary: "Moved to Vendor B for regional support.",
          occurredAt: "2026-02-20",
          sourceUrl: "https://tickets.example.com/123",
        }),
      },
    );
    assert.equal(traceCreated.status, 201, await traceCreated.text());
    const tracedConcept = await (await editor.request(
      "/api/concepts/new-starter-guide",
    )).json();
    const traceId = tracedConcept.workTraces[0].id;
    assert.equal(tracedConcept.workTraces[0].kind, "decision");
    assert.equal(
      (await viewer.request("/api/concepts/new-starter-guide/traces", {
        method: "POST",
        body: JSON.stringify({}),
      })).status,
      404,
    );
    assert.equal(
      (await (await viewer.request("/api/concepts/new-starter-guide")).json())
        .workTraces[0].title,
      "Choose onboarding vendor",
    );
    assert.equal(
      (await viewer.request(
        `/api/concepts/new-starter-guide/traces/${traceId}/fold`,
        {
          method: "POST",
          body: JSON.stringify({
            targetConceptId: "incident-communication",
            knowledge: "Vendor B is the approved onboarding provider.",
          }),
        },
      )).status,
      404,
    );
    assert.equal(
      (await editor.request(
        `/api/concepts/new-starter-guide/traces/${traceId}/fold`,
        {
          method: "POST",
          body: JSON.stringify({
            targetConceptId: "new-starter-guide",
            knowledge: "Working documents cannot receive folded knowledge.",
          }),
        },
      )).status,
      400,
    );
    const folded = await editor.request(
      `/api/concepts/new-starter-guide/traces/${traceId}/fold`,
      {
        method: "POST",
        body: JSON.stringify({
          targetConceptId: "incident-communication",
          knowledge: "Vendor B is the approved onboarding provider.",
        }),
      },
    );
    assert.equal(folded.status, 200, await folded.text());
    const foldedSource = await (await editor.request(
      "/api/concepts/new-starter-guide",
    )).json();
    assert.equal(
      foldedSource.workTraces[0].foldedIntoConceptId,
      "incident-communication",
    );
    const foldedTarget = await (await editor.request(
      "/api/concepts/incident-communication",
    )).json();
    assert.match(foldedTarget.draft, /## Choose onboarding vendor/);
    assert.match(foldedTarget.draft, /Vendor B is the approved/);
    assert.match(foldedTarget.draft, /tickets\.example\.com\/123/);
    assert.equal(
      foldedTarget.workTraces.find((trace: { id: string }) =>
        trace.id === traceId
      ).conceptTitle,
      "New starter guide",
    );
    const viewerFoldedTarget = await (await viewer.request(
      "/api/concepts/incident-communication",
    )).json();
    assert.equal(viewerFoldedTarget.draft, null);
    assert.equal(
      viewerFoldedTarget.workTraces.find((trace: { id: string }) =>
        trace.id === traceId
      ).foldedKnowledge,
      null,
    );
    assert.equal(viewerFoldedTarget.published.includes("Vendor B"), false);
    assert.equal(
      (await editor.request(
        `/api/concepts/new-starter-guide/traces/${traceId}/fold`,
        {
          method: "POST",
          body: JSON.stringify({
            targetConceptId: "incident-communication",
            knowledge: "Duplicate",
          }),
        },
      )).status,
      409,
    );
    const starterArtifact = await editor.request("/api/artifacts", {
      method: "POST",
      body: JSON.stringify({
        conceptId: "new-starter-guide",
        title: "First-week checklist",
        type: "inline_html",
        content: "<button>Done</button>",
      }),
    });
    assert.equal(starterArtifact.status, 201, await starterArtifact.text());
    const starterArtifactId = (await (await editor.request(
      "/api/artifacts?conceptId=new-starter-guide",
    )).json()).artifacts[0].id;
    assert.equal(
      (await owner.request(`/api/artifacts/${starterArtifactId}/publish`, {
        method: "POST",
      })).status,
      200,
    );
    assert.equal(
      (await (await viewer.request(
        "/api/artifacts?conceptId=new-starter-guide",
      )).json()).artifacts[0].title,
      "First-week checklist",
    );
    assert.equal(
      (await (await viewer.request(
        "/api/concepts/incident-communication",
      )).json()).published,
      "# Second published revision\n",
    );
    assert.equal(
      (await (await viewer.request("/api/spaces")).json()).find(
        (item: { id: string }) => item.id === "onboarding",
      ).count,
      1,
    );
    assert.equal(
      (await viewer.request("/api/spaces/onboarding", {
        method: "PUT",
        body: JSON.stringify({ name: "People onboarding" }),
      })).status,
      404,
    );
    assert.equal(
      (await editor.request("/api/spaces/onboarding", {
        method: "PUT",
        body: JSON.stringify({ name: "People onboarding" }),
      })).status,
      200,
    );
    assert.equal(
      (await editor.request("/api/spaces/onboarding", {
        method: "DELETE",
      })).status,
      409,
    );
    assert.equal(
      (await viewer.request("/api/concepts/new-starter-guide/metadata", {
        method: "PUT",
        body: JSON.stringify({
          spaceId: "policies",
          title: "Employee onboarding",
          type: "Handbook",
        }),
      })).status,
      404,
    );
    const moved = await editor.request(
      "/api/concepts/new-starter-guide/metadata",
      {
        method: "PUT",
        body: JSON.stringify({
          spaceId: "policies",
          title: "Employee onboarding",
          type: "Handbook",
        }),
      },
    );
    assert.equal(moved.status, 200, await moved.text());
    const movedBody = await (await editor.request(
      "/api/concepts/new-starter-guide",
    )).json();
    assert.equal(movedBody.title, "Employee onboarding");
    assert.equal(movedBody.intent, "working");
    assert.equal(movedBody.space, "Policies");
    assert.equal(movedBody.revisions.length, 1);
    assert.equal(
      fga.tuples.some((tuple) =>
        tuple.user === "space:onboarding" && tuple.relation === "parent" &&
        tuple.object === "concept:new-starter-guide"
      ),
      false,
    );
    assert.equal(
      fga.tuples.some((tuple) =>
        tuple.user === "space:policies" && tuple.relation === "parent" &&
        tuple.object === "concept:new-starter-guide"
      ),
      true,
    );
    assert.equal(
      (await editor.request("/api/spaces/onboarding", {
        method: "DELETE",
      })).status,
      204,
    );
    assert.equal(
      (await editor.request("/api/spaces/policies", {
        method: "DELETE",
      })).status,
      409,
    );
    const republished = await editor.request(
      "/api/concepts/new-starter-guide/publish",
      {
        method: "POST",
        body: JSON.stringify({ markdown: "# Welcome aboard\n" }),
      },
    );
    assert.equal((await republished.json()).revisions.length, 2);
    const exported = await viewer.request(
      "/api/concepts/new-starter-guide/export",
    );
    assert.equal(exported.status, 200);
    assert.equal(
      exported.headers.get("content-disposition"),
      'attachment; filename="new-starter-guide.md"',
    );
    assert.match(
      await exported.text(),
      /^---\ntype: Handbook\ntitle: "Employee onboarding"[\s\S]*# Welcome aboard\n$/,
    );
    assert.equal(
      (await outsider.request("/api/concepts/new-starter-guide/export")).status,
      404,
    );
    assert.equal(
      (await (await viewer.request(
        "/api/artifacts?conceptId=new-starter-guide",
      )).json()).artifacts[0].title,
      "First-week checklist",
    );

    const replacedRepositoryCredentials = await owner.request(
      "/api/sources/repositories/repository",
      {
        method: "POST",
        body: JSON.stringify({
          repositoryUrl: "https://example.com/company/knowledge.git",
          folder: "okf",
          username: "replacement-user",
          token: "replacement-token",
        }),
      },
    );
    assert.equal(
      replacedRepositoryCredentials.status,
      200,
      await replacedRepositoryCredentials.text(),
    );
    assert.equal(
      (await (await owner.request("/api/sources")).json()).repositories[0]
        .conceptCount,
      2,
    );
    assert.deepEqual(repositoryCredentials, {
      username: "replacement-user",
      token: "replacement-token",
    });

    const secondRepository = await owner.request(
      "/api/sources/repositories",
      {
        method: "POST",
        body: JSON.stringify({
          repositoryUrl: "https://example.com/company/engineering.git",
          folder: "okf",
          username: "engineering-user",
          token: "engineering-token",
        }),
      },
    );
    const secondRepositoryText = await secondRepository.text();
    assert.equal(secondRepository.status, 201, secondRepositoryText);
    const secondRepositoryBody = JSON.parse(secondRepositoryText);
    assert.match(secondRepositoryBody.id, /^repository-[a-f0-9-]+$/);
    assert.equal(secondRepositoryBody.conceptCount, 1);
    const allRepositories = (await (await owner.request("/api/sources")).json())
      .repositories;
    assert.equal(allRepositories.length, 2);
    const engineeringImport = await viewer.request(
      `/api/imported?source=${secondRepositoryBody.id}&path=operations.md`,
    );
    assert.equal(engineeringImport.status, 200);
    assert.equal(
      (await engineeringImport.json()).markdown,
      "# Engineering operations\n",
    );
    assert.equal(
      (await (await viewer.request(
        "/api/imported?source=repository&path=operations.md",
      )).json()).markdown,
      "# Operations v2\n",
    );
    assert.equal(
      fga.tuples.some((tuple) =>
        tuple.user === `space:imported-${secondRepositoryBody.id}` &&
        tuple.relation === "parent" &&
        tuple.object === `concept:${secondRepositoryBody.id}/operations`
      ),
      true,
    );
    const multipleSourceRun = await owner.request("/api/automation/run", {
      method: "POST",
    });
    assert.equal(multipleSourceRun.status, 200, await multipleSourceRun.text());
    const multipleSourceHistory = await (await owner.request("/api/automation"))
      .json();
    assert.deepEqual(
      multipleSourceHistory.runs[0].attempts.filter(
        (attempt: { job: string; status: string }) =>
          attempt.job === "source_check" && attempt.status === "succeeded",
      ).map((attempt: { sourceId: string }) => attempt.sourceId).sort(),
      ["repository", secondRepositoryBody.id, "shared"].sort(),
    );
    assert.equal(
      (await owner.request(
        `/api/sources/repositories/${secondRepositoryBody.id}`,
        {
          method: "DELETE",
          body: JSON.stringify({ confirm: "wrong-source" }),
        },
      )).status,
      400,
    );
    assert.equal(
      (await editor.request(
        `/api/sources/repositories/${secondRepositoryBody.id}`,
        {
          method: "DELETE",
          body: JSON.stringify({ confirm: secondRepositoryBody.id }),
        },
      )).status,
      403,
    );
    assert.equal(
      [...objects.keys()].some((key) =>
        key.startsWith(`sources/${secondRepositoryBody.id}/`)
      ),
      true,
    );
    const disconnected = await owner.request(
      `/api/sources/repositories/${secondRepositoryBody.id}`,
      {
        method: "DELETE",
        body: JSON.stringify({ confirm: secondRepositoryBody.id }),
      },
    );
    assert.equal(disconnected.status, 204, await disconnected.text());
    assert.equal(
      (await (await owner.request("/api/sources")).json()).repositories.length,
      1,
    );
    assert.equal(
      (await viewer.request(
        `/api/imported?source=${secondRepositoryBody.id}&path=operations.md`,
      )).status,
      404,
    );
    assert.equal(
      [...objects.keys()].some((key) =>
        key.startsWith(`sources/${secondRepositoryBody.id}/`)
      ),
      false,
    );
    const disconnectedDb = new DatabaseSync(`${dataDir}/hub.db`);
    assert.equal(
      (disconnectedDb.prepare(
        "SELECT COUNT(*) AS count FROM okf_repository_source WHERE id = ?",
      ).get(secondRepositoryBody.id) as { count: number }).count,
      0,
    );
    assert.equal(
      (disconnectedDb.prepare(
        "SELECT COUNT(*) AS count FROM okf_imported_concept WHERE sourceId = ?",
      ).get(secondRepositoryBody.id) as { count: number }).count,
      0,
    );
    disconnectedDb.close();
    assert.equal(
      fga.tuples.some((tuple) =>
        tuple.object === `concept:${secondRepositoryBody.id}/operations` ||
        tuple.object === `space:imported-${secondRepositoryBody.id}`
      ),
      false,
    );
    assert.equal(
      (await (await owner.request("/api/automation")).json()).runs.some(
        (run: { attempts: { sourceId: string }[] }) =>
          run.attempts.some((attempt) =>
            attempt.sourceId === secondRepositoryBody.id
          ),
      ),
      true,
    );

    const audit = await (await owner.request("/api/audit")).json();
    assert.deepEqual(
      audit.map((event: { action: string }) => event.action).sort(),
      [
        "artifact.created",
        "artifact.created",
        "artifact.created",
        "artifact.published",
        "artifact.published",
        "artifact.published",
        "artifact.published",
        "artifact.revised",
        "concept.created",
        "concept.created",
        "concept.exported",
        "concept.updated",
        "invitation.accepted",
        "invitation.accepted",
        "invitation.created",
        "invitation.created",
        "organization.created",
        "space.created",
        "space.deleted",
        "space.renamed",
        "trace.created",
        "trace.folded",
      ],
    );
  } finally {
    await server.shutdown();
    await app.close();
    await fga.server.shutdown();
    await Deno.remove(dataDir, { recursive: true });
  }
});
