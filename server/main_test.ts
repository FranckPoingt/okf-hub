/// <reference lib="deno.ns" />

import assert from "node:assert/strict";
import { extensionFields } from "./document-frontmatter.ts";
import { DatabaseSync } from "node:sqlite";
import * as Y from "yjs";
import type { AIRequest } from "./ai.ts";
import {
  createCollabApp,
  DEFAULT_MARKDOWN,
  searchSnippet,
  uniqueArchiveNames,
} from "./main.ts";
import { inspectOkf, type RepositoryCredentials } from "./repository-source.ts";
import { parseSSOConfig } from "./sso-config.ts";
import { pullArtifact } from "../scripts/pull-artifact.ts";
import { saveArtifact } from "../scripts/save-artifact.ts";

type Tuple = { user: string; relation: string; object: string };

function fakeOpenFga(deny = (_tuple: Tuple) => false) {
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
      const manager = Boolean(viewedSpace) &&
        has({ user, relation: "manager", object: viewedSpace });
      return Response.json({
        allowed: !deny({ user, relation, object }) &&
          (relation === "manage"
            ? manager
            : owner || editor || manager || (relation === "view" && viewer)),
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

Deno.test("search snippets keep link labels and drop link targets", () => {
  assert.equal(
    searchSnippet(
      "See the [codename](okf://repo/launch-codename.md) and ![chart](a.png).",
      "",
      "Plan",
      [],
    ),
    "See the codename and chart.",
  );
});

Deno.test("saves, revises, discovers, and exports a Codex artifact with its context", async () => {
  const dataDir = await Deno.makeTempDir();
  const folder = `${dataDir}/artifact`;
  await Deno.mkdir(folder);
  const source = new URL("../examples/sovereign-artifact/", import.meta.url);
  const originalHTML = await Deno.readTextFile(new URL("index.html", source));
  const originalContext = (await Deno.readTextFile(
    new URL("context.md", source),
  )).replace(
    "---\n",
    '---\nsources: [{ id: hub-design, resource: "https://example.com/design", title: "Design: evidence" }]\ncustom_provenance: { team: "Research: North", retained: true }\n',
  );
  await Deno.writeTextFile(`${folder}/index.html`, originalHTML);
  await Deno.writeTextFile(`${folder}/context.md`, originalContext);
  const fga = fakeOpenFga();
  const objects = new Map<string, string>();
  const app = await createCollabApp({
    dataDir,
    authSecret: "artifact-dogfood-test-secret-at-least-32-characters",
    openfgaURL: `http://127.0.0.1:${(fga.server.addr as Deno.NetAddr).port}`,
    objectStore: {
      put(key, markdown) {
        objects.set(key, markdown);
        return Promise.resolve();
      },
      get(key) {
        return objects.has(key)
          ? Promise.resolve(objects.get(key)!)
          : Promise.reject(new Error("Object not found"));
      },
      remove(key) {
        objects.delete(key);
        return Promise.resolve();
      },
    },
    automationIntervalMs: 0,
  });
  const server = Deno.serve(
    { hostname: "127.0.0.1", port: 0, onListen() {} },
    app.fetch,
  );
  const base = `http://127.0.0.1:${(server.addr as Deno.NetAddr).port}`;
  const owner = new Client(base);
  const viewer = new Client(base);
  const previousToken = Deno.env.get("OKF_HUB_TOKEN");
  try {
    await owner.signUp("Dogfood owner", "artifact-owner@example.com");
    const setup = await owner.request("/api/setup", {
      method: "POST",
      body: JSON.stringify({
        name: "Artifact dogfood",
        tagline: "Knowledge from work",
      }),
    });
    assert.equal(setup.status, 200, await setup.text());
    const invitation = await owner.request("/api/invitations", {
      method: "POST",
      body: JSON.stringify({
        email: "artifact-reader@example.com",
        access: "viewer",
      }),
    });
    const invitationId = (await invitation.json()).id;
    await viewer.signUp(
      "Dogfood reader",
      "artifact-reader@example.com",
      invitationId,
    );
    assert.equal(
      (await viewer.request("/api/invitations/accept", {
        method: "POST",
        body: JSON.stringify({ invitationId }),
      })).status,
      200,
    );
    const key = await owner.request("/api/developer/keys", {
      method: "POST",
      body: JSON.stringify({
        name: "Codex artifact test",
        scopes: [
          "artifact.save",
          "spaces.list",
          "documents.create",
          "documents.get",
          "documents.update-draft",
          "documents.publish",
          "documents.trace.create",
          "apps.list",
          "apps.create",
          "apps.revise",
          "apps.activate",
        ],
      }),
    });
    assert.equal(key.status, 201);
    Deno.env.set("OKF_HUB_TOKEN", (await key.json()).token);
    const options = {
      folder,
      hubUrl: base,
      spaceId: "policies",
      title: "OKF Hub product direction",
    };
    const first = await saveArtifact({ ...options, publish: true });
    assert.equal(first.version, 1);
    assert.equal(first.published, true);
    assert.equal(first.documentUrl, `${base}/knowledge/${first.documentId}`);
    const unchanged = await saveArtifact({ ...options, publish: true });
    assert.equal(unchanged.documentId, first.documentId);
    assert.equal(unchanged.appId, first.appId);
    assert.equal(unchanged.version, 1);
    const initialDocument =
      await (await owner.request(`/api/concepts/${first.documentId}`)).json();
    assert.equal(initialDocument.intent, "working");
    assert.equal(initialDocument.workTraces.length, 1);
    assert.equal(initialDocument.revisions.length, 1);
    const discovered = await (await viewer.request(
      "/api/search?q=OKF%20Hub%20product%20direction",
    )).json();
    assert.ok(
      discovered.results.some((item: { id: string }) =>
        item.id === first.documentId
      ),
    );
    const filePath = `/api/apps/${first.appId}/files/index.html`;
    const liveHTML = await viewer.request(filePath);
    assert.equal(liveHTML.status, 200);
    assert.ok((await liveHTML.text()).includes("okf-artifact-loop"));

    const revisedHTML = originalHTML.replace(
      "</body>",
      '<span hidden data-dogfood-revision="2"></span></body>',
    );
    const revisedContext =
      `${originalContext.trimEnd()}\n\n## Dogfood revision\n\nThe second version preserves the same shared link.\n`;
    assert.notEqual(revisedHTML, originalHTML);
    await Deno.writeTextFile(`${folder}/index.html`, revisedHTML);
    await Deno.writeTextFile(`${folder}/context.md`, revisedContext);
    const draft = await saveArtifact(options);
    assert.equal(draft.appId, first.appId);
    assert.equal(draft.documentId, first.documentId);
    assert.equal(draft.version, 2);
    assert.equal(draft.published, false);
    assert.ok(
      !(await (await viewer.request(filePath)).text()).includes(
        'data-dogfood-revision="2"',
      ),
    );
    assert.ok(
      (await (await owner.request(filePath)).text()).includes(
        'data-dogfood-revision="2"',
      ),
    );
    // Editors preview the activated version through a live-pinned capability.
    const appHTML = async (client: Client, live?: boolean) => {
      const minted = await client.request(
        `/api/apps/${first.appId}/capability`,
        { method: "POST", body: JSON.stringify({ live }) },
      );
      return await (await fetch(`${base}${(await minted.json()).url}`, {
        headers: { origin: "null" },
      })).text();
    };
    assert.ok(
      (await appHTML(owner)).includes('data-dogfood-revision="2"'),
    );
    assert.ok(
      !(await appHTML(owner, true)).includes('data-dogfood-revision="2"'),
    );
    assert.ok(
      !(await appHTML(viewer)).includes('data-dogfood-revision="2"'),
    );
    const draftDocument =
      await (await owner.request(`/api/concepts/${first.documentId}`)).json();
    assert.equal(draftDocument.publishedRevision, 1);
    assert.equal(draftDocument.workTraces.length, 2);
    assert.equal(
      draftDocument.artifactMeta.description,
      "OKF Hub product direction",
    );
    const activated = await saveArtifact({ ...options, publish: true });
    assert.equal(activated.version, 2);
    assert.ok(
      (await (await viewer.request(filePath)).text()).includes(
        'data-dogfood-revision="2"',
      ),
    );
    const publishedDocument =
      await (await viewer.request(`/api/concepts/${first.documentId}`)).json();
    assert.equal(publishedDocument.publishedRevision, 2);
    assert.equal(
      publishedDocument.artifactMeta.description,
      "OKF Hub product direction",
    );
    assert.ok(
      publishedDocument.published.includes(
        "The second version preserves the same shared link.",
      ),
    );
    const spaceCreate = await owner.request("/api/spaces", {
      method: "POST",
      body: JSON.stringify({ name: "Onboarding" }),
    });
    assert.equal(spaceCreate.status, 201);
    const onboardingSpace = await spaceCreate.json();
    const draftOnlyCreate = await owner.request("/api/concepts", {
      method: "POST",
      body: JSON.stringify({
        title: "Draft ROI calculator",
        type: "Artifact",
        intent: "working",
        spaceId: onboardingSpace.id,
      }),
    });
    assert.equal(draftOnlyCreate.status, 201);
    const draftOnly = await draftOnlyCreate.json();
    assert.equal(
      (await owner.request(`/api/concepts/${draftOnly.id}`, {
        method: "PUT",
        body: [
          "---",
          "description: Draft-only margin calculator for finance review.",
          "owner: Finance team",
          "status: draft",
          "sources:",
          `  - /knowledge/${first.documentId}`,
          "  - https://example.com/finance-model",
          "---",
          "",
          "# Draft ROI calculator",
          "",
          "Context body.",
          "",
        ].join("\n"),
      })).status,
      204,
    );
    const draftOnlyPayload =
      await (await owner.request(`/api/concepts/${draftOnly.id}`)).json();
    assert.equal(
      draftOnlyPayload.artifactMeta.description,
      "Draft-only margin calculator for finance review.",
    );
    assert.equal(draftOnlyPayload.artifactMeta.sources.length, 2);
    assert.equal(
      draftOnlyPayload.artifactMeta.sources[0].conceptId,
      first.documentId,
    );

    assert.equal((await fetch(`${base}/api/artifact-gallery`)).status, 401);
    const ownerGallery = await (await owner.request("/api/artifact-gallery"))
      .json();
    assert.equal(ownerGallery.artifacts.length, 2);
    const ownerOnboardingGallery = await (await owner.request(
      `/api/artifact-gallery?spaceId=${onboardingSpace.id}`,
    )).json();
    assert.equal(ownerOnboardingGallery.artifacts.length, 1);
    assert.equal(ownerOnboardingGallery.artifacts[0].id, draftOnly.id);
    assert.equal(
      ownerOnboardingGallery.artifacts[0].description,
      "Draft-only margin calculator for finance review.",
    );
    // The responsible owner comes from governance, not the `owner:` key.
    assert.equal(ownerOnboardingGallery.artifacts[0].owner, "Dogfood owner");
    assert.equal(ownerOnboardingGallery.artifacts[0].trust, "current");
    assert.ok(ownerOnboardingGallery.artifacts[0].freshness);

    const viewerGallery = await (await viewer.request("/api/artifact-gallery"))
      .json();
    assert.deepEqual(
      viewerGallery.artifacts.map((item: { id: string }) => item.id),
      [first.documentId],
    );
    assert.equal(
      viewerGallery.artifacts[0].description,
      "OKF Hub product direction",
    );
    assert.equal(viewerGallery.artifacts[0].liveVersion, 2);
    const viewerPoliciesGallery = await (await viewer.request(
      "/api/artifact-gallery?spaceId=policies",
    )).json();
    assert.equal(viewerPoliciesGallery.artifacts.length, 1);
    const viewerOnboardingGallery = await (await viewer.request(
      `/api/artifact-gallery?spaceId=${onboardingSpace.id}`,
    )).json();
    assert.equal(viewerOnboardingGallery.artifacts.length, 0);

    const appState =
      await (await owner.request(`/api/apps?conceptId=${first.documentId}`))
        .json();
    assert.equal(appState.apps.length, 1);
    assert.deepEqual(appState.apps[0].grants, []);
    assert.equal(appState.apps[0].versions.length, 2);

    const archive = await owner.request("/api/exports/spaces/policies");
    assert.equal(archive.status, 200);
    const exported = await archiveEntries(archive);
    const decoder = new TextDecoder();
    const exportedIndex = [...exported].find(([path]) =>
      path.startsWith("apps/") && path.endsWith("/index.html")
    );
    const exportedContext = [...exported].find(([path]) =>
      path.startsWith("apps/") && path.endsWith("/context.md")
    );
    assert.ok(exportedIndex && exportedContext);
    assert.equal(decoder.decode(exportedIndex[1]), revisedHTML);
    assert.equal(decoder.decode(exportedContext[1]), revisedContext);
    assert.ok(
      ![...exported.keys()].some((path) => path.includes(".okf-artifact")),
    );
    const knowledge = [...exported].find(([path]) =>
      path.startsWith("okf/") && path.endsWith("/OKF Hub product direction.md")
    );
    assert.ok(knowledge);
    await inspectOkf(knowledge[0], decoder.decode(knowledge[1]));
    const expectedFields = extensionFields(revisedContext)!;
    assert.ok(expectedFields.sources);
    assert.deepEqual(
      extensionFields(decoder.decode(knowledge[1])),
      expectedFields,
    );
    const publishedMarkdown = [...objects.values()].findLast((markdown) =>
      markdown.includes("The second version preserves the same shared link.")
    )!;
    assert.deepEqual(extensionFields(publishedMarkdown), expectedFields);
    await inspectOkf("artifact.md", publishedMarkdown);
    // Metadata-only citation edits preserve unknown fields and trigger a revision.
    const metadata = {
      title: publishedDocument.title,
      type: publishedDocument.type,
      spaceId: publishedDocument.spaceId,
      sources: ["/knowledge/incident-communication"],
    };
    const edited = await owner.request(
      `/api/concepts/${first.documentId}/metadata`,
      { method: "PUT", body: JSON.stringify(metadata) },
    );
    assert.equal(edited.status, 200);
    assert.deepEqual((await edited.json()).sources, metadata.sources);
    const republished = await owner.request(
      `/api/concepts/${first.documentId}/publish`,
      { method: "POST" },
    );
    assert.equal(republished.status, 200);
    assert.equal((await republished.json()).publishedRevision, 3);
    const updatedPublished = [...objects.values()].findLast((markdown) =>
      markdown.includes("The second version preserves the same shared link.")
    )!;
    assert.deepEqual(extensionFields(updatedPublished), {
      ...expectedFields,
      sources: metadata.sources,
    });

    const receipt = await Deno.readTextFile(`${folder}/.okf-artifact.json`);
    assert.ok(!receipt.includes(Deno.env.get("OKF_HUB_TOKEN")!));
    const mcp = async (
      name: string,
      args: Record<string, unknown>,
      token = Deno.env.get("OKF_HUB_TOKEN")!,
    ) => {
      const response = await fetch(`${base}/api/mcp`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name, arguments: args },
        }),
      });
      assert.equal(response.status, 200);
      return await response.json();
    };
    const files = {
      "index.html": "<h1>MCP artifact</h1>",
      "context.md": "# MCP artifact\n\nSources and assumptions.",
    };
    const saved = await mcp("artifact.save", { spaceId: "policies", files });
    assert.equal(saved.result.isError, undefined, JSON.stringify(saved));
    const savedArtifact = JSON.parse(saved.result.content[0].text);
    assert.equal(savedArtifact.published, false);
    const untitled = await mcp("artifact.save", {
      spaceId: "policies",
      files: { ...files, "context.md": "Sources and assumptions." },
    });
    assert.equal(untitled.result.isError, true);
    assert.match(untitled.result.content[0].text, /# Title/);
    const fromFrontmatter = await mcp("artifact.save", {
      spaceId: "policies",
      files: {
        ...files,
        "context.md": '---\ntitle: "Frontmatter name"\n---\nSources.',
      },
    });
    assert.equal(
      JSON.parse(
        (await mcp("documents.get", {
          id: JSON.parse(fromFrontmatter.result.content[0].text).documentId,
        })).result.content[0].text,
      ).title,
      "Frontmatter name",
    );
    const same = await mcp("artifact.save", {
      files,
      receipt: savedArtifact.receipt,
    });
    assert.equal(
      JSON.parse(same.result.content[0].text).appId,
      savedArtifact.appId,
    );
    assert.equal(JSON.parse(same.result.content[0].text).version, 1);
    const revised = await mcp("artifact.save", {
      files: { ...files, "index.html": "<h1>Revised</h1>" },
      receipt: savedArtifact.receipt,
    });
    assert.equal(JSON.parse(revised.result.content[0].text).version, 2);
    const read = await mcp("documents.get", { id: savedArtifact.documentId });
    const concept = JSON.parse(read.result.content[0].text);
    assert.equal(concept.trust, "current");
    assert.equal(concept.sourceId, "hub");
    assert.equal(concept.owner, "Dogfood owner");
    assert.equal(concept.workTraces.length, 2);
    const readerKeyResponse = await viewer.request("/api/developer/keys", {
      method: "POST",
      body: JSON.stringify({ name: "MCP reader", scopes: ["*"] }),
    });
    const readerKey = await readerKeyResponse.json();
    assert.equal(readerKeyResponse.status, 201);
    const hidden = await mcp(
      "documents.get",
      { id: savedArtifact.documentId },
      readerKey.token,
    );
    assert.equal(hidden.result.isError, true);
    const forbiddenSave = await mcp("artifact.save", {
      spaceId: "policies",
      files,
    }, readerKey.token);
    assert.equal(forbiddenSave.result.isError, true);
    const uploadPath = "/api/artifact-uploads?spaceId=policies&name=chart.html";
    assert.equal(
      (await viewer.request(uploadPath, {
        method: "POST",
        body: "<h1>Chart</h1>",
      })).status,
      403,
    );
    assert.equal(
      (await fetch(`${base}${uploadPath}`, {
        method: "POST",
        body: "<h1>Chart</h1>",
      })).status,
      401,
    );
    const beforeUpload = await (await owner.request("/api/concepts")).json();
    const rejected = await owner.request(
      uploadPath + "&title=Bad&description=Bad",
      {
        method: "POST",
        body: '<script src="https://unpkg.com/react"></script>',
      },
    );
    assert.equal(rejected.status, 400);
    assert.match((await rejected.json()).error, /--vendor/);
    assert.equal(
      (await (await owner.request("/api/concepts")).json()).length,
      beforeUpload.length,
    );
    assert.equal(
      (await (await owner.request(uploadPath, {
        method: "POST",
        body: "<h1>Chart</h1>",
      })).json()).needsContext,
      true,
    );
    const uploaded = await owner.request(
      uploadPath + "&title=Uploaded%20chart&description=Company%20chart",
      { method: "POST", body: "<h1>Chart</h1>" },
    );
    assert.equal(uploaded.status, 201, await uploaded.clone().text());
    const uploadedIds = await uploaded.json();
    const uploadedDocument =
      await (await owner.request(`/api/concepts/${uploadedIds.documentId}`))
        .json();
    assert.equal(uploadedDocument.type, "Artifact");
    assert.match(uploadedDocument.draft, /Company chart/);
    const uploadedApps = await (await owner.request(
      `/api/apps?conceptId=${uploadedIds.documentId}`,
    )).json();
    assert.equal(uploadedApps.apps[0].status, "draft");
    assert.deepEqual(uploadedApps.apps[0].grants, []);
    assert.match(uploadedApps.apps[0].content, /context.md/);
  } finally {
    if (previousToken === undefined) Deno.env.delete("OKF_HUB_TOKEN");
    else Deno.env.set("OKF_HUB_TOKEN", previousToken);
    await server.shutdown();
    await app.close();
    await fga.server.shutdown();
    await Deno.remove(dataDir, { recursive: true });
  }
});

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
    // A reload without ?invitation= still finds the invitation issued to this email.
    const pending = await (await editor.request("/api/bootstrap")).json();
    assert.equal(pending.invitationRequired, true);
    assert.equal(
      (await editor.request("/api/invitations/accept", {
        method: "POST",
        body: JSON.stringify({}),
      })).status,
      200,
    );
    const owned = await (await owner.request("/api/bootstrap")).json();
    assert.ok(
      !owned.invitations.some((item: { invitationId: string }) =>
        item.invitationId === editorInvitation
      ),
      "accepted invitations leave the pending list",
    );
    assert.ok(
      owned.invitations.some((item: { invitationId: string }) =>
        item.invitationId === viewerInvitation
      ),
    );
    assert.equal(
      (await viewer.request("/api/invitations/accept", {
        method: "POST",
        body: JSON.stringify({ invitationId: viewerInvitation }),
      })).status,
      200,
    );
    for (
      const path of [
        "/api/sources/repositories/repository/okf-draft",
        "/api/sources/repositories/repository/okf-draft/approve",
      ]
    ) {
      // Existing connected source IDs are checked below after connection; the
      // unauthenticated boundary applies regardless of source existence.
      const response = await fetch(`${base}${path}`, { method: "POST" });
      assert.equal(response.status, 401);
      await response.body?.cancel();
    }
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
    const restrictedAsk = await outsider.request("/api/ai/chat", {
      method: "POST",
      body: JSON.stringify({
        scope: "workspace",
        messages: [{ role: "user", content: "incident communication" }],
      }),
    });
    assert.equal(restrictedAsk.status, 200);
    assert.deepEqual((await restrictedAsk.json()).citations, []);
    assert.ok(!aiRequests.at(-1)?.document.markdown.includes("Still clean"));
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
      /^---\ntype: Policy\ntitle: "Incident communication"\nid: "incident-communication"\nstatus: stable\ngenerated: \{ by: "human:[^"]+", at: "[^"]+" \}\nintent: canonical\n---\n\n# First published draft\n$/,
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
    const workspaceAsk = await viewer.request("/api/ai/chat", {
      method: "POST",
      body: JSON.stringify({
        scope: "workspace",
        messages: [{ role: "user", content: "incident communication" }],
      }),
    });
    assert.equal(workspaceAsk.status, 200);
    const workspaceAnswer = await workspaceAsk.json();
    assert.equal(
      workspaceAnswer.citations[0].documentId,
      "incident-communication",
    );
    assert.equal(
      workspaceAnswer.citations[0].url,
      "/knowledge/incident-communication",
    );
    assert.match(aiRequests.at(-1)!.document.markdown, /First published draft/);
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
        "documents.publish",
        "spaces.list",
      ]
        .filter((name) =>
          !actionList.actions.some((action: { name: string }) =>
            action.name === name
          )
        ),
      [],
    );
    const actionSpaces = await owner.request("/api/v1/actions/spaces.list", {
      method: "POST",
      body: "{}",
    });
    assert.equal(actionSpaces.status, 200);
    assert.deepEqual(
      (await actionSpaces.json()).result,
      await (await owner.request("/api/spaces")).json(),
    );
    assert.deepEqual(
      (await (await outsider.request("/api/v1/actions/spaces.list", {
        method: "POST",
        body: "{}",
      })).json()).result,
      [],
    );
    assert.equal(
      (await viewer.request("/api/v1/actions/documents.publish", {
        method: "POST",
        body: JSON.stringify({ id: "incident-communication" }),
      })).status,
      403,
    );
    assert.equal(
      (await outsider.request("/api/v1/actions/documents.publish", {
        method: "POST",
        body: JSON.stringify({ id: "incident-communication" }),
      })).status,
      404,
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
    for (
      const [name, input] of [
        ["spaces.list", {}],
        ["documents.publish", { id: "incident-communication" }],
      ] as const
    ) {
      assert.equal(
        (await fetch(`${base}/api/v1/actions/${name}`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${apiKey.token}`,
            "content-type": "application/json",
          },
          body: JSON.stringify(input),
        })).status,
        404,
      );
    }
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
    for (const suffix of ["", "/approve"]) {
      const denied = await viewer.request(
        `/api/sources/repositories/repository/okf-draft${suffix}`,
        { method: "POST", body: "{}" },
      );
      assert.equal(denied.status, 403);
      await denied.body?.cancel();
    }
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
        describes: [],
        describedOwners: [],
        stale: null,
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
    const importedKeyResponse = await viewer.request("/api/developer/keys", {
      method: "POST",
      body: JSON.stringify({
        name: "Read imported with MCP",
        scopes: ["documents.get"],
      }),
    });
    const importedKey = await importedKeyResponse.json();
    assert.equal(importedKeyResponse.status, 201);
    const importedViaMcp = await fetch(`${base}/api/mcp`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${importedKey.token}`,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "import",
        method: "tools/call",
        params: {
          name: "documents.get",
          arguments: { id: "repository/operations" },
        },
      }),
    });
    const importedRpc = await importedViaMcp.json();
    assert.equal(
      importedRpc.result.isError,
      undefined,
      JSON.stringify(importedRpc),
    );
    const importedRead = JSON.parse(importedRpc.result.content[0].text);
    assert.equal(importedRead.owner, "Platform");
    assert.equal(importedRead.sourceRevision, "commit-one");
    assert.equal(importedRead.trust, "current");
    assert.equal(importedRead.markdown, "# Operations v1\n");
    assert.equal(importedRead.source.id, "repository");

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
    // Signed PR deliveries update only proposals in the matching installation/repository.
    const proposalDb = new DatabaseSync(`${dataDir}/hub.db`);
    proposalDb.prepare(
      `INSERT INTO okf_change_proposal VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .run(
        "webhook-proposal",
        githubSource.id,
        "test-concept",
        "test-user",
        "https://github.com/acme/knowledge/pull/7",
        7,
        "open",
        new Date().toISOString(),
      );
    const sendPR = (
      delivery: string,
      action: string,
      merged = false,
      signature = "valid-signature",
      repositoryId = 77,
    ) =>
      fetch(`${base}/api/webhooks/github`, {
        method: "POST",
        headers: {
          "x-github-delivery": delivery,
          "x-github-event": "pull_request",
          ...(signature ? { "x-hub-signature-256": signature } : {}),
        },
        body: JSON.stringify({
          installation: { id: 9 },
          repository: { id: repositoryId },
          action,
          pull_request: { number: 7, merged },
        }),
      });
    const proposalStatus = () =>
      proposalDb.prepare(
        "SELECT status FROM okf_change_proposal WHERE id = 'webhook-proposal'",
      ).get()!.status;
    assert.equal(
      (await sendPR("pr-unsigned", "closed", false, "")).status,
      401,
    );
    assert.equal(proposalStatus(), "open");
    assert.equal(
      (await sendPR("pr-other-repo", "closed", false, "valid-signature", 78))
        .status,
      202,
    );
    assert.equal(proposalStatus(), "open");
    assert.equal((await sendPR("pr-close", "closed")).status, 202);
    assert.equal(proposalStatus(), "closed");
    assert.equal((await sendPR("pr-reopen", "reopened")).status, 202);
    assert.equal(proposalStatus(), "open");
    assert.equal((await sendPR("pr-merge", "closed", true)).status, 202);
    assert.equal(proposalStatus(), "merged");
    assert.equal(
      (await (await sendPR("pr-reopen", "reopened")).json()).duplicate,
      true,
    );
    assert.equal(proposalStatus(), "merged");
    proposalDb.close();
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
        "ai.asked",
        "ai.asked",
        "api_key.created",
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
        "invitation.accepted",
        "invitation.accepted",
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

Deno.test("lets space managers activate Apps and reports reuse by others", async () => {
  const dataDir = await Deno.makeTempDir();
  const folder = `${dataDir}/artifact`;
  await Deno.mkdir(folder);
  await Deno.writeTextFile(
    `${folder}/index.html`,
    '<p>Reusable</p><script type="module" src="./app.js"></script>',
  );
  await Deno.writeTextFile(
    `${folder}/app.js`,
    'import { ready } from "./lib.js"; document.body.dataset.ready = ready;',
  );
  await Deno.writeTextFile(`${folder}/lib.js`, 'export const ready = "yes";');
  await Deno.writeTextFile(`${folder}/context.md`, "# Reusable\n\nContext.\n");
  await Deno.writeFile(`${folder}/data.png`, new Uint8Array([0, 255, 128, 1]));
  let revokedUserId = "";
  const fga = fakeOpenFga((tuple) => tuple.user === `user:${revokedUserId}`);
  const objects = new Map<string, string>();
  const app = await createCollabApp({
    dataDir,
    authSecret: "artifact-reuse-test-secret-at-least-32-characters",
    openfgaURL: `http://127.0.0.1:${(fga.server.addr as Deno.NetAddr).port}`,
    objectStore: {
      put(key, markdown) {
        objects.set(key, markdown);
        return Promise.resolve();
      },
      get(key) {
        return objects.has(key)
          ? Promise.resolve(objects.get(key)!)
          : Promise.reject(new Error("Object not found"));
      },
      remove(key) {
        objects.delete(key);
        return Promise.resolve();
      },
    },
    automationIntervalMs: 0,
  });
  const server = Deno.serve(
    { hostname: "127.0.0.1", port: 0, onListen() {} },
    app.fetch,
  );
  const base = `http://127.0.0.1:${(server.addr as Deno.NetAddr).port}`;
  const owner = new Client(base);
  const clients = {
    editor: new Client(base),
    manager: new Client(base),
    otherManager: new Client(base),
    viewer: new Client(base),
  };
  const previousToken = Deno.env.get("OKF_HUB_TOKEN");
  try {
    await owner.signUp("Owner", "reuse-owner@example.com");
    assert.equal(
      (await owner.request("/api/setup", {
        method: "POST",
        body: JSON.stringify({ name: "Reuse", tagline: "Reuse" }),
      })).status,
      200,
    );
    const userIds: Record<string, string> = {};
    for (const [name, client] of Object.entries(clients)) {
      const email = `reuse-${name}@example.com`;
      const invitation = await owner.request("/api/invitations", {
        method: "POST",
        body: JSON.stringify({
          email,
          access: name === "editor" ? "editor" : "viewer",
        }),
      });
      const invitationId = (await invitation.json()).id;
      await client.signUp(name, email, invitationId);
      await client.request("/api/invitations/accept", {
        method: "POST",
        body: JSON.stringify({ invitationId }),
      });
      userIds[name] =
        (await (await client.request("/api/auth/get-session")).json()).user.id;
    }
    const createSpace = async (name: string) =>
      (await (await owner.request("/api/spaces", {
        method: "POST",
        body: JSON.stringify({ name }),
      })).json()).id as string;
    const spaceA = await createSpace("Space A");
    const spaceB = await createSpace("Space B");
    const setManager = (space: string, user: string, method = "PUT") =>
      owner.request(`/api/spaces/${space}/managers/${userIds[user]}`, {
        method,
      });
    assert.equal(
      (await clients.editor.request(
        `/api/spaces/${spaceA}/managers/${userIds.manager}`,
        { method: "PUT" },
      )).status,
      403,
    );
    assert.equal((await setManager(spaceA, "manager")).status, 204);
    assert.equal((await setManager(spaceB, "otherManager")).status, 204);
    assert.deepEqual(
      await (await owner.request(`/api/spaces/${spaceA}/managers`)).json(),
      { managers: [userIds.manager] },
    );
    assert.equal(
      (await clients.manager.request(`/api/spaces/${spaceA}/managers`)).status,
      403,
    );
    assert.equal(
      (await clients.editor.request(`/api/spaces/${spaceA}/managers`)).status,
      403,
    );
    assert.equal(
      (await owner.request("/api/spaces/missing/managers")).status,
      404,
    );
    assert.equal(
      (await fetch(`${base}/api/spaces/${spaceA}/managers`)).status,
      401,
    );
    assert.equal((await setManager(spaceA, "manager", "DELETE")).status, 204);
    assert.deepEqual(
      await (await owner.request(`/api/spaces/${spaceA}/managers`)).json(),
      { managers: [] },
    );
    assert.equal((await setManager(spaceA, "manager")).status, 204);

    const document = await (await owner.request("/api/concepts", {
      method: "POST",
      body: JSON.stringify({ spaceId: spaceA, title: "Plain", type: "Guide" }),
    })).json();
    const created = await clients.editor.request("/api/apps", {
      method: "POST",
      body: JSON.stringify({
        conceptId: document.id,
        title: "Calculator",
        type: "inline_html",
        content: "<p>Hi</p>",
      }),
    });
    assert.equal(created.status, 201);
    const appId = (await created.json()).id as string;
    const activate = async (client: Client) =>
      (await client.request(`/api/apps/${appId}/activate`, { method: "POST" }))
        .status;
    const canPublish = async (client: Client) =>
      (await (await client.request(`/api/apps?conceptId=${document.id}`))
        .json()).canPublish;
    assert.equal(await activate(clients.editor), 403);
    assert.equal(await activate(clients.viewer), 404);
    assert.equal(await activate(clients.otherManager), 404);
    assert.equal(await canPublish(clients.editor), false);
    assert.equal(await canPublish(clients.manager), true);
    assert.equal(await activate(clients.manager), 200);
    assert.equal(await activate(owner), 200);
    assert.equal(await canPublish(owner), true);
    assert.equal((await setManager(spaceA, "manager", "DELETE")).status, 204);
    assert.equal(await activate(clients.manager), 404);

    // A manager of the artifact's own space is not enough elsewhere.
    assert.equal((await setManager(spaceB, "manager")).status, 204);
    assert.equal(await activate(clients.manager), 404);

    // tools/list hides mutation tools from keys whose user can edit nowhere.
    const mutationTools = async (client: Client) => {
      const created = await client.request("/api/developer/keys", {
        method: "POST",
        body: JSON.stringify({ name: "List tools", scopes: ["*"] }),
      });
      const listed = await (await fetch(`${base}/api/mcp`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${(await created.json()).token}`,
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      })).json();
      return listed.result.tools.filter((tool: {
        annotations: { readOnlyHint: boolean };
      }) => !tool.annotations.readOnlyHint).map((tool: { name: string }) =>
        tool.name
      );
    };
    assert.deepEqual(await mutationTools(clients.viewer), []);
    const canEditOf = async (client: Client) =>
      (await (await client.request("/api/v1/actions")).json()).canEdit;
    assert.equal(await canEditOf(clients.viewer), false);
    assert.equal(await canEditOf(clients.manager), true);
    assert.ok((await mutationTools(clients.manager)).includes("artifact.save"));

    const key = await owner.request("/api/developer/keys", {
      method: "POST",
      body: JSON.stringify({
        name: "Reuse test",
        scopes: [
          "artifact.get",
          "artifact.save",
          "spaces.list",
          "documents.create",
          "documents.get",
          "documents.update-draft",
          "documents.publish",
          "documents.trace.create",
          "apps.list",
          "apps.create",
          "apps.revise",
          "apps.activate",
        ],
      }),
    });
    Deno.env.set("OKF_HUB_TOKEN", (await key.json()).token);
    const saved = await saveArtifact({
      folder,
      hubUrl: base,
      spaceId: spaceA,
      title: "Reusable artifact",
      publish: true,
    });

    const action = async (
      client: Client,
      name: string,
      input: Record<string, unknown>,
    ) => {
      const response = await client.request(`/api/v1/actions/${name}`, {
        method: "POST",
        body: JSON.stringify(input),
      });
      const body = await response.json();
      assert.equal(response.status, 200, JSON.stringify(body));
      return body.result;
    };
    const initial = await action(clients.viewer, "artifact.get", {
      documentId: saved.documentId,
    });
    assert.equal(initial.version, 1);
    assert.equal(initial.context.kind, "hub-native");
    const pulled = `${dataDir}/pulled`;
    await pullArtifact(`${base}/knowledge/${saved.documentId}`, pulled);
    assert.deepEqual(
      await Deno.readFile(`${pulled}/data.png`),
      new Uint8Array([0, 255, 128, 1]),
    );
    const roundTrip = await saveArtifact({ folder: pulled, hubUrl: base });
    assert.equal(roundTrip.appId, saved.appId);
    assert.equal(roundTrip.documentId, saved.documentId);
    assert.equal(roundTrip.version, 1);
    const changedFiles: Record<string, unknown> = { ...initial.files };
    const revisionTarget = await action(owner, "artifact.save", {
      spaceId: spaceA,
      title: "Revision test",
      files: changedFiles,
      publish: true,
    });
    changedFiles["index.html"] = "<p>Draft revision</p>";
    const revised = await action(clients.editor, "artifact.save", {
      documentId: revisionTarget.documentId,
      appId: revisionTarget.appId,
      files: changedFiles,
    });
    assert.equal(revised.version, 2);
    const draft = await action(clients.editor, "artifact.get", {
      documentId: revisionTarget.documentId,
    });
    assert.equal(draft.version, 2);
    assert.notEqual(draft.digest, initial.digest);
    const live = await action(clients.viewer, "artifact.get", {
      documentId: revisionTarget.documentId,
    });
    assert.equal(live.version, 1);
    assert.deepEqual(live.files, initial.files);
    const deniedSave = await clients.viewer.request(
      "/api/v1/actions/artifact.save",
      {
        method: "POST",
        body: JSON.stringify({
          documentId: revisionTarget.documentId,
          appId: revisionTarget.appId,
          files: changedFiles,
        }),
      },
    );
    assert.equal(deniedSave.status, 403);
    const hiddenArtifact = await action(clients.editor, "artifact.save", {
      spaceId: spaceA,
      files: {
        "index.html": "<p>Hidden</p>",
        "context.md": "# Hidden artifact",
      },
    });
    assert.equal(
      (await clients.viewer.request("/api/v1/actions/artifact.get", {
        method: "POST",
        body: JSON.stringify({ documentId: hiddenArtifact.documentId }),
      })).status,
      404,
    );
    const relationships = await action(
      clients.viewer,
      "knowledge.relationships",
      { id: saved.documentId },
    );
    assert.ok(Array.isArray(relationships.links));
    assert.ok(
      !JSON.stringify(relationships).includes(hiddenArtifact.documentId),
    );
    assert.equal(
      (await clients.viewer.request("/api/v1/actions/knowledge.relationships", {
        method: "POST",
        body: JSON.stringify({ id: hiddenArtifact.documentId }),
      })).status,
      404,
    );
    const listedActions = await (await owner.request("/api/v1/actions")).json();
    assert.ok(
      !listedActions.actions.some((action: { name: string }) =>
        action.name === "knowledge.ask"
      ),
    );
    const file = `/api/apps/${saved.appId}/files/index.html`;
    const usageOf = async (client: Client) =>
      (await (await client.request(`/api/apps?conceptId=${saved.documentId}`))
        .json()).usage;
    assert.equal((await owner.request(file)).status, 200);
    assert.equal((await usageOf(owner)).viewers30d, 0);
    assert.equal(
      (await (await owner.request("/api/artifact-usage")).json()).reused.length,
      0,
    );
    assert.equal((await clients.viewer.request(file)).status, 200);
    assert.equal((await clients.viewer.request(file)).status, 200);
    assert.equal((await clients.editor.request(file)).status, 200);
    const usage = await usageOf(owner);
    assert.equal(usage.viewers30d, 2);
    assert.equal(usage.viewersAllTime, 2);
    assert.ok(usage.lastOpenedAt);
    assert.equal(JSON.stringify(usage).includes(userIds.viewer), false);
    assert.equal((await usageOf(clients.editor)).viewers30d, 2);
    const viewerState = await (await clients.viewer.request(
      `/api/apps?conceptId=${saved.documentId}`,
    ))
      .json();
    assert.equal(viewerState.usage, undefined);
    const summary = await (await owner.request("/api/artifact-usage")).json();
    assert.deepEqual(summary.reused, [{
      id: saved.documentId,
      title: "Reusable artifact",
      viewers: 2,
    }]);
    assert.equal(
      (await clients.editor.request("/api/artifact-usage")).status,
      403,
    );
    assert.equal(
      (await clients.manager.request("/api/artifact-usage")).status,
      403,
    );

    // Opaque-origin sandboxes load module bundles through a capability URL.
    const mint = (client: Client) =>
      client.request(`/api/apps/${saved.appId}/capability`, {
        method: "POST",
      });
    const sandboxGet = (path: string) =>
      fetch(`${base}${path}`, { headers: { origin: "null" } });
    assert.equal((await mint(new Client(base))).status, 401);
    const viewerUrl = (await (await mint(clients.viewer)).json()).url;
    assert.match(viewerUrl, /^\/app-files\/[A-Za-z0-9_-]{43}\/index\.html$/);
    const entry = await sandboxGet(viewerUrl);
    assert.equal(entry.status, 200);
    assert.equal(entry.headers.get("access-control-allow-origin"), "*");
    assert.equal(entry.headers.get("access-control-allow-credentials"), null);
    assert.match(
      entry.headers.get("content-security-policy") ?? "",
      /connect-src 'none'/,
    );
    assert.match(await entry.text(), /type="module"/);
    const moduleFile = await sandboxGet(
      viewerUrl.replace("index.html", "lib.js"),
    );
    assert.equal(moduleFile.headers.get("content-type"), "text/javascript");
    assert.equal(moduleFile.headers.get("x-content-type-options"), "nosniff");
    assert.equal(await moduleFile.text(), 'export const ready = "yes";');
    // A session cookie is not a capability, and the cookie route still refuses null.
    assert.equal(
      (await clients.viewer.request(`/app-files/${"A".repeat(43)}/index.html`))
        .status,
      404,
    );
    assert.equal(
      (await clients.viewer.request(file, { headers: { origin: "null" } }))
        .status,
      403,
    );

    const otherUrl = (await (await mint(clients.otherManager)).json()).url;
    assert.equal((await sandboxGet(otherUrl)).status, 200);
    assert.equal((await usageOf(owner)).viewers30d, 3);

    revokedUserId = userIds.viewer;
    assert.equal((await sandboxGet(viewerUrl)).status, 404);
    assert.equal((await mint(clients.viewer)).status, 404);
    revokedUserId = "";
    assert.equal((await sandboxGet(viewerUrl)).status, 200);

    await Deno.writeTextFile(`${folder}/lib.js`, 'export const ready = "v2";');
    assert.equal(
      (await saveArtifact({
        folder,
        hubUrl: base,
        spaceId: spaceA,
        title: "Reusable artifact",
        publish: true,
      })).version,
      2,
    );
    assert.equal((await sandboxGet(otherUrl)).status, 404);
    const renewed = (await (await mint(clients.otherManager)).json()).url;
    assert.equal(
      await (await sandboxGet(renewed.replace("index.html", "lib.js"))).text(),
      'export const ready = "v2";',
    );
  } finally {
    if (previousToken === undefined) Deno.env.delete("OKF_HUB_TOKEN");
    else Deno.env.set("OKF_HUB_TOKEN", previousToken);
    await server.shutdown();
    await app.close();
    await fga.server.shutdown();
    await Deno.remove(dataDir, { recursive: true });
  }
});

Deno.test("builds a permission-filtered company graph across published hub, Git, and shared definitions", async () => {
  const dataDir = await Deno.makeTempDir();
  let viewerId = "";
  let includeSecret = false;
  const fga = fakeOpenFga((tuple) =>
    tuple.user === `user:${viewerId}` &&
    tuple.object === "concept:repository/secret"
  );
  const objects = new Map<string, string>();
  const definition =
    "An active customer placed an order in the last thirty days.";
  const app = await createCollabApp({
    dataDir,
    authSecret: "company-graph-test-secret-at-least-32-characters",
    openfgaURL: `http://127.0.0.1:${(fga.server.addr as Deno.NetAddr).port}`,
    automationIntervalMs: 0,
    objectStore: {
      put(key, markdown) {
        objects.set(key, markdown);
        return Promise.resolve();
      },
      get(key) {
        return objects.has(key)
          ? Promise.resolve(objects.get(key)!)
          : Promise.reject(new Error("Not found"));
      },
      remove(key) {
        objects.delete(key);
        return Promise.resolve();
      },
    },
    repositorySync: async () => ({
      revision: includeSecret ? "two" : "one",
      files: await Promise.all([
        inspectOkf(
          "customer.md",
          `---\ntype: Glossary\ntitle: Purchasing account\nid: active-customer\n---\n\n${definition}\n\nSee [shared definition](okf://shared/customer.md).`,
        ),
        ...(includeSecret
          ? [
            inspectOkf(
              "secret.md",
              "---\ntype: Metric\ntitle: Hidden definition\nid: active-customer\n---\n\nNever signed in. See [policy](okf://hub/active-customer).",
            ),
          ]
          : []),
      ]),
      issues: [],
    }),
    sharedSourceSync: async () => ({
      revision: "shared-one",
      files: [
        await inspectOkf(
          "customer.md",
          "---\ntype: Glossary\ntitle: Active customer\n---\n\nEvery registered account, even without purchases. See [policy](okf://hub/active-customer).",
        ),
      ],
      issues: [],
    }),
  });
  const server = Deno.serve(
    { hostname: "127.0.0.1", port: 0, onListen() {} },
    app.fetch,
  );
  const base = `http://127.0.0.1:${(server.addr as Deno.NetAddr).port}`;
  const owner = new Client(base);
  const viewer = new Client(base);
  const json = async (
    client: Client,
    path: string,
    body?: unknown,
    method = "POST",
  ) => {
    const response = await client.request(
      path,
      body === undefined ? {} : { method, body: JSON.stringify(body) },
    );
    assert.ok(response.ok, await response.clone().text());
    return await response.json();
  };
  try {
    await owner.signUp("Graph owner", "graph-owner@example.com");
    await json(owner, "/api/setup", {
      name: "Company graph",
      tagline: "Shared definitions",
    });
    const invitation = await json(owner, "/api/invitations", {
      email: "graph-reader@example.com",
      access: "viewer",
    });
    await viewer.signUp(
      "Graph reader",
      "graph-reader@example.com",
      invitation.id,
    );
    await json(viewer, "/api/invitations/accept", {
      invitationId: invitation.id,
    });
    viewerId = (await json(viewer, "/api/auth/get-session")).user.id;
    await json(owner, "/api/concepts", {
      title: "Active customer",
      type: "Glossary",
      spaceId: "policies",
      markdown: definition,
    });
    await json(owner, "/api/concepts/active-customer/publish", {
      markdown:
        `${definition}\n\nSee [repository definition](okf://repository/customer.md), [hidden definition](okf://repository/secret.md), and [missing](okf://repository/missing.md).`,
    });
    await json(owner, "/api/sources/repositories", {
      repositoryUrl: "https://example.com/company/graph.git",
      folder: "okf",
    });
    await json(owner, "/api/sources/shared", {
      endpoint: "http://localhost:9000",
      bucket: "knowledge",
      path: "okf",
      region: "us-east-1",
      accessKey: "test-access",
      secretKey: "test-secret",
    });
    const before = await json(viewer, "/api/search");
    includeSecret = true;
    await json(owner, "/api/sources/repositories/repository/refresh", {});
    const visible = await json(viewer, "/api/search");
    // A refresh advances visible source provenance; graph/discovery signals
    // must otherwise be indistinguishable when only hidden content was added.
    for (const item of before.results) {
      if (item.sourceId === "repository") item.sourceRevision = "two";
    }
    assert.deepEqual(
      visible,
      before,
      "hidden definitions must not affect any discovery signal",
    );
    const hub = visible.results.find((item: { id: string }) =>
      item.id === "active-customer"
    );
    assert.deepEqual(hub.links.map((item: { id: string }) => item.id), [
      "repository/customer",
    ]);
    assert.deepEqual(hub.backlinks.map((item: { id: string }) => item.id), [
      "shared/customer",
    ]);
    assert.deepEqual(
      hub.alsoDefinedIn.map((item: { id: string }) => item.id).sort(),
      [
        "repository/customer",
        "shared/customer",
      ],
    );
    assert.equal(
      hub.linkTargets["okf://repository/customer.md"],
      "/imports/repository/customer.md",
    );
    assert.equal(hub.linkTargets["okf://repository/secret.md"], undefined);
    assert.equal(hub.linkTargets["okf://repository/missing.md"], undefined);
    assert.ok(
      hub.conflicts.some((item: { id: string }) =>
        item.id === "shared/customer"
      ),
    );
    assert.equal(hub.canReviewConflicts, false);
    assert.equal(JSON.stringify(visible).includes("Hidden definition"), false);
    assert.equal(JSON.stringify(visible).includes('"body"'), false);
    assert.equal(JSON.stringify(visible).includes('"stableId"'), false);
    const editorView = await json(owner, "/api/search");
    const editorHub = editorView.results.find((item: { id: string }) =>
      item.id === "active-customer"
    );
    assert.equal(editorHub.canReviewConflicts, true);
    // Without a provider the editor still sees Compare, disabled.
    assert.equal(editorHub.canCompareDefinitions, true);
    assert.equal(editorHub.aiEnabled, false);
    assert.ok(
      editorHub.backlinks.some((item: { id: string }) =>
        item.id === "repository/secret"
      ),
    );
    assert.ok(
      editorHub.conflicts.some((item: { id: string }) =>
        item.id === "repository/secret"
      ),
    );
    const graphResponse = await viewer.request(
      "/api/v1/actions/knowledge.relationships",
      {
        method: "POST",
        body: JSON.stringify({ id: "active-customer" }),
      },
    );
    assert.equal(graphResponse.status, 200);
    const graphResult = (await graphResponse.json()).result;
    assert.ok(!JSON.stringify(graphResult).includes("repository/secret"));
    for (const field of ["links", "backlinks", "alsoDefinedIn", "conflicts"]) {
      assert.deepEqual(graphResult[field], hub[field]);
    }
    const hidden = await viewer.request(
      "/api/imported?source=repository&path=secret.md",
    );
    const missing = await viewer.request(
      "/api/imported?source=repository&path=missing.md",
    );
    assert.equal(hidden.status, 404);
    assert.equal(missing.status, 404);
    assert.deepEqual(await hidden.json(), await missing.json());
    const exported = await owner.request(
      "/api/concepts/active-customer/export",
    );
    assert.equal(exported.status, 200);
    assert.match(await exported.text(), /\nid: "active-customer"\n/);
  } finally {
    await server.shutdown();
    await app.close();
    await fga.server.shutdown();
    await Deno.remove(dataDir, { recursive: true });
  }
});

Deno.test("tracks unpublished body and metadata changes while hiding draft state from viewers", async () => {
  const dataDir = await Deno.makeTempDir();
  const fga = fakeOpenFga();
  const objects = new Map<string, string>();
  let revisionReads = 0;
  let failNextRevisionRead = false;
  let malformedPublication = false;
  const aiRequests: AIRequest[] = [];
  const app = await createCollabApp({
    dataDir,
    authSecret: "a-secure-test-secret-with-at-least-32-characters",
    openfgaURL: `http://127.0.0.1:${(fga.server.addr as Deno.NetAddr).port}`,
    objectStore: {
      put(key, markdown) {
        objects.set(
          key,
          malformedPublication && key.includes("/revisions/")
            ? markdown.replace(
              /^---\n[\s\S]*?\n---\n/,
              "---\ntitle: { invalid: true }\ntype: [Invalid]\n---\n",
            )
            : markdown,
        );
        return Promise.resolve();
      },
      get(key) {
        if (key.includes("/revisions/")) {
          revisionReads++;
          if (failNextRevisionRead && key.endsWith("/revisions/4.md")) {
            failNextRevisionRead = false;
            return Promise.reject(new Error("Temporary storage failure"));
          }
        }
        return objects.has(key)
          ? Promise.resolve(objects.get(key)!)
          : Promise.reject(new Error("Object not found"));
      },
      remove(key) {
        objects.delete(key);
        return Promise.resolve();
      },
    },
    automationIntervalMs: 0,
    aiProvider: "ollama",
    aiModel: "test-model",
    aiResponder(request) {
      aiRequests.push(request);
      return Promise.resolve("Mocked published answer");
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
  try {
    await owner.signUp("Owner", "draft-owner@example.com");
    const setup = await owner.request("/api/setup", {
      method: "POST",
      body: JSON.stringify({ name: "Draft status test" }),
    });
    assert.equal(setup.status, 200, await setup.text());
    for (
      const [client, access] of [[editor, "editor"], [
        viewer,
        "viewer",
      ]] as const
    ) {
      const email = `draft-${access}@example.com`;
      const invitation = await owner.request("/api/invitations", {
        method: "POST",
        body: JSON.stringify({ email, access }),
      });
      assert.equal(invitation.status, 200, await invitation.clone().text());
      const invitationId = (await invitation.json()).id;
      await client.signUp(access, email, invitationId);
      const accepted = await client.request("/api/invitations/accept", {
        method: "POST",
        body: JSON.stringify({ invitationId }),
      });
      assert.equal(accepted.status, 200, await accepted.text());
    }
    const parentResponse = await editor.request("/api/concepts", {
      method: "POST",
      body: JSON.stringify({
        title: "Parent",
        type: "Guide",
        spaceId: "policies",
      }),
    });
    assert.equal(
      parentResponse.status,
      201,
      await parentResponse.clone().text(),
    );
    const parent = await parentResponse.json();
    const title = 'Team "alpha": guide';
    const createdResponse = await editor.request("/api/concepts", {
      method: "POST",
      body: JSON.stringify({
        title,
        type: "Guide",
        intent: "working",
        spaceId: "policies",
        parentId: parent.id,
      }),
    });
    assert.equal(
      createdResponse.status,
      201,
      await createdResponse.clone().text(),
    );
    const created = await createdResponse.json();
    const path = `/api/concepts/${created.id}`;
    assert.equal(created.hasUnpublishedChanges, true);
    assert.equal((await viewer.request(path)).status, 404);
    assert.deepEqual(await (await viewer.request("/api/concepts")).json(), []);
    const publishedBody = "## Shared policy\n\nEveryone may read this.\n";
    let expectedMetadata = { title, type: "Guide", intent: "working" };
    let parentPublished = false;
    const checkpoint = async (markdown: string, changed: boolean) => {
      const response = await editor.request(path, {
        method: "PUT",
        body: markdown,
      });
      assert.equal(response.status, 204, await response.text());
      assert.equal(
        response.headers.get("x-okf-unpublished-changes"),
        String(changed),
      );
    };
    const state = async (client: Client) => {
      const response = await client.request(path);
      assert.equal(response.status, 200, await response.clone().text());
      return await response.json();
    };
    const listed = async (client: Client) => {
      const response = await client.request("/api/concepts");
      assert.equal(response.status, 200, await response.clone().text());
      return (await response.json()).find((item: { id: string }) =>
        item.id === created.id
      );
    };
    const publish = async () => {
      const response = await editor.request(`${path}/publish`, {
        method: "POST",
      });
      assert.equal(response.status, 200, await response.clone().text());
      const result = await response.json();
      assert.equal(result.hasUnpublishedChanges, false);
      assert.equal((await listed(editor)).hasUnpublishedChanges, false);
      expectedMetadata = {
        title: result.title,
        type: result.type,
        intent: result.intent,
      };
      assert.deepEqual(result.publishedMetadata, expectedMetadata);
      return result;
    };
    const viewerSeesPublishedOnly = async () => {
      const result = await state(viewer);
      assert.equal(result.hasUnpublishedChanges, false);
      assert.equal(result.draft, null);
      assert.equal(result.published, publishedBody);
      assert.deepEqual(result.revisions, []);
      const summary = await listed(viewer);
      assert.equal(summary.hasUnpublishedChanges, false);
      assert.equal(summary.draft, undefined);
      assert.equal(summary.published, undefined);
      assert.equal(result.title, expectedMetadata.title);
      assert.equal(result.type, expectedMetadata.type);
      assert.deepEqual(result.publishedMetadata, expectedMetadata);
      assert.equal(summary.title, expectedMetadata.title);
      assert.equal(summary.type, expectedMetadata.type);
      const action = await viewer.request("/api/v1/actions/documents.get", {
        method: "POST",
        body: JSON.stringify({ id: created.id }),
      });
      assert.equal(action.status, 200, await action.clone().text());
      const agentDocument = (await action.json()).result;
      assert.equal(agentDocument.title, expectedMetadata.title);
      assert.equal(agentDocument.type, expectedMetadata.type);
      const search = await viewer.request("/api/search");
      assert.equal(search.status, 200, await search.clone().text());
      const searched = await search.json();
      const found = searched.results.find((item: { id: string }) =>
        item.id === created.id
      );
      assert.equal(found.title, expectedMetadata.title);
      assert.equal(found.type, expectedMetadata.type);
      const working = await state(editor);
      assert.deepEqual(working.publishedMetadata, expectedMetadata);
      if (working.type !== expectedMetadata.type) {
        assert.ok(!searched.facets.types.includes(working.type));
      }
      if (working.title !== expectedMetadata.title) {
        const privateSearch = await viewer.request(
          `/api/search?q=${encodeURIComponent(working.title)}`,
        );
        assert.ok(
          !(await privateSearch.json()).results.some((item: { id: string }) =>
            item.id === created.id
          ),
        );
      }
      for (const client of [viewer, editor]) {
        const answer = await client.request("/api/ai/chat", {
          method: "POST",
          body: JSON.stringify({
            conceptId: created.id,
            state: "published",
            messages: [{ role: "user", content: "Explain the document" }],
          }),
        });
        assert.equal(answer.status, 200, await answer.text());
        assert.equal(aiRequests.at(-1)!.document.title, expectedMetadata.title);
        assert.equal(aiRequests.at(-1)!.document.markdown, publishedBody);
      }
      if (parentPublished) {
        assert.equal(result.workTraces[0].conceptTitle, expectedMetadata.title);
        assert.equal(result.workTraces[0].foldedIntoTitle, "Parent");
        assert.ok(
          found.backlinks.some((item: { title: string }) =>
            item.title === "Parent"
          ),
        );
        const parentResult = searched.results.find((item: { id: string }) =>
          item.id === parent.id
        );
        assert.equal(parentResult.title, "Parent");
        assert.ok(
          parentResult.links.some((item: { title: string }) =>
            item.title === expectedMetadata.title
          ),
        );
      }
    };
    await checkpoint(publishedBody, true);
    assert.equal((await publish()).publishedRevision, 1);
    await viewerSeesPublishedOnly();
    const readsAfterPublication = revisionReads;
    await Promise.all([listed(editor), listed(editor)]);
    await listed(editor);
    assert.equal(
      revisionReads,
      readsAfterPublication,
      "repeated/concurrent listings reuse immutable published content",
    );
    const parentPublication = await editor.request(
      `/api/concepts/${parent.id}/publish`,
      {
        method: "POST",
        body: JSON.stringify({
          markdown: `## Parent\n\n[Shared page](/knowledge/${created.id})\n`,
        }),
      },
    );
    assert.equal(parentPublication.status, 200, await parentPublication.text());
    const recorded = await editor.request(`${path}/traces`, {
      method: "POST",
      body: JSON.stringify({
        kind: "change",
        title: "Recorded change",
        summary: "A lasting explanation",
        occurredAt: "2026-10-04",
      }),
    });
    assert.equal(recorded.status, 201, await recorded.clone().text());
    const traceId = (await state(editor)).workTraces[0].id;
    const folded = await editor.request(`${path}/traces/${traceId}/fold`, {
      method: "POST",
      body: JSON.stringify({
        targetConceptId: parent.id,
        knowledge: "Lasting knowledge",
      }),
    });
    assert.equal(folded.status, 200, await folded.text());
    const parentRename = await editor.request(
      `/api/concepts/${parent.id}/metadata`,
      {
        method: "PUT",
        body: JSON.stringify({ title: "Private parent title" }),
      },
    );
    assert.equal(parentRename.status, 200, await parentRename.text());
    parentPublished = true;
    const privateBody = "## Private next draft\n\nA secret draft detail.\n";
    await checkpoint(privateBody, true);
    assert.equal((await state(editor)).hasUnpublishedChanges, true);
    assert.equal((await listed(editor)).hasUnpublishedChanges, true);
    await viewerSeesPublishedOnly();
    await checkpoint(`${publishedBody}\n\n`, false);
    assert.equal((await state(editor)).hasUnpublishedChanges, false);
    assert.equal((await listed(editor)).hasUnpublishedChanges, false);
    const patch = async (fields: Record<string, string>) => {
      const response = await editor.request(`${path}/metadata`, {
        method: "PUT",
        body: JSON.stringify(fields),
      });
      assert.equal(response.status, 200, await response.clone().text());
      return await response.json();
    };
    const changedType = await patch({ type: "Runbook" });
    assert.equal(changedType.hasUnpublishedChanges, true);
    assert.equal(changedType.title, title);
    assert.equal(changedType.intent, "working");
    assert.equal(changedType.spaceId, "policies");
    assert.equal(changedType.parentId, parent.id);
    assert.equal((await listed(editor)).hasUnpublishedChanges, true);
    await viewerSeesPublishedOnly();
    const changedTitle = await patch({ title: "Renamed guide" });
    assert.equal(changedTitle.hasUnpublishedChanges, true);
    assert.equal(changedTitle.type, "Runbook");
    assert.equal(changedTitle.intent, "working");
    assert.equal(changedTitle.parentId, parent.id);
    await viewerSeesPublishedOnly();
    assert.equal((await publish()).publishedRevision, 2);
    const unchangedTitle = await patch({ title: "Renamed guide" });
    assert.equal(unchangedTitle.hasUnpublishedChanges, false);
    await viewerSeesPublishedOnly();

    await Promise.all([
      patch({ title: "Concurrently renamed" }),
      patch({ type: "Decision" }),
    ]);
    const concurrent = await state(editor);
    assert.equal(concurrent.title, "Concurrently renamed");
    assert.equal(concurrent.type, "Decision");
    assert.equal(concurrent.intent, "working");
    assert.equal(concurrent.parentId, parent.id);
    assert.equal(concurrent.hasUnpublishedChanges, true);
    await viewerSeesPublishedOnly();
    assert.equal((await publish()).publishedRevision, 3);
    await viewerSeesPublishedOnly();
    const readsAfterRepublishing = revisionReads;
    await listed(editor);
    assert.equal(
      revisionReads,
      readsAfterRepublishing,
      "the new publication also becomes cached",
    );

    await checkpoint("## Fourth publication\n", true);
    failNextRevisionRead = true;
    const failedPublicationRead = await editor.request(`${path}/publish`, {
      method: "POST",
    });
    assert.equal(
      failedPublicationRead.status,
      503,
      await failedPublicationRead.text(),
    );
    const readsAfterFailure = revisionReads;
    const recoveredListings = await Promise.all([
      listed(editor),
      listed(editor),
    ]);
    assert.ok(
      recoveredListings.every((item) => item.hasUnpublishedChanges === false),
    );
    assert.equal(
      revisionReads,
      readsAfterFailure + 1,
      "a failed revision read is retried instead of remaining cached",
    );
    const fourth = await state(editor);
    assert.equal(fourth.publishedRevision, 4);
    assert.equal(fourth.published, "## Fourth publication\n");
    assert.equal(fourth.hasUnpublishedChanges, false);
    assert.equal(revisionReads, readsAfterFailure + 1);
    malformedPublication = true;
    await checkpoint("## Malformed publication metadata\n", true);
    const corrupted = await editor.request(`${path}/publish`, {
      method: "POST",
    });
    assert.equal(corrupted.status, 200, await corrupted.clone().text());
    const corruptedEditor = await corrupted.json();
    assert.equal(corruptedEditor.title, "Concurrently renamed");
    assert.deepEqual(corruptedEditor.publishedMetadata, {
      title: "Published document",
      type: "Document",
      intent: "canonical",
    });
    const genericViewer = await state(viewer);
    assert.equal(genericViewer.title, "Published document");
    assert.equal(genericViewer.type, "Document");
    assert.equal((await listed(viewer)).title, "Published document");
    assert.equal(
      genericViewer.workTraces[0].conceptTitle,
      "Published document",
    );
    const genericSearch = await viewer.request("/api/search");
    const genericResults = await genericSearch.json();
    assert.equal(
      genericResults.results.find((item: { id: string }) =>
        item.id === created.id
      ).type,
      "Document",
    );
    assert.ok(!genericResults.facets.types.includes("Decision"));
  } finally {
    await server.shutdown();
    await app.close();
    await fga.server.shutdown();
    await Deno.remove(dataDir, { recursive: true });
  }
});

Deno.test("revision restore resets stale collaboration state and rejects old epochs", async () => {
  const dataDir = await Deno.makeTempDir();
  const fga = fakeOpenFga();
  const objects = new Map<string, string>();
  const options = {
    dataDir,
    authSecret: "a-secure-test-secret-with-at-least-32-characters",
    openfgaURL: `http://127.0.0.1:${(fga.server.addr as Deno.NetAddr).port}`,
    automationIntervalMs: 0,
    objectStore: {
      put(key: string, markdown: string) {
        objects.set(key, markdown);
        return Promise.resolve();
      },
      get(key: string) {
        return objects.has(key)
          ? Promise.resolve(objects.get(key)!)
          : Promise.reject(new Error("Object not found"));
      },
      remove(key: string) {
        objects.delete(key);
        return Promise.resolve();
      },
    },
  };
  let app = await createCollabApp(options);
  let cookie = "";
  let delayedRequestEntered = () => {};
  const server = Deno.serve(
    { hostname: "127.0.0.1", port: 0, onListen() {} },
    (request) => {
      if (request.headers.get("x-test-delayed") === "true") {
        delayedRequestEntered();
      }
      if (request.headers.get("upgrade") === "websocket") {
        const headers = new Headers(request.headers);
        headers.set("cookie", cookie);
        // Keep Deno's upgrade metadata on the original request while supplying
        // the test owner's cookie to the same session check used by browsers.
        Object.defineProperty(request, "headers", { value: headers });
      }
      return app.fetch(request);
    },
  );
  const base = `http://127.0.0.1:${(server.addr as Deno.NetAddr).port}`;
  const owner = new Client(base);
  const sockets: WebSocket[] = [];
  const docs: Y.Doc[] = [];
  let releaseDelayedBody = () => {};
  const bounded = async <T>(promise: Promise<T>) => {
    let timer: ReturnType<typeof setTimeout>;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error("Collaboration timed out")),
        3000,
      );
    });
    try {
      return await Promise.race([promise, timeout]);
    } finally {
      clearTimeout(timer!);
    }
  };
  const connect = (id: string, epoch: number) => {
    const doc = new Y.Doc();
    docs.push(doc);
    const socket = new WebSocket(
      `${base.replace("http", "ws")}/collab?conceptId=${id}&epoch=${epoch}`,
    );
    sockets.push(socket);
    socket.binaryType = "arraybuffer";
    const synced = new Promise<void>((resolve) => {
      socket.addEventListener("message", (event) => {
        if (event.data === "synced") return resolve();
        if (event.data instanceof ArrayBuffer) {
          const packet = new Uint8Array(event.data);
          if (packet[0] === 0) Y.applyUpdate(doc, packet.subarray(1));
        }
      });
    });
    const closed = new Promise<CloseEvent>((resolve) => {
      socket.addEventListener("close", resolve, { once: true });
    });
    return { socket, doc, synced, closed };
  };
  try {
    await owner.signUp("Owner", "restore-owner@example.com");
    cookie = owner.cookie;
    const setup = await owner.request("/api/setup", {
      method: "POST",
      body: JSON.stringify({ name: "Restore test" }),
    });
    assert.equal(setup.status, 200, await setup.text());
    const createdResponse = await owner.request("/api/concepts", {
      method: "POST",
      body: JSON.stringify({
        title: "Restored page",
        type: "Guide",
        spaceId: "policies",
      }),
    });
    assert.equal(
      createdResponse.status,
      201,
      await createdResponse.clone().text(),
    );
    const created = await createdResponse.json();
    const path = `/api/concepts/${created.id}`;
    const restoredMarkdown = "## Published checkpoint\n\nKeep this version.\n";
    const checkpoint = await owner.request(path, {
      method: "PUT",
      body: restoredMarkdown,
    });
    assert.equal(checkpoint.status, 204, await checkpoint.text());
    const published = await owner.request(`${path}/publish`, {
      method: "POST",
    });
    assert.equal(published.status, 200, await published.text());
    const old = connect(created.id, created.collabEpoch);
    const observer = connect(created.id, created.collabEpoch);
    await bounded(Promise.all([old.synced, observer.synced]));
    const observed = new Promise<void>((resolve) => {
      observer.doc.on("update", () => {
        if (
          observer.doc.getXmlFragment("prosemirror").toString().includes(
            "Old draft",
          )
        ) resolve();
      });
    });
    const paragraph = new Y.XmlElement("paragraph");
    const text = new Y.XmlText();
    text.insert(0, "Old draft that must never return");
    paragraph.insert(0, [text]);
    old.doc.getXmlFragment("prosemirror").insert(0, [paragraph]);
    const update = Y.encodeStateAsUpdate(old.doc);
    const packet = new Uint8Array(update.length + 1);
    packet.set(update, 1);
    old.socket.send(packet);
    await bounded(observed);
    const edited = await owner.request(path, {
      method: "PUT",
      body: "Old draft that must never return\n",
    });
    assert.equal(edited.status, 204, await edited.text());
    let delayedReleased = false;
    const delayedBody = new ReadableStream<Uint8Array>({
      start(controller) {
        releaseDelayedBody = () => {
          if (delayedReleased) return;
          delayedReleased = true;
          controller.enqueue(new TextEncoder().encode("Late old draft\n"));
          controller.close();
        };
      },
      cancel() {
        delayedReleased = true;
      },
    });
    const entered = new Promise<void>((resolve) =>
      delayedRequestEntered = resolve
    );
    const delayedSave = owner.request(path, {
      method: "PUT",
      headers: {
        "x-okf-collab-epoch": String(created.collabEpoch),
        "x-test-delayed": "true",
      },
      body: delayedBody,
    });
    await bounded(entered);
    const restored = await owner.request(`${path}/revisions/1/restore`, {
      method: "POST",
    });
    assert.equal(restored.status, 200, await restored.clone().text());
    const result = await restored.json();
    assert.equal(result.draft, restoredMarkdown);
    assert.equal(
      result.collabEpoch,
      created.collabEpoch + 1,
      "restoring a revision must invalidate old collaboration clients",
    );
    releaseDelayedBody();
    const delayedResult = await bounded(delayedSave);
    assert.equal(delayedResult.status, 409, await delayedResult.clone().text());
    assert.match(await delayedResult.text(), /restored in another session/);
    const staleCheckpoint = await owner.request(path, {
      method: "PUT",
      headers: { "x-okf-collab-epoch": String(created.collabEpoch) },
      body: "Old epoch must not overwrite the restored checkpoint\n",
    });
    assert.equal(staleCheckpoint.status, 409, await staleCheckpoint.text());
    assert.equal(
      (await (await owner.request(path)).json()).draft,
      restoredMarkdown,
    );
    const currentCheckpoint = await owner.request(path, {
      method: "PUT",
      headers: { "x-okf-collab-epoch": String(result.collabEpoch) },
      body: restoredMarkdown,
    });
    assert.equal(currentCheckpoint.status, 204, await currentCheckpoint.text());
    const legacyCheckpoint = await owner.request(path, {
      method: "PUT",
      body: restoredMarkdown,
    });
    assert.equal(legacyCheckpoint.status, 204, await legacyCheckpoint.text());
    const preflight = await owner.request(path, {
      method: "OPTIONS",
      headers: {
        origin: "http://127.0.0.1:3000",
        "access-control-request-method": "PUT",
        "access-control-request-headers": "x-okf-collab-epoch",
      },
    });
    assert.equal(preflight.status, 204);
    assert.match(
      preflight.headers.get("access-control-allow-headers") ?? "",
      /x-okf-collab-epoch/,
    );
    assert.equal((await bounded(old.closed)).code, 4009);
    assert.equal((await bounded(observer.closed)).code, 4009);
    const stale = connect(created.id, created.collabEpoch);
    assert.equal((await bounded(stale.closed)).code, 4009);
    const fresh = connect(created.id, result.collabEpoch);
    await bounded(fresh.synced);
    assert.equal(
      fresh.doc.getXmlFragment("prosemirror").length,
      0,
      "fresh sync must allow the restored Markdown template instead of applying the old draft",
    );
    await assert.rejects(
      Deno.stat(`${dataDir}/concepts/${created.id}.yjs`),
      Deno.errors.NotFound,
    );
    fresh.socket.close();
    await bounded(fresh.closed);
    await app.close();
    app = await createCollabApp(options);
    const reopened = connect(created.id, result.collabEpoch);
    await bounded(reopened.synced);
    assert.equal(
      reopened.doc.getXmlFragment("prosemirror").length,
      0,
      "the old Yjs draft must also stay gone after server restart",
    );
    assert.equal(
      (await (await owner.request(path)).json()).draft,
      restoredMarkdown,
    );
    reopened.socket.close();
    await bounded(reopened.closed);

    // An API draft update must not leave an open editor on the replaced text.
    const editing = connect(created.id, result.collabEpoch);
    await bounded(editing.synced);
    const typed = new Y.XmlElement("paragraph");
    const typedText = new Y.XmlText();
    typedText.insert(0, "Typed in the editor");
    typed.insert(0, [typedText]);
    editing.doc.getXmlFragment("prosemirror").insert(0, [typed]);
    const typedUpdate = Y.encodeStateAsUpdate(editing.doc);
    const typedPacket = new Uint8Array(typedUpdate.length + 1);
    typedPacket.set(typedUpdate, 1);
    editing.socket.send(typedPacket);
    const apiMarkdown = "Replaced by an agent through the API.\n";
    const updated = await owner.request(
      "/api/v1/actions/documents.update-draft",
      {
        method: "POST",
        body: JSON.stringify({ id: created.id, markdown: apiMarkdown }),
      },
    );
    assert.equal(updated.status, 200, await updated.clone().text());
    assert.equal((await bounded(editing.closed)).code, 4009);
    const afterApi = await (await owner.request(path)).json();
    assert.equal(afterApi.draft, apiMarkdown);
    assert.equal(afterApi.collabEpoch, result.collabEpoch + 1);
    const resynced = connect(created.id, afterApi.collabEpoch);
    await bounded(resynced.synced);
    assert.equal(resynced.doc.getXmlFragment("prosemirror").length, 0);
    // Saving the same text again keeps current editors connected.
    const same = await owner.request("/api/v1/actions/documents.update-draft", {
      method: "POST",
      body: JSON.stringify({ id: created.id, markdown: apiMarkdown }),
    });
    assert.equal(same.status, 200, await same.clone().text());
    assert.equal(
      (await (await owner.request(path)).json()).collabEpoch,
      afterApi.collabEpoch,
    );
    assert.equal(resynced.socket.readyState, WebSocket.OPEN);
  } finally {
    releaseDelayedBody();
    for (const socket of sockets) {
      if (
        socket.readyState === WebSocket.OPEN ||
        socket.readyState === WebSocket.CONNECTING
      ) socket.close();
    }
    for (const doc of docs) doc.destroy();
    await server.shutdown();
    await app.close();
    await fga.server.shutdown();
    await Deno.remove(dataDir, { recursive: true });
  }
});

Deno.test("hybrid Ask OKF uses published evidence for viewers and excludes hidden best matches", async () => {
  const dataDir = await Deno.makeTempDir();
  let viewerId = "";
  const fga = fakeOpenFga((tuple) =>
    tuple.user === `user:${viewerId}` &&
    tuple.object === "concept:repository/secret"
  );
  const requests: AIRequest[] = [];
  const objects = new Map<string, string>();
  const app = await createCollabApp({
    dataDir,
    authSecret: "hybrid-test-secret-at-least-32-characters",
    objectStore: {
      put: (key, markdown) => {
        objects.set(key, markdown);
        return Promise.resolve();
      },
      get: (key) =>
        objects.has(key)
          ? Promise.resolve(objects.get(key)!)
          : Promise.reject(new Error("Not found")),
      remove: (key) => {
        objects.delete(key);
        return Promise.resolve();
      },
    },
    openfgaURL: `http://127.0.0.1:${(fga.server.addr as Deno.NetAddr).port}`,
    automationIntervalMs: 0,
    aiEmbedModel: "deterministic",
    aiEmbedder: (texts) =>
      Promise.resolve(
        texts.map((text) =>
          /SECRET|recover access/.test(text)
            ? [1, 0]
            : /password/.test(text)
            ? [0.9, 0.1]
            : [0, 1]
        ),
      ),
    aiResponder: (request) => {
      requests.push(request);
      return Promise.resolve("Grounded answer [1]");
    },
    repositorySync: async () => ({
      revision: "one",
      files: [
        await inspectOkf(
          "secret.md",
          "---\ntype: Guide\ntitle: Classified reference\n---\n\nSECRET restricted evidence",
        ),
      ],
      issues: [],
    }),
  });
  const server = Deno.serve(
    { hostname: "127.0.0.1", port: 0, onListen() {} },
    app.fetch,
  );
  const base = `http://127.0.0.1:${(server.addr as Deno.NetAddr).port}`;
  const owner = new Client(base);
  const viewer = new Client(base);
  const json = async (
    client: Client,
    path: string,
    body?: Record<string, unknown>,
  ) => {
    const response = await client.request(
      path,
      body ? { method: "POST", body: JSON.stringify(body) } : {},
    );
    assert.ok(response.ok, await response.clone().text());
    return await response.json();
  };
  const db = new DatabaseSync(`${dataDir}/hub.db`);
  db.exec("PRAGMA foreign_keys=ON");
  try {
    await owner.signUp("Owner", "hybrid-owner@example.com");
    await json(owner, "/api/setup", { name: "Hybrid test" });
    const invitation = await json(owner, "/api/invitations", {
      email: "hybrid-viewer@example.com",
      access: "viewer",
    });
    await viewer.signUp("Viewer", "hybrid-viewer@example.com", invitation.id);
    await json(viewer, "/api/invitations/accept", {
      invitationId: invitation.id,
    });
    viewerId = (await json(viewer, "/api/auth/get-session")).user.id;
    const guide = await json(owner, "/api/concepts", {
      title: "Credential playbook",
      type: "Guide",
      spaceId: "policies",
      markdown: "Reset your password using the service desk.",
    });
    await json(owner, `/api/concepts/${guide.id}/publish`, {
      markdown: "Reset your password using the service desk.",
    });
    const updated = await owner.request(`/api/concepts/${guide.id}`, {
      method: "PUT",
      body: "SECRET unpublished password procedure",
    });
    assert.equal(updated.status, 204, await updated.text());
    const hidden = await json(owner, "/api/concepts", {
      title: "Unreleased material",
      type: "Guide",
      spaceId: "policies",
      markdown: "SECRET never published evidence",
    });
    const hiddenWrite = await owner.request(`/api/concepts/${hidden.id}`, {
      method: "PUT",
      body: "SECRET never published evidence",
    });
    assert.equal(hiddenWrite.status, 204, await hiddenWrite.text());
    await json(owner, "/api/sources/repositories", {
      repositoryUrl: "https://example.com/company/semantic.git",
      folder: "okf",
    });
    // Let the real background worker complete; no external provider or index API.
    const deadline = Date.now() + 10_000;
    while (true) {
      const pending = db.prepare(
        "SELECT COUNT(*) AS n FROM okf_semantic_document WHERE indexedVersion IS NULL OR indexedVersion != version",
      ).get() as { n: number };
      if (!pending.n) break;
      assert.ok(Date.now() < deadline, "Background indexing did not finish");
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const ask = {
      scope: "workspace",
      messages: [{ role: "user", content: "How do I recover access?" }],
    };
    const asked = await json(viewer, "/api/v1/actions/knowledge.ask", {
      question: "How do I recover access?",
    });
    assert.equal(typeof asked.result.answer, "string");
    assert.deepEqual(
      asked.result.citations.map((item: { documentId: string }) =>
        item.documentId
      ),
      [guide.id],
    );
    assert.ok(!requests.at(-1)!.document.markdown.includes("SECRET"));
    const answer = await json(viewer, "/api/ai/chat", ask);
    assert.deepEqual(
      answer.citations.map((item: { documentId: string }) => item.documentId),
      [guide.id],
    );
    assert.match(requests.at(-1)!.document.markdown, /Reset your password/);
    assert.ok(!requests.at(-1)!.document.markdown.includes("SECRET"));
    assert.ok(!JSON.stringify(answer).includes("vector"));
    // Editors can retrieve the separate draft, while restrictions take effect without reindexing.
    await json(owner, "/api/ai/chat", ask);
    assert.match(
      requests.at(-1)!.document.markdown,
      /SECRET unpublished password procedure/,
    );
    db.prepare(
      "UPDATE okf_imported_concept SET status = 'deleted' WHERE id = 'repository/secret'",
    ).run();
    assert.equal(
      (db.prepare(
        "SELECT COUNT(*) AS n FROM okf_semantic_chunk WHERE id = 'repository/secret'",
      ).get() as { n: number }).n,
      0,
    );
  } finally {
    db.close();
    await server.shutdown();
    await app.close();
    await fga.server.shutdown();
    await Deno.remove(dataDir, { recursive: true });
  }
});

Deno.test("FTS search and rewritten Ask stay permission-filtered with separate drafts", async () => {
  const dataDir = await Deno.makeTempDir();
  let viewerId = "";
  let deniedConcept = "";
  const fga = fakeOpenFga((tuple) =>
    tuple.user === `user:${viewerId}` &&
    (tuple.object === "concept:repository/secret" ||
      tuple.object === `concept:${deniedConcept}`)
  );
  const requests: AIRequest[] = [];
  const objects = new Map<string, string>();
  const app = await createCollabApp({
    dataDir,
    authSecret: "fts-search-test-secret-at-least-32-characters",
    objectStore: {
      put: (key, markdown) => {
        objects.set(key, markdown);
        return Promise.resolve();
      },
      get: (key) =>
        objects.has(key)
          ? Promise.resolve(objects.get(key)!)
          : Promise.reject(new Error("Not found")),
      remove: (key) => {
        objects.delete(key);
        return Promise.resolve();
      },
    },
    openfgaURL: `http://127.0.0.1:${(fga.server.addr as Deno.NetAddr).port}`,
    automationIntervalMs: 0,
    aiResponder: (request) => {
      requests.push(request);
      return Promise.resolve(
        request.task === "search-terms"
          ? '{"terms":["remittance schedule"]}'
          : "Grounded answer [1]",
      );
    },
    repositorySync: async () => ({
      revision: "one",
      files: [
        await inspectOkf(
          "secret.md",
          "---\ntype: Guide\ntitle: Classified payment reference\n---\n\nRestricted payment evidence",
        ),
      ],
      issues: [],
    }),
  });
  const server = Deno.serve(
    { hostname: "127.0.0.1", port: 0, onListen() {} },
    app.fetch,
  );
  const base = `http://127.0.0.1:${(server.addr as Deno.NetAddr).port}`;
  const owner = new Client(base);
  const viewer = new Client(base);
  const json = async (
    client: Client,
    path: string,
    body?: Record<string, unknown>,
  ) => {
    const response = await client.request(
      path,
      body ? { method: "POST", body: JSON.stringify(body) } : {},
    );
    assert.ok(response.ok, await response.clone().text());
    return await response.json();
  };
  const ids = async (client: Client, query: string) =>
    (await json(client, `/api/search?q=${encodeURIComponent(query)}`))
      .results.map((item: { id: string }) => item.id).sort();
  try {
    await owner.signUp("Owner", "fts-owner@example.com");
    await json(owner, "/api/setup", { name: "FTS test" });
    const invitation = await json(owner, "/api/invitations", {
      email: "fts-viewer@example.com",
      access: "viewer",
    });
    await viewer.signUp("Viewer", "fts-viewer@example.com", invitation.id);
    await json(viewer, "/api/invitations/accept", {
      invitationId: invitation.id,
    });
    viewerId = (await json(viewer, "/api/auth/get-session")).user.id;
    const create = async (title: string, markdown: string) => {
      const created = await json(owner, "/api/concepts", {
        title,
        type: "Guide",
        spaceId: "policies",
        markdown,
      });
      await json(owner, `/api/concepts/${created.id}/publish`, { markdown });
      return created.id as string;
    };
    const terms = await create(
      "Supplier terms",
      "Payment and remittance schedule for suppliers.",
    );
    deniedConcept = await create("Board payroll", "Payment of board fees.");
    const updated = await owner.request(`/api/concepts/${terms}`, {
      method: "PUT",
      body: "Draftonly renegotiation of remittance.",
    });
    assert.equal(updated.status, 204, await updated.text());
    await json(owner, "/api/sources/repositories", {
      repositoryUrl: "https://example.com/company/fts.git",
      folder: "okf",
    });

    // Stemming finds "Payment" from "paying"; hidden concepts never appear.
    assert.deepEqual(await ids(viewer, "paying"), [terms]);
    assert.deepEqual(
      await ids(owner, "paying"),
      [deniedConcept, "repository/secret"].sort(),
    );
    // Viewers match the publication, editors the draft.
    assert.deepEqual(await ids(viewer, "draftonly"), []);
    assert.deepEqual(await ids(owner, "draftonly"), [terms]);
    assert.deepEqual(await ids(owner, "schedule"), []);
    assert.deepEqual(await ids(viewer, "schedule"), [terms]);
    for (const query of ['"', "*", "NEAR(", "title:", 'pay" OR *']) {
      await json(viewer, `/api/search?q=${encodeURIComponent(query)}`);
    }

    const answer = await json(viewer, "/api/ai/chat", {
      scope: "workspace",
      messages: [{ role: "user", content: "When are vendors settled?" }],
    });
    assert.deepEqual(
      answer.citations.map((item: { documentId: string }) => item.documentId),
      [terms],
    );
    const rewrite = requests.find((request) =>
      request.task === "search-terms"
    )!;
    assert.equal(rewrite.document.markdown, "");
    assert.ok(
      !JSON.stringify(rewrite).match(/remittance schedule for|Payment/),
    );
    assert.match(requests.at(-1)!.document.markdown, /remittance schedule/);
  } finally {
    await server.shutdown();
    await app.close();
    await fga.server.shutdown();
    await Deno.remove(dataDir, { recursive: true });
  }
});

Deno.test("archive names stay unique when generated ids share a long prefix", () => {
  const names = uniqueArchiveNames([
    { id: "mcp-saved-artifact", label: "MCP saved artifact" },
    { id: "mcp-saved-artifact-937c29", label: "MCP saved artifact" },
    { id: "mcp-saved-artifact-a1b2c3", label: "MCP saved artifact" },
  ]);
  const values = [...names.values()].map((name) => name.toLowerCase());
  assert.equal(new Set(values).size, 3);
});

Deno.test("reviewed OKF draft survives app restart on the same data directory", async () => {
  const dataDir = await Deno.makeTempDir();
  const fga = fakeOpenFga();
  const options = {
    openfgaURL: `http://127.0.0.1:${(fga.server.addr as Deno.NetAddr).port}`,
    dataDir,
    authSecret: "a-secure-test-secret-with-at-least-32-characters",
    aiResponder: () =>
      Promise.resolve(JSON.stringify({
        concepts: [{
          path: "overview.md",
          type: "Overview",
          title: "Test",
          body: "# Test",
          sources: ["README.md"],
        }],
      })),
  };
  let app = await createCollabApp(options);
  let server = Deno.serve(
    { hostname: "127.0.0.1", port: 0, onListen() {} },
    app.fetch,
  );
  let client = new Client(
    `http://127.0.0.1:${(server.addr as Deno.NetAddr).port}`,
  );
  try {
    await client.signUp("Owner", "restart-owner@example.com");
    const setup = await client.request("/api/setup", {
      method: "POST",
      body: JSON.stringify({ name: "Restart test" }),
    });
    assert.equal(setup.status, 200, await setup.text());
    const db = new DatabaseSync(`${dataDir}/hub.db`);
    db.prepare(
      "INSERT INTO okf_repository_source (id, repositoryUrl, folder, status) VALUES ('restart-repository', 'https://example.com/knowledge.git', 'okf', 'current')",
    ).run();
    db.close();
    const checkout = `${dataDir}/sources/restart-repository`;
    await Deno.mkdir(checkout, { recursive: true });
    for (
      const args of [["init", "-q"], [
        "-c",
        "user.name=Test",
        "-c",
        "user.email=test@example.com",
        "commit",
        "--allow-empty",
        "-qm",
        "initial",
      ]]
    ) {
      assert(
        (await new Deno.Command("git", {
          args,
          cwd: checkout,
          stdout: "null",
          stderr: "null",
        }).output()).success,
      );
    }
    await Deno.writeTextFile(`${checkout}/README.md`, "# Test component");
    const path = "/api/sources/repositories/restart-repository/okf-draft";
    const response = await client.request(path, { method: "POST", body: "{}" });
    const body = await response.json();
    assert.equal(response.status, 200, JSON.stringify(body));
    const cookie = client.cookie;
    await server.shutdown();
    await app.close();
    app = await createCollabApp(options);
    server = Deno.serve(
      { hostname: "127.0.0.1", port: 0, onListen() {} },
      app.fetch,
    );
    client = new Client(
      `http://127.0.0.1:${(server.addr as Deno.NetAddr).port}`,
    );
    client.cookie = cookie;
    const approved = await client.request(`${path}/approve`, {
      method: "POST",
      body: JSON.stringify({ draftId: body.draftId }),
    });
    assert.equal(
      approved.status,
      200,
      approved.status === 200 ? undefined : await approved.text(),
    );
    assert.equal(approved.headers.get("content-type"), "application/zip");
    await approved.arrayBuffer();
    assert.equal(
      (await client.request(`${path}/approve`, {
        method: "POST",
        body: JSON.stringify({ draftId: body.draftId }),
      })).status,
      400,
    );
  } finally {
    await server.shutdown();
    await app.close();
    await fga.server.shutdown();
    await Deno.remove(dataDir, { recursive: true });
  }
});
