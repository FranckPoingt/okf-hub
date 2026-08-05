/// <reference lib="deno.ns" />

import assert from "node:assert/strict";
import { createCollabApp, DEFAULT_MARKDOWN } from "./main.ts";

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
      tuples.push(...body.writes.tuple_keys);
      return new Response(null, { status: 204 });
    }
    if (url.pathname.endsWith("/check")) {
      const { user, relation } = body.tuple_key;
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
      const viewer = tuples.some((tuple) =>
        tuple.relation === "viewer" && tuple.object === "space:policies" &&
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
  const imported = (
    path: string,
    title: string,
    content: string,
    hash: string,
  ) => ({
    path,
    title,
    type: "Runbook",
    markdown: `---\n${
      path === "operations.md" ? '"type"' : "type"
    }: Runbook\ntitle: ${title}\n---\n\n${content}`,
    body: content,
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
    },
    repositorySync() {
      repositorySyncs++;
      if (repositorySyncs === 3) {
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

    const connected = await owner.request("/api/sources/repository", {
      method: "POST",
      body: JSON.stringify({
        repositoryUrl: "https://example.com/company/knowledge.git",
        folder: "okf",
      }),
    });
    if (!connected.ok) assert.fail(await connected.text());
    const firstSource = await connected.json();
    assert.equal(firstSource.status, "current");
    assert.equal(firstSource.revision, "commit-one");
    assert.equal(firstSource.conceptCount, 3);
    assert.deepEqual(firstSource.issues, [{
      path: "broken.md",
      status: "invalid",
      error: "Missing YAML frontmatter",
      nextPath: null,
    }]);
    assert.equal(
      (await editor.request("/api/sources/repository/refresh", {
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
        path: "operations.md",
        title: "Operations",
        type: "Runbook",
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
      "/api/sources/repository/refresh",
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
      "/api/sources/repository/refresh",
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
    assert.deepEqual(
      await (await outsider.request("/api/concepts")).json(),
      [],
    );
    assert.equal(fga.modelReceived(), true);
    assert.equal(
      fga.tuples.filter((tuple) => tuple.relation === "member").length,
      2,
    );

    const audit = await (await owner.request("/api/audit")).json();
    assert.deepEqual(
      audit.map((event: { action: string }) => event.action).sort(),
      [
        "invitation.accepted",
        "invitation.accepted",
        "invitation.created",
        "invitation.created",
        "organization.created",
      ],
    );
  } finally {
    await server.shutdown();
    await app.close();
    await fga.server.shutdown();
    await Deno.remove(dataDir, { recursive: true });
  }
});
