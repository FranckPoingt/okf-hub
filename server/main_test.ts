/// <reference lib="deno.ns" />

import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import type { AIRequest } from "./ai.ts";
import { createCollabApp, DEFAULT_MARKDOWN } from "./main.ts";
import { inspectOkf, type RepositoryCredentials } from "./repository-source.ts";
import { parseSSOConfig } from "./sso-config.ts";

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
      const parentSource = viewedSpace
        ? tuples.find((tuple) =>
          tuple.relation === "parent" && tuple.object === viewedSpace &&
          tuple.user.startsWith("source:")
        )?.user
        : undefined;
      const viewer = Boolean(viewedSpace) &&
        tuples.some((tuple) =>
          tuple.relation === "viewer" &&
          (tuple.object === viewedSpace || tuple.object === parentSource) &&
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

  async signUp(name: string, email: string, invitationId?: string) {
    const response = await this.request("/api/auth/sign-up/email", {
      method: "POST",
      body: JSON.stringify({
        name,
        email,
        password: "password123",
        invitationId,
      }),
    });
    assert.equal(response.status, 200, await response.text());
  }
}

async function archiveEntries(response: Response) {
  const raw = new Uint8Array(await response.arrayBuffer());
  const view = new DataView(raw.buffer);
  const decoder = new TextDecoder();
  const entries = new Map<string, Uint8Array>();
  for (let offset = 0; view.getUint32(offset, true) === 0x04034b50;) {
    const compressedSize = view.getUint32(offset + 18, true);
    const nameLength = view.getUint16(offset + 26, true);
    const extraLength = view.getUint16(offset + 28, true);
    const name = decoder.decode(
      raw.subarray(offset + 30, offset + 30 + nameLength),
    );
    const bodyOffset = offset + 30 + nameLength + extraLength;
    const compressed = raw.slice(bodyOffset, bodyOffset + compressedSize);
    const body = new Uint8Array(
      await new Response(
        new Blob([compressed]).stream().pipeThrough(
          new DecompressionStream("deflate-raw"),
        ),
      ).arrayBuffer(),
    );
    entries.set(name, body);
    offset = bodyOffset + compressedSize;
  }
  return entries;
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
    CREATE TABLE okf_imported_revision (
      conceptId TEXT NOT NULL,
      sourceRevision TEXT NOT NULL,
      objectKey TEXT NOT NULL,
      importedAt TEXT NOT NULL,
      PRIMARY KEY (conceptId, sourceRevision)
    );
    INSERT INTO okf_imported_concept VALUES
      ('repository/guide', 'guide.md', 'Guide', 'Guide', 'current', 'old.md', 'commit', 'hash', '2026-01-02', NULL);
    INSERT INTO okf_imported_revision VALUES
      ('repository/guide', 'commit', 'old.md', '2026-01-01');
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
        "SELECT searchText, importedAt FROM okf_imported_concept",
      ).get() as { searchText: string; importedAt: string }).searchText,
      "guide guide",
    );
    assert.equal(
      (migrated.prepare(
        "SELECT importedAt FROM okf_imported_concept",
      ).get() as { importedAt: string }).importedAt,
      "2026-01-01",
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
    assert.equal(
      (migrated.prepare(
        "SELECT automationIntervalMinutes FROM okf_repository_source WHERE id = 'repository'",
      ).get() as { automationIntervalMinutes: number })
        .automationIntervalMinutes,
      360,
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

Deno.test("shares local sessions with the HMR subdomain", async () => {
  const dataDir = await Deno.makeTempDir();
  const app = await createCollabApp({
    dataDir,
    baseURL: "http://okf-hub.localhost",
    trustedOrigins: ["http://dev.okf-hub.localhost"],
    authSecret: "a-secure-test-secret-with-at-least-32-characters",
  });
  const server = Deno.serve(
    { hostname: "127.0.0.1", port: 0, onListen() {} },
    app.fetch,
  );
  try {
    const response = await fetch(
      `http://127.0.0.1:${
        (server.addr as Deno.NetAddr).port
      }/api/auth/sign-up/email`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: "http://dev.okf-hub.localhost",
        },
        body: JSON.stringify({
          name: "Dev owner",
          email: "dev-owner@example.com",
          password: "password123",
        }),
      },
    );
    assert.equal(response.status, 200, await response.text());
    assert.match(
      response.headers.get("set-cookie") ?? "",
      /Domain=okf-hub\.localhost/i,
    );
  } finally {
    await server.shutdown();
    await app.close();
    await Deno.remove(dataDir, { recursive: true });
  }
});

Deno.test("runs scheduled checks and records their history", async () => {
  const dataDir = await Deno.makeTempDir();
  const app = await createCollabApp({
    dataDir,
    automationIntervalMs: 10,
    repositorySync: () =>
      Promise.resolve({ revision: "scheduled", files: [], issues: [] }),
  });
  try {
    const db = new DatabaseSync(`${dataDir}/hub.db`);
    db.exec("PRAGMA foreign_keys=OFF");
    db.prepare(
      "INSERT INTO member (id, organizationId, userId, role, createdAt) VALUES (?, ?, ?, 'owner', ?)",
    ).run("member", "organization", "owner", new Date().toISOString());
    db.prepare(
      "INSERT INTO okf_repository_source (id, repositoryUrl, folder, status, automationIntervalMinutes) VALUES ('repository', 'https://example.com/knowledge.git', 'okf', 'current', 1)",
    ).run();
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
    assert.deepEqual(
      history.prepare(
        "SELECT job FROM okf_automation_attempt WHERE runId = 1 ORDER BY id",
      ).all().map((row) => (row as { job: string }).job),
      ["source_check", "broken_links"],
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
  let notionConfig: Record<string, string> | undefined;
  const aiRequests: AIRequest[] = [];
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
    aiProvider: "ollama",
    aiModel: "test-model",
    aiResponder(request) {
      aiRequests.push(request);
      return Promise.resolve(`Answer from ${request.document.state}`);
    },
    ssoProviders: await parseSSOConfig(
      JSON.stringify({
        providers: [{
          name: "Company SSO",
          providerId: "company-oidc",
          domain: "example.com",
          oidcConfig: {
            issuer: "https://login.example.com",
            clientId: "client-id",
            clientSecret: "client-secret",
          },
        }],
      }),
      "http://127.0.0.1:8788",
    ),
    githubApp: {
      slug: "okf-hub",
      installUrl: "https://github.com/apps/okf-hub/installations/new",
      repositories: () =>
        Promise.resolve([{
          id: 77,
          fullName: "acme/knowledge",
          cloneUrl: "https://github.com/acme/knowledge.git",
          defaultBranch: "main",
          private: true,
        }]),
      folders: () => Promise.resolve([".", "okf"]),
      credentials: () =>
        Promise.resolve({
          username: "x-access-token",
          token: "installation-token",
        }),
      verify: (_body, signature) => signature === "valid-signature",
    },
    repositorySync(_checkout, repositoryUrl, _folder, credentials) {
      if (repositoryUrl.includes("github.com/acme")) {
        repositoryCredentials = credentials;
        return Promise.resolve({
          revision: "github-one",
          files: [imported(
            "github.md",
            "GitHub knowledge",
            "# GitHub knowledge\n",
            "github-one",
          )],
          issues: [],
        });
      }
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
    notionSourceSync(config) {
      notionConfig = config;
      return Promise.resolve({
        revision: "notion-one",
        files: [imported(
          "notion-page.md",
          "Notion handbook",
          "# Notion handbook\n",
          "notion-page",
          { owner: "Notion workspace" },
        )],
        issues: [],
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
  const blocked = new Client(base);

  try {
    const patchPreflight = await fetch(
      `${base}/api/comment-threads/example`,
      {
        method: "OPTIONS",
        headers: {
          origin: "http://127.0.0.1:3000",
          "access-control-request-method": "PATCH",
        },
      },
    );
    assert.equal(patchPreflight.status, 204);
    assert.match(
      patchPreflight.headers.get("access-control-allow-methods") ?? "",
      /PATCH/,
    );
    const portlessPreflight = await fetch(
      `${base}/api/comment-threads/example`,
      {
        method: "OPTIONS",
        headers: {
          origin: "http://feature.dev.okf-hub.localhost",
          "access-control-request-method": "PATCH",
        },
      },
    );
    assert.equal(portlessPreflight.status, 204);
    assert.equal(
      (await fetch(`${base}/api/comment-threads/example`, {
        method: "OPTIONS",
        headers: { origin: "not a url" },
      })).status,
      403,
    );
    assert.equal(
      (await fetch(`${base}/api/concepts/incident-communication`)).status,
      401,
    );
    assert.equal((await fetch(`${base}/api/ai/config`)).status, 401);
    assert.equal((await fetch(`${base}/api/search`)).status, 401);
    assert.equal(
      (await (await fetch(`${base}/api/bootstrap`)).json()).signupAllowed,
      true,
    );
    assert.deepEqual(
      (await (await fetch(`${base}/api/bootstrap`)).json()).ssoProviders,
      [{
        providerId: "company-oidc",
        name: "Company SSO",
        type: "oidc",
      }],
    );
    await owner.signUp("Owner", "owner@example.com");
    await outsider.signUp("Outsider", "outsider@example.com");
    assert.equal(
      (await (await owner.request("/api/bootstrap")).json()).setupRequired,
      true,
    );
    const beforeSetup = new DatabaseSync(`${dataDir}/hub.db`);
    assert.equal(
      Number(
        (beforeSetup.prepare(
          'SELECT COUNT(*) AS count FROM "organization"',
        ).get() as { count: number }).count,
      ),
      0,
    );
    beforeSetup.close();
    assert.equal(
      (await owner.request("/api/setup", {
        method: "POST",
        body: JSON.stringify({ name: "", tagline: "" }),
      })).status,
      400,
    );
    const setup = await owner.request("/api/setup", {
      method: "POST",
      body: JSON.stringify({
        name: "Acme knowledge",
        tagline: "The answers our team can trust",
      }),
    });
    assert.equal(setup.status, 200, await setup.clone().text());
    const setupBody = await setup.json();
    assert.equal(setupBody.workspace.name, "Acme knowledge");
    assert.equal(
      setupBody.workspace.tagline,
      "The answers our team can trust",
    );
    assert.deepEqual(await (await owner.request("/api/ai/config")).json(), {
      enabled: true,
      provider: "ollama",
      model: "test-model",
    });
    assert.equal(
      (await (await blocked.request("/api/bootstrap")).json()).signupAllowed,
      false,
    );
    assert.equal(
      (await blocked.request("/api/auth/sign-up/email", {
        method: "POST",
        body: JSON.stringify({
          name: "Blocked",
          email: "blocked@example.com",
          password: "password123",
        }),
      })).status,
      403,
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
    const workspaceUpdated = await owner.request("/api/workspace", {
      method: "PUT",
      body: JSON.stringify({
        name: "Operations knowledge",
        tagline: "Trusted company guidance",
        logo: "",
      }),
    });
    assert.equal(workspaceUpdated.status, 200, await workspaceUpdated.text());
    assert.equal(
      (await (await owner.request("/api/bootstrap")).json()).workspace.name,
      "Operations knowledge",
    );
    assert.deepEqual(
      (await (await owner.request("/api/bootstrap")).json()).groups,
      [],
    );
    const groupCreated = await owner.request("/api/groups", {
      method: "POST",
      body: JSON.stringify({ name: "Support", access: "viewer" }),
    });
    const group = await groupCreated.json();
    assert.equal(groupCreated.status, 201, JSON.stringify(group));
    assert.equal(group.access, "viewer");
    assert.ok(
      (await (await owner.request("/api/bootstrap")).json()).groups.some(
        (item: { id: string }) => item.id === group.id,
      ),
    );

    const invite = async (
      email: string,
      access: "editor" | "viewer",
      teamId?: string,
    ) => {
      const response = await owner.request("/api/invitations", {
        method: "POST",
        body: JSON.stringify({ email, access, teamId }),
      });
      if (!response.ok) assert.fail(await response.text());
      return (await response.json()).id as string;
    };
    const editorInvitation = await invite("editor@example.com", "editor");
    const viewerInvitation = await invite(
      "viewer@example.com",
      "viewer",
      group.id,
    );
    assert.equal(
      (await blocked.request("/api/auth/sign-up/email", {
        method: "POST",
        body: JSON.stringify({
          name: "Wrong recipient",
          email: "wrong@example.com",
          password: "password123",
          invitationId: editorInvitation,
        }),
      })).status,
      403,
    );
    await editor.signUp("Editor", "editor@example.com", editorInvitation);
    await viewer.signUp("Viewer", "viewer@example.com", viewerInvitation);
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
      (await (await viewer.request("/api/bootstrap")).json()).access,
      "viewer",
    );

    assert.equal(
      (await editor.request("/api/concepts/incident-communication")).status,
      200,
    );
    const titleOnlyFrontmatter = await editor.request(
      "/api/concepts/incident-communication",
      {
        method: "PUT",
        body: '---\ntitle: "Borrow"\n---\n\n# Clean body\n',
      },
    );
    assert.equal(titleOnlyFrontmatter.status, 204);
    assert.equal(
      (await (await editor.request(
        "/api/concepts/incident-communication",
      )).json()).draft,
      "# Clean body\n",
    );
    await editor.request("/api/concepts/incident-communication", {
      method: "PUT",
      body: '***\n\n## title: "Borrow"\n\n# Still clean\n',
    });
    assert.equal(
      (await (await editor.request(
        "/api/concepts/incident-communication",
      )).json()).draft,
      "# Still clean\n",
    );
    const askDraft = await editor.request("/api/ai/chat", {
      method: "POST",
      body: JSON.stringify({
        conceptId: "incident-communication",
        state: "draft",
        messages: [{ role: "user", content: "What is this about?" }],
      }),
    });
    assert.equal(askDraft.status, 200, await askDraft.clone().text());
    assert.equal((await askDraft.json()).message, "Answer from draft");
    assert.equal(aiRequests.at(-1)?.document.markdown, "# Still clean\n");
    assert.equal(
      (await outsider.request("/api/ai/chat", {
        method: "POST",
        body: JSON.stringify({
          conceptId: "incident-communication",
          messages: [{ role: "user", content: "Reveal it" }],
        }),
      })).status,
      404,
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
    const askPublished = await viewer.request("/api/ai/chat", {
      method: "POST",
      body: JSON.stringify({
        conceptId: "incident-communication",
        state: "draft",
        messages: [{ role: "user", content: "What is published?" }],
      }),
    });
    assert.equal(
      (await askPublished.json()).message,
      "Answer from published",
    );
    assert.equal(
      aiRequests.at(-1)?.document.markdown,
      "# First published draft\n",
    );
    const commentResponse = await viewer.request(
      "/api/concepts/incident-communication/comments",
      {
        method: "POST",
        body: JSON.stringify({
          body: "Can we make this step clearer?",
          anchorText: "First published draft",
          anchorStart: 2,
          anchorEnd: 23,
          revisionNumber: 1,
        }),
      },
    );
    const commentThread = await commentResponse.json();
    assert.equal(commentResponse.status, 201, JSON.stringify(commentThread));
    assert.equal(commentThread.comments[0].authorName, "Viewer");
    assert.equal(
      (await outsider.request(
        "/api/concepts/incident-communication/comments",
      )).status,
      404,
    );
    assert.equal(
      (await editor.request(
        `/api/comment-threads/${commentThread.id}/replies`,
        {
          method: "POST",
          body: JSON.stringify({ body: "Yes, I will update it." }),
        },
      )).status,
      200,
    );
    const openComments = await (await viewer.request(
      "/api/concepts/incident-communication/comments?status=open",
    )).json();
    assert.equal(openComments[0].comments.length, 2);
    assert.equal(
      (await viewer.request(`/api/comment-threads/${commentThread.id}`, {
        method: "PATCH",
        body: JSON.stringify({ resolved: true }),
      })).status,
      200,
    );
    assert.deepEqual(
      await (await viewer.request(
        "/api/concepts/incident-communication/comments?status=open",
      )).json(),
      [],
    );
    assert.equal(
      (await (await viewer.request(
        "/api/concepts/incident-communication/comments?status=resolved",
      )).json()).length,
      1,
    );
    assert.equal(
      (await viewer.request(`/api/comment-threads/${commentThread.id}`, {
        method: "PATCH",
        body: JSON.stringify({ resolved: false }),
      })).status,
      200,
    );
    const openApi = await fetch(`${base}/api/openapi.json`);
    assert.equal(openApi.status, 200);
    assert.ok(
      Object.hasOwn(
        (await openApi.json()).paths,
        "/api/v1/actions/knowledge.search",
      ),
    );
    assert.equal((await fetch(`${base}/api/v1/actions`)).status, 401);
    const actionList = await (await owner.request("/api/v1/actions")).json();
    assert.deepEqual(
      [
        "documents.create",
        "documents.get",
        "templates.list",
        "documents.trace.create",
      ]
        .filter((name) =>
          !actionList.actions.some((action: { name: string }) =>
            action.name === name
          )
        ),
      [],
    );
    const listedTemplates = await owner.request(
      "/api/v1/actions/templates.list",
      { method: "POST", body: "{}" },
    );
    const listedTemplatesText = await listedTemplates.text();
    assert.equal(listedTemplates.status, 200, listedTemplatesText);
    const listedTemplateBody = JSON.parse(listedTemplatesText);
    assert.equal(listedTemplateBody.result[0].id, "understanding-brief");
    assert.equal(listedTemplateBody.result[0].builtIn, true);
    const keyResponse = await owner.request("/api/developer/keys", {
      method: "POST",
      body: JSON.stringify({
        name: "Search integration",
        scopes: ["knowledge.search"],
      }),
    });
    const apiKey = await keyResponse.json();
    assert.equal(keyResponse.status, 201, JSON.stringify(apiKey));
    assert.match(apiKey.token, /^okf_[a-f0-9]{64}$/);
    const apiSearch = await fetch(
      `${base}/api/v1/actions/knowledge.search`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${apiKey.token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ query: "published" }),
      },
    );
    const apiSearchBody = await apiSearch.json();
    assert.equal(apiSearch.status, 200, JSON.stringify(apiSearchBody));
    assert.equal(
      apiSearchBody.result.results[0].id,
      "incident-communication",
    );
    assert.equal(
      (await fetch(`${base}/api/v1/actions/documents.get`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${apiKey.token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ id: "incident-communication" }),
      })).status,
      404,
    );
    const listedKeys = await (await owner.request("/api/developer/keys"))
      .json();
    assert.equal(listedKeys.keys[0].token, undefined);
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
    const duplicatePublish = await editor.request(
      "/api/concepts/incident-communication/publish",
      {
        method: "POST",
        body: JSON.stringify({ markdown: "# Second published revision\n" }),
      },
    );
    const duplicate = await duplicatePublish.json();
    assert.equal(duplicatePublish.status, 200);
    assert.equal(duplicate.revisions.length, 2);
    assert.equal(duplicate.publishedRevision, 2);
    const firstRevision = await editor.request(
      "/api/concepts/incident-communication/revisions/1",
    );
    assert.equal(firstRevision.status, 200);
    assert.equal(await firstRevision.text(), "# First published draft\n");
    assert.equal(
      (await viewer.request(
        "/api/concepts/incident-communication/revisions/1",
      )).status,
      404,
    );
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
    assert.match(artifact.artifacts[0].document, /window\.okf=/);
    assert.deepEqual(artifact.artifacts[0].grants, ["app.data.*"]);
    const savedAppData = await editor.request(
      "/api/v1/actions/app.data.set",
      {
        method: "POST",
        body: JSON.stringify({
          appId: artifact.artifacts[0].id,
          collection: "notes",
          key: "incident",
          value: { status: "ready" },
        }),
      },
    );
    const savedAppDataBody = await savedAppData.json();
    assert.equal(savedAppData.status, 200, JSON.stringify(savedAppDataBody));
    assert.deepEqual(savedAppDataBody.result.value, {
      status: "ready",
    });
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
    assert.equal(
      (await (await viewer.request("/api/v1/actions/app.data.get", {
        method: "POST",
        body: JSON.stringify({
          appId: artifactId,
          collection: "notes",
          key: "incident",
        }),
      })).json()).result,
      null,
    );
    const apps = await (await editor.request(
      "/api/apps?conceptId=incident-communication",
    )).json();
    assert.equal(apps.apps[0].title, "Incident calculator");
    assert.ok(
      apps.availableActions.some((action: { name: string }) =>
        action.name === "knowledge.search"
      ),
    );
    const createdAppResponse = await editor.request("/api/apps", {
      method: "POST",
      body: JSON.stringify({
        conceptId: "incident-communication",
        title: "Knowledge finder",
        description: "Searches visible OKF knowledge",
        type: "inline_html",
        content: "<button>Search</button>",
        grants: ["knowledge.search"],
      }),
    });
    const createdApp = await createdAppResponse.json();
    assert.equal(createdAppResponse.status, 201, JSON.stringify(createdApp));
    assert.deepEqual(createdApp.grants, ["knowledge.search"]);
    assert.equal(
      (await owner.request(`/api/apps/${createdApp.id}/activate`, {
        method: "POST",
      })).status,
      200,
    );
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
      (await owner.request(`/api/developer/keys/${apiKey.id}`, {
        method: "DELETE",
      })).status,
      204,
    );
    assert.equal(
      (await fetch(`${base}/api/v1/actions/knowledge.search`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${apiKey.token}`,
          "content-type": "application/json",
        },
        body: "{}",
      })).status,
      401,
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

    const connectorState = await (await owner.request("/api/sources")).json();
    assert.deepEqual(
      connectorState.connectors.map((connector: {
        id: string;
        capabilities: string[];
        enabled: boolean;
      }) => [connector.id, connector.capabilities, connector.enabled]),
      [
        ["git", ["import"], true],
        ["s3", ["import"], true],
        ["notion", ["import"], true],
        ["miro", ["embed"], true],
        ["google-sheets", ["embed"], true],
      ],
    );
    assert.equal(
      connectorState.connectors.find((connector: { id: string }) =>
        connector.id === "notion"
      ).fields[0].secret,
      true,
    );
    assert.equal(
      (await editor.request("/api/connectors/notion/enabled", {
        method: "PUT",
        body: JSON.stringify({ enabled: false }),
      })).status,
      403,
    );
    assert.equal(
      (await owner.request("/api/connectors/notion/enabled", {
        method: "PUT",
        body: JSON.stringify({ enabled: false }),
      })).status,
      200,
    );
    assert.equal(
      (await owner.request("/api/connectors/notion/connect", {
        method: "POST",
        body: JSON.stringify({ token: "ntn_disabled_connector_token" }),
      })).status,
      409,
    );
    assert.equal(
      (await owner.request("/api/sources/notion", {
        method: "POST",
        body: JSON.stringify({ token: "ntn_disabled_connector_token" }),
      })).status,
      409,
    );
    await owner.request("/api/connectors/notion/enabled", {
      method: "PUT",
      body: JSON.stringify({ enabled: true }),
    });

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
    assert.equal(firstSource.automationIntervalMinutes, 0);
    assert.equal(
      (await viewer.request("/api/sources/repository/schedule", {
        method: "PUT",
        body: JSON.stringify({ intervalMinutes: 60 }),
      })).status,
      403,
    );
    assert.equal(
      (await owner.request("/api/sources/repository/schedule", {
        method: "PUT",
        body: JSON.stringify({ intervalMinutes: 30 }),
      })).status,
      400,
    );
    const repositorySchedule = await owner.request(
      "/api/sources/repository/schedule",
      {
        method: "PUT",
        body: JSON.stringify({ intervalMinutes: 60 }),
      },
    );
    assert.equal(repositorySchedule.status, 200);
    assert.equal(
      (await repositorySchedule.json()).automationIntervalMinutes,
      60,
    );
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
    const askImported = await viewer.request("/api/ai/chat", {
      method: "POST",
      body: JSON.stringify({
        importId: "repository/operations",
        messages: [{ role: "user", content: "What is this about?" }],
      }),
    });
    assert.equal(askImported.status, 200, await askImported.clone().text());
    assert.equal((await askImported.json()).message, "Answer from source");
    assert.equal(aiRequests.at(-1)?.document.markdown, "# Operations v1\n");

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
    assert.equal(sharedBody.automationIntervalMinutes, 0);
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
    const sharedSchedule = await owner.request("/api/sources/shared/schedule", {
      method: "PUT",
      body: JSON.stringify({ intervalMinutes: 1440 }),
    });
    assert.equal(sharedSchedule.status, 200);
    assert.equal((await sharedSchedule.json()).automationIntervalMinutes, 1440);
    const scheduledSources = await (await owner.request("/api/sources")).json();
    assert.equal(
      scheduledSources.repositories[0].automationIntervalMinutes,
      60,
    );
    assert.equal(scheduledSources.shared.automationIntervalMinutes, 1440);
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
    assert.equal(
      (await editor.request("/api/sources/notion", {
        method: "POST",
        body: JSON.stringify({ token: "ntn_editor_should_not_connect" }),
      })).status,
      403,
    );
    const notionConnected = await owner.request(
      "/api/connectors/notion/connect",
      {
        method: "POST",
        body: JSON.stringify({ token: "ntn_secret_integration_token" }),
      },
    );
    const notionText = await notionConnected.text();
    assert.equal(notionConnected.status, 201, notionText);
    const notionBody = JSON.parse(notionText);
    assert.equal(notionBody.status, "current");
    assert.equal(notionBody.revision, "notion-one");
    assert.equal(notionBody.conceptCount, 1);
    assert.equal(notionBody.credentialsConfigured, true);
    assert.equal(notionText.includes("ntn_secret_integration_token"), false);
    assert.deepEqual(notionConfig, { token: "ntn_secret_integration_token" });
    const notionSchedule = await owner.request("/api/sources/notion/schedule", {
      method: "PUT",
      body: JSON.stringify({ intervalMinutes: 720 }),
    });
    assert.equal(notionSchedule.status, 200);
    assert.equal((await notionSchedule.json()).automationIntervalMinutes, 720);
    const notionImported = await viewer.request(
      "/api/imported?source=notion&path=notion-page.md",
    );
    assert.equal(notionImported.status, 200);
    assert.equal((await notionImported.json()).markdown, "# Notion handbook\n");
    const notionStored = new DatabaseSync(`${dataDir}/hub.db`).prepare(
      "SELECT credentialsCipher FROM okf_notion_source WHERE id = 'notion'",
    ).get() as { credentialsCipher: string };
    assert.match(notionStored.credentialsCipher, /^v1:/);
    assert.equal(notionStored.credentialsCipher.includes("ntn_secret"), false);
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
    assert.equal(sharedSearch.results[0].snippet, "");
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
      5,
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
    assert.equal(
      (await editor.request("/api/spaces", {
        method: "POST",
        body: JSON.stringify({ name: "Onboarding", icon: "x".repeat(17) }),
      })).status,
      400,
    );
    const onboarding = await editor.request("/api/spaces", {
      method: "POST",
      body: JSON.stringify({ name: "Onboarding", icon: "🚀" }),
    });
    assert.equal(onboarding.status, 201, await onboarding.text());
    const onboardingSpace = await (await editor.request("/api/spaces")).json();
    assert.equal(
      onboardingSpace.find((item: { id: string }) => item.id === "onboarding")
        .count,
      0,
    );
    assert.equal(
      onboardingSpace.find((item: { id: string }) => item.id === "onboarding")
        .icon,
      "🚀",
    );
    const builtInTemplates = await (await editor.request("/api/templates"))
      .json();
    assert.equal(builtInTemplates.length, 1);
    assert.equal(builtInTemplates[0].id, "understanding-brief");
    assert.equal(builtInTemplates[0].builtIn, true);
    assert.equal((await viewer.request("/api/templates")).status, 403);
    assert.equal(
      (await editor.request("/api/templates/understanding-brief", {
        method: "DELETE",
      })).status,
      400,
    );
    const templateResponse = await editor.request("/api/templates", {
      method: "POST",
      body: JSON.stringify({
        name: "Team welcome",
        description: "A user-authored onboarding outline",
        body:
          "## Welcome {{team}}\n\nOwned by {{owner}}. See [incident guidance](/knowledge/incident-communication).\n",
      }),
    });
    const templateText = await templateResponse.text();
    assert.equal(templateResponse.status, 201, templateText);
    const template = JSON.parse(templateText);
    assert.deepEqual(template.variables, ["team", "owner"]);
    const missingVariable = await editor.request("/api/concepts", {
      method: "POST",
      body: JSON.stringify({
        spaceId: "policies",
        title: "Incomplete welcome",
        type: "Guide",
        templateId: template.id,
        variables: { team: "Support" },
      }),
    });
    assert.equal(missingVariable.status, 400);
    const templated = await editor.request("/api/concepts", {
      method: "POST",
      body: JSON.stringify({
        spaceId: "policies",
        parentId: "incident-communication",
        title: "Support welcome",
        type: "Guide",
        templateId: template.id,
        variables: { team: "Support", owner: "People Ops" },
      }),
    });
    const templatedText = await templated.text();
    assert.equal(templated.status, 201, templatedText);
    const templatedBody = JSON.parse(templatedText);
    assert.match(templatedBody.draft, /Welcome Support/);
    assert.match(templatedBody.draft, /Owned by People Ops/);
    assert.equal(templatedBody.parentId, "incident-communication");
    const locked = await editor.request(
      "/api/concepts/support-welcome/lock",
      { method: "POST" },
    );
    const lockedText = await locked.text();
    assert.equal(locked.status, 200, lockedText);
    assert.ok(JSON.parse(lockedText).lockedAt);
    assert.equal(
      (await editor.request("/api/concepts/support-welcome/move", {
        method: "POST",
        body: JSON.stringify({ spaceId: "policies", parentId: null, index: 0 }),
      })).status,
      423,
    );
    assert.equal(
      (await editor.request("/api/concepts/support-welcome", {
        method: "PUT",
        body: "# Blocked while locked\n",
      })).status,
      423,
    );
    assert.equal(
      (await editor.request("/api/concepts/support-welcome/unlock", {
        method: "POST",
      })).status,
      200,
    );
    const movedToRoot = await editor.request(
      "/api/concepts/support-welcome/move",
      {
        method: "POST",
        body: JSON.stringify({ spaceId: "policies", parentId: null, index: 0 }),
      },
    );
    assert.equal(movedToRoot.status, 200, await movedToRoot.text());
    assert.equal(
      (await (await editor.request("/api/concepts")).json())[0].id,
      "support-welcome",
    );
    assert.equal(
      (await editor.request("/api/concepts/support-welcome/move", {
        method: "POST",
        body: JSON.stringify({
          spaceId: "policies",
          parentId: "incident-communication",
          index: 0,
        }),
      })).status,
      200,
    );
    assert.equal(
      (await editor.request("/api/concepts/incident-communication/metadata", {
        method: "PUT",
        body: JSON.stringify({
          title: "Incident communication",
          type: "Policy",
          spaceId: "policies",
          parentId: "support-welcome",
        }),
      })).status,
      400,
    );
    assert.equal(
      (await editor.request("/api/concepts/support-welcome/publish", {
        method: "POST",
        body: JSON.stringify({ markdown: templatedBody.draft }),
      })).status,
      200,
    );
    const incidentRelationships = await search(viewer, "q=second%20published");
    assert.deepEqual(
      incidentRelationships.results[0].backlinks.map((item: { id: string }) =>
        item.id
      ),
      ["support-welcome"],
    );
    assert.equal(
      (await editor.request(`/api/templates/${template.id}`, {
        method: "DELETE",
      })).status,
      204,
    );
    assert.deepEqual(
      (await (await editor.request("/api/templates")).json()).map(
        (item: { id: string }) => item.id,
      ),
      ["understanding-brief"],
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
    assert.equal(starterBody.draft, "\n");
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
    assert.equal(
      tracedConcept.activity.some(
        (event: { action: string }) => event.action === "concept.published",
      ),
      true,
    );
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
    const briefResponse = await editor.request(
      "/api/v1/actions/documents.create",
      {
        method: "POST",
        body: JSON.stringify({
          title: "Payment retry explainer",
          type: "Explanation",
          intent: "working",
          spaceId: "policies",
          templateId: "understanding-brief",
        }),
      },
    );
    const briefText = await briefResponse.text();
    assert.equal(briefResponse.status, 200, briefText);
    const brief = JSON.parse(briefText).result;
    assert.equal(brief.intent, "working");
    assert.match(brief.draft, /## Mental model/);
    assert.match(brief.draft, /## Check your understanding/);
    const traceResponse = await editor.request(
      "/api/v1/actions/documents.trace.create",
      {
        method: "POST",
        body: JSON.stringify({
          documentId: brief.id,
          kind: "change",
          title: "Explain payment retry change",
          summary: "Captured the background, invariants, and evidence.",
          occurredAt: "2026-08-15",
          sourceUrl: "https://github.com/acme/payments/pull/42",
        }),
      },
    );
    const traceText = await traceResponse.text();
    assert.equal(traceResponse.status, 200, traceText);
    assert.equal(JSON.parse(traceText).result.workTraces.length, 1);
    const starterBundle = `okf-bundle-v1:${
      JSON.stringify({
        entry: "index.html",
        files: [
          {
            path: "index.html",
            type: "text/html",
            data: `data:text/html;base64,${
              btoa(
                '<h1>First-week checklist</h1><script src="app.js"></script>',
              )
            }`,
          },
          {
            path: "app.js",
            type: "text/javascript",
            data: `data:text/javascript;base64,${
              btoa("document.body.dataset.ready='yes'")
            }`,
          },
        ],
      })
    }`;
    const starterArtifact = await editor.request("/api/artifacts", {
      method: "POST",
      body: JSON.stringify({
        conceptId: "new-starter-guide",
        title: "First-week checklist",
        type: "inline_html",
        content: starterBundle,
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
    const bundledIndex = await viewer.request(
      `/api/apps/${starterArtifactId}/files/`,
    );
    assert.equal(bundledIndex.status, 200);
    assert.match(await bundledIndex.text(), /connect-src 'none'/);
    assert.equal(
      await (await viewer.request(
        `/api/apps/${starterArtifactId}/files/app.js`,
      )).text(),
      "document.body.dataset.ready='yes'",
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
    const renamedSpace = await editor.request("/api/spaces/onboarding", {
      method: "PUT",
      body: JSON.stringify({ name: "People onboarding", icon: "📘" }),
    });
    assert.equal(renamedSpace.status, 200);
    assert.equal((await renamedSpace.json()).icon, "📘");
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
    assert.equal(
      (await (await viewer.request(
        "/api/imported?path=operations.md",
      )).json()).importedAt,
      updatedImported.importedAt,
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
      ["notion", "repository", secondRepositoryBody.id, "shared"].sort(),
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

    const githubConfig = await (await owner.request("/api/sources/github"))
      .json();
    assert.equal(githubConfig.configured, true);
    assert.equal(
      githubConfig.installUrl,
      "https://github.com/apps/okf-hub/installations/new",
    );
    assert.equal(
      (await editor.request(
        "/api/sources/github/repositories?installationId=9",
      )).status,
      403,
    );
    assert.deepEqual(
      (await (await owner.request(
        "/api/sources/github/folders?installationId=9&repositoryId=77",
      )).json()).folders,
      [".", "okf"],
    );
    const githubConnected = await owner.request("/api/sources/github", {
      method: "POST",
      body: JSON.stringify({
        installationId: 9,
        repositoryId: 77,
        folder: "okf",
      }),
    });
    const githubConnectedText = await githubConnected.text();
    assert.equal(githubConnected.status, 201, githubConnectedText);
    const githubSource = JSON.parse(githubConnectedText);
    assert.equal(githubSource.kind, "github");
    assert.equal(githubSource.githubFullName, "acme/knowledge");
    assert.equal(githubSource.syncs[0].trigger, "connect");
    assert.deepEqual(repositoryCredentials, {
      username: "x-access-token",
      token: "installation-token",
    });
    const webhookPayload = JSON.stringify({
      installation: { id: 9 },
      repository: { id: 77 },
    });
    const webhook = await fetch(`${base}/api/webhooks/github`, {
      method: "POST",
      headers: {
        "x-github-delivery": "delivery-1",
        "x-github-event": "push",
        "x-hub-signature-256": "valid-signature",
      },
      body: webhookPayload,
    });
    assert.equal(webhook.status, 202, await webhook.text());
    await new Promise((resolve) => setTimeout(resolve, 10));
    const githubRefreshed = (await (await owner.request("/api/sources")).json())
      .repositories.find((source: { id: string }) =>
        source.id === githubSource.id
      );
    assert.equal(githubRefreshed.syncs[0].trigger, "webhook");
    assert.equal(
      (await fetch(`${base}/api/webhooks/github`, {
        method: "POST",
        headers: {
          "x-github-delivery": "delivery-1",
          "x-github-event": "push",
          "x-hub-signature-256": "valid-signature",
        },
        body: webhookPayload,
      })).status,
      202,
    );
    assert.equal(
      (await fetch(`${base}/api/webhooks/github`, {
        method: "POST",
        headers: {
          "x-github-delivery": "delivery-2",
          "x-github-event": "push",
          "x-hub-signature-256": "wrong",
        },
        body: webhookPayload,
      })).status,
      401,
    );

    const audit = await (await owner.request("/api/audit")).json();
    assert.deepEqual(
      audit.map((event: { action: string }) => event.action).sort(),
      [
        "ai.asked",
        "ai.asked",
        "ai.asked",
        "api_key.created",
        "api_key.revoked",
        "app.activated",
        "app.created",
        "artifact.created",
        "artifact.created",
        "artifact.created",
        "artifact.published",
        "artifact.published",
        "artifact.published",
        "artifact.published",
        "artifact.revised",
        "comment.created",
        "comment.reopened",
        "comment.replied",
        "comment.resolved",
        "concept.archived",
        "concept.archived",
        "concept.created",
        "concept.created",
        "concept.created",
        "concept.exported",
        "concept.locked",
        "concept.moved",
        "concept.moved",
        "concept.published",
        "concept.published",
        "concept.published",
        "concept.published",
        "concept.published",
        "concept.restored",
        "concept.restored",
        "concept.unlocked",
        "concept.updated",
        "group.created",
        "invitation.accepted",
        "invitation.accepted",
        "invitation.created",
        "invitation.created",
        "space.created",
        "space.deleted",
        "space.renamed",
        "template.created",
        "template.deleted",
        "trace.created",
        "trace.created",
        "trace.folded",
      ],
    );
    const renamedNested = await editor.request(
      "/api/concepts/support-welcome/metadata",
      {
        method: "PUT",
        body: JSON.stringify({
          title: "Renamed support welcome",
          type: "Guide",
          spaceId: "policies",
        }),
      },
    );
    const renamedNestedBody = await renamedNested.json();
    assert.equal(renamedNested.status, 200);
    assert.equal(renamedNestedBody.parentId, "incident-communication");
    assert.equal(
      (await editor.request("/api/exports/workspace")).status,
      404,
    );
    assert.equal(
      (await viewer.request("/api/exports/spaces/policies")).status,
      404,
    );
    const spaceExport = await editor.request(
      "/api/exports/spaces/policies",
    );
    assert.equal(spaceExport.status, 200, await spaceExport.clone().text());
    assert.match(
      spaceExport.headers.get("content-disposition") ?? "",
      /^attachment; filename="okf-policies-\d{4}-\d{2}-\d{2}\.zip"$/,
    );
    const exportedFiles = await archiveEntries(spaceExport);
    assert.ok(
      exportedFiles.has(
        "okf/Policies/Incident communication/Renamed support welcome.md",
      ),
    );
    assert.match(
      new TextDecoder().decode(exportedFiles.get("okf/index.md")),
      /^---\nokf_version: "0\.2"\n---\n\n# Spaces\n/,
    );
    for (const [path, content] of exportedFiles) {
      if (
        path.startsWith("okf/") && path.endsWith(".md") &&
        !path.endsWith("/index.md") && !path.endsWith("/log.md")
      ) {
        await inspectOkf(path, new TextDecoder().decode(content));
      }
    }
    assert.equal(
      new TextDecoder().decode(
        exportedFiles.get(
          "apps/Policies/Employee onboarding/First-week checklist/app.js",
        ),
      ),
      "document.body.dataset.ready='yes'",
    );
    const workspaceExport = await owner.request("/api/exports/workspace");
    assert.equal(
      workspaceExport.status,
      200,
      await workspaceExport.clone().text(),
    );
    assert.match(
      workspaceExport.headers.get("content-disposition") ?? "",
      /^attachment; filename="okf-workspace-\d{4}-\d{2}-\d{2}\.zip"$/,
    );
  } finally {
    await server.shutdown();
    await app.close();
    await fga.server.shutdown();
    await Deno.remove(dataDir, { recursive: true });
  }
});
