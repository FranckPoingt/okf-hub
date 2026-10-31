/// <reference lib="deno.ns" />

import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import * as Y from "yjs";
import type { Concept, SearchResponse } from "../src/lib/models.ts";
import { utcReviewDay } from "../src/lib/governance.ts";
import { createCollabApp } from "./main.ts";

type Tuple = { user: string; relation: string; object: string };

function fakeOpenFga() {
  const denied = new Set<string>();
  const extraAllowed = new Set<string>();
  let beforeCheck: ((tuple: Tuple) => Promise<void>) | undefined;
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
      await beforeCheck?.(body.tuple_key);
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
        allowed: !denied.has(`${user}:${object}`) &&
          (extraAllowed.has(`${user}:${relation}:${object}`) || owner ||
            editor || (relation === "view" && viewer)),
      });
    }
    return new Response("Not found", { status: 404 });
  };
  const server = Deno.serve(
    { hostname: "127.0.0.1", port: 0, onListen() {} },
    fetch,
  );
  return {
    server,
    tuples,
    denied,
    extraAllowed,
    modelReceived: () => receivedModel,
    interceptChecks(hook?: (tuple: Tuple) => Promise<void>) {
      beforeCheck = hook;
    },
  };
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

async function expectJson<T>(response: Response, status = 200): Promise<T> {
  assert.equal(response.status, status, await response.clone().text());
  return await response.json();
}

Deno.test("migrates native governance without inventing ownership or reviews", async () => {
  const dataDir = await Deno.makeTempDir();
  const legacy = new DatabaseSync(`${dataDir}/hub.db`);
  legacy.exec(`
    CREATE TABLE okf_concept (
      id TEXT PRIMARY KEY, title TEXT NOT NULL, type TEXT NOT NULL,
      status TEXT NOT NULL, publishedRevision INTEGER,
      createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL
    );
    INSERT INTO okf_concept VALUES ('existing', 'Existing guide', 'Guide', 'active', 3, '2020-01-01', '2020-01-02');
  `);
  legacy.close();
  const app = await createCollabApp({ dataDir });
  try {
    const db = new DatabaseSync(`${dataDir}/hub.db`);
    assert.deepEqual({
      ...db.prepare(
        `SELECT ownerUserId, reviewDueDate, reviewedRevision, reviewedAt, reviewedBy,
      publishedRevision, updatedAt FROM okf_concept WHERE id = 'existing'`,
      ).get(),
    }, {
      ownerUserId: null,
      reviewDueDate: null,
      reviewedRevision: null,
      reviewedAt: null,
      reviewedBy: null,
      publishedRevision: 3,
      updatedAt: "2020-01-02",
    });
    db.close();
  } finally {
    await app.close();
    await Deno.remove(dataDir, { recursive: true });
  }
});

Deno.test("governs exact published revisions without changing content or leaking membership", async () => {
  const dataDir = await Deno.makeTempDir();
  const fga = fakeOpenFga();
  const objects = new Map<string, string>();
  const app = await createCollabApp({
    dataDir,
    authSecret: "a-secure-test-secret-with-at-least-32-characters",
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
          : Promise.reject(new Error("Object not found"));
      },
      remove(key) {
        objects.delete(key);
        return Promise.resolve();
      },
    },
  });
  const server = Deno.serve(
    { hostname: "127.0.0.1", port: 0, onListen() {} },
    (request) => {
      if (request.headers.get("upgrade") === "websocket") {
        const headers = new Headers(request.headers);
        headers.set("cookie", editor.cookie);
        Object.defineProperty(request, "headers", { value: headers });
      }
      return app.fetch(request);
    },
  );
  const base = `http://127.0.0.1:${(server.addr as Deno.NetAddr).port}`;
  const owner = new Client(base);
  const editor = new Client(base);
  const viewer = new Client(base);
  const stranger = new Client(base);
  const anonymous = new Client(base);
  const db = new DatabaseSync(`${dataDir}/hub.db`);
  let releaseCheck = () => {};
  let collaboration: WebSocket | undefined;
  try {
    // A real account in another workspace must not become an ownership candidate.
    await stranger.signUp("Stranger", "governance-stranger@example.com");
    await owner.signUp("Owner", "governance-owner@example.com");
    await expectJson(
      await owner.request("/api/setup", {
        method: "POST",
        body: JSON.stringify({ name: "Governance test" }),
      }),
    );
    for (
      const [client, name, access] of [[editor, "Editor", "editor"], [
        viewer,
        "Viewer",
        "viewer",
      ]] as const
    ) {
      const email = `governance-${access}@example.com`;
      const invitation = await expectJson<{ id: string }>(
        await owner.request("/api/invitations", {
          method: "POST",
          body: JSON.stringify({ email, access }),
        }),
      );
      await client.signUp(name, email, invitation.id);
      await expectJson(
        await client.request("/api/invitations/accept", {
          method: "POST",
          body: JSON.stringify({ invitationId: invitation.id }),
        }),
      );
    }
    const ownerId =
      (db.prepare('SELECT id FROM "user" WHERE name = ?').get("Owner") as {
        id: string;
      }).id;
    const editorId =
      (db.prepare('SELECT id FROM "user" WHERE name = ?').get("Editor") as {
        id: string;
      }).id;
    const viewerId =
      (db.prepare('SELECT id FROM "user" WHERE name = ?').get("Viewer") as {
        id: string;
      }).id;
    const strangerId =
      (db.prepare('SELECT id FROM "user" WHERE name = ?').get("Stranger") as {
        id: string;
      }).id;
    db.prepare(
      "INSERT INTO organization (id, name, slug, createdAt) VALUES (?, ?, ?, ?)",
    ).run("other-workspace", "Other", "other", Date.now());
    db.prepare(
      "INSERT INTO member (id, organizationId, userId, role, createdAt) VALUES (?, ?, ?, ?, ?)",
    ).run("foreign-member", "other-workspace", strangerId, "owner", Date.now());

    const created = await expectJson<Concept>(
      await editor.request("/api/concepts", {
        method: "POST",
        body: JSON.stringify({
          title: "Governed guide",
          type: "Guide",
          spaceId: "policies",
        }),
      }),
      201,
    );
    const path = `/api/concepts/${created.id}`;
    const read = (client = editor) =>
      client.request(path).then((response) => expectJson<Concept>(response));
    const putGovernance = (body: unknown, client = editor) =>
      client.request(`${path}/governance`, {
        method: "PUT",
        body: JSON.stringify(body),
      });
    const review = (body: unknown, client = editor) =>
      client.request(`${path}/review`, {
        method: "POST",
        body: JSON.stringify(body),
      });
    const publish = (markdown: string) =>
      editor.request(`${path}/publish`, {
        method: "POST",
        body: JSON.stringify({ markdown }),
      }).then((response) => expectJson<Concept>(response));
    const search = (suffix = "", client = viewer) =>
      client.request(`/api/search?${suffix}`).then((response) =>
        expectJson<SearchResponse>(response)
      );
    const today = utcReviewDay();
    const past = "2000-01-01";
    const future = "2099-12-31";
    assert.equal(created.ownerUserId, editorId);
    assert.deepEqual(created.owner, { id: editorId, name: "Editor" });
    assert.deepEqual(created.freshness, {
      status: "unpublished",
      reason: "not_published",
    });
    await expectJson(await putGovernance({ ownerUserId: null }));
    for (const attention of ["unowned", "unreviewed", "overdue"]) {
      assert.equal(
        (await search(`attention=${attention}&includeArchived=true`, editor))
          .results.length,
        0,
      );
    }
    await expectJson(await putGovernance({ ownerUserId: editorId }));
    await expectJson(await review({ publishedRevision: 1 }), 409);
    assert.equal((await anonymous.request(`${path}/owners`)).status, 401);
    assert.equal((await viewer.request(`${path}/owners`)).status, 404);
    assert.equal((await stranger.request(`${path}/owners`)).status, 404);
    assert.equal(
      (await putGovernance({ ownerUserId: viewerId }, viewer)).status,
      404,
    );
    assert.equal((await review({ publishedRevision: 1 }, viewer)).status, 404);
    assert.equal((await putGovernance({ ownerUserId: viewerId })).status, 400);
    assert.equal(
      (await putGovernance({ ownerUserId: "unknown-user" })).status,
      400,
    );
    // Even a stray FGA grant cannot substitute for current workspace membership.
    fga.extraAllowed.add(`user:${strangerId}:edit:concept:${created.id}`);
    assert.equal(
      (await putGovernance({ ownerUserId: strangerId })).status,
      400,
    );
    const choices = await expectJson<{ id: string; name: string }[]>(
      await editor.request(`${path}/owners`),
    );
    assert.deepEqual(
      new Set(choices.map((person) => person.id)),
      new Set([ownerId, editorId]),
    );
    assert.ok(
      choices.every((person) =>
        Object.keys(person).sort().join(",") === "id,name"
      ),
    );
    assert.equal(
      (await expectJson<{ members: unknown[] }>(
        await editor.request("/api/bootstrap"),
      )).members.length,
      0,
    );
    assert.equal(
      (await expectJson<{ members: unknown[] }>(
        await viewer.request("/api/bootstrap"),
      )).members.length,
      0,
    );

    for (
      const invalid of [
        "2025-02-29",
        "2026-02-30",
        "2026-13-01",
        "2026-1-01",
        "2026-02-01T00:00:00Z",
        20260101,
        false,
        {},
      ]
    ) {
      assert.equal(
        (await putGovernance({ reviewDueDate: invalid })).status,
        400,
        JSON.stringify(invalid),
      );
    }
    assert.equal((await putGovernance({ ownerUserId: false })).status, 400);
    assert.equal((await putGovernance({ reviewedRevision: 99 })).status, 400);
    await expectJson(await putGovernance({ reviewDueDate: "2028-02-29" }));
    const published = await publish(
      "# Public guide\n\nConfirmed public body.\n",
    );
    assert.equal(published.publishedRevision, 1);
    // Persist a genuine collaborative update, then prove review never changes its snapshot.
    collaboration = new WebSocket(
      `${
        base.replace("http", "ws")
      }/collab?conceptId=${created.id}&epoch=${published.collabEpoch}`,
    );
    await new Promise<void>((resolve, reject) => {
      collaboration!.addEventListener("open", () => resolve(), { once: true });
      collaboration!.addEventListener(
        "error",
        () => reject(new Error("Collaboration failed")),
        { once: true },
      );
    });
    const collabDoc = new Y.Doc();
    collabDoc.getText("governance-test").insert(
      0,
      "Stable collaborative state",
    );
    const update = Y.encodeStateAsUpdate(collabDoc);
    const frame = new Uint8Array(update.length + 1);
    frame.set(update, 1);
    collaboration.send(frame);
    const collabPath = `${dataDir}/concepts/${created.id}.yjs`;
    for (let attempt = 0; attempt < 50; attempt++) {
      if (await Deno.stat(collabPath).then(() => true).catch(() => false)) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.ok((await Deno.stat(collabPath)).size > 0);
    collabDoc.destroy();
    const filesBeforeReview = await Promise.all(
      ["md", "yjs"].map((extension) =>
        Deno.readFile(`${dataDir}/concepts/${created.id}.${extension}`).catch(
          (error) => {
            if (error instanceof Deno.errors.NotFound) return null;
            throw error;
          },
        )
      ),
    );
    const objectsBeforeReview = [...objects.entries()];
    const permissionsBeforeReview = structuredClone(fga.tuples);
    const contentBasis = (value: Concept) => ({
      draft: value.draft,
      published: value.published,
      updatedAt: value.updatedAt,
      title: value.title,
      type: value.type,
      collabEpoch: value.collabEpoch,
      publishedRevision: value.publishedRevision,
      hasUnpublishedChanges: value.hasUnpublishedChanges,
    });
    const basis = contentBasis(published);
    const patched = await expectJson<Concept>(
      await putGovernance({ ownerUserId: ownerId }),
    );
    assert.equal(patched.reviewDueDate, "2028-02-29");
    assert.deepEqual(contentBasis(patched), basis);
    assert.equal((await putGovernance({ reviewDueDate: past })).status, 200);
    assert.equal((await review({ publishedRevision: 1 })).status, 400);
    assert.equal(
      (await review({ publishedRevision: 1, reviewDueDate: past })).status,
      400,
    );
    for (const bad of [null, "1", 0, 1.5]) {
      assert.equal((await review({ publishedRevision: bad })).status, 400);
    }
    assert.equal(
      (await review({ publishedRevision: 2, reviewDueDate: future })).status,
      409,
    );
    const marked = await expectJson<Concept>(
      await review({ publishedRevision: 1, reviewDueDate: future }),
    );
    assert.equal(marked.reviewedRevision, 1);
    assert.equal(marked.reviewedBy, editorId);
    assert.deepEqual(marked.reviewer, { id: editorId, name: "Editor" });
    assert.deepEqual(marked.freshness, {
      status: "current",
      reason: "reviewed",
    });
    assert.deepEqual(contentBasis(marked), basis);
    assert.deepEqual([...objects.entries()], objectsBeforeReview);
    assert.deepEqual(fga.tuples, permissionsBeforeReview);
    const filesAfterReview = await Promise.all(
      ["md", "yjs"].map((extension) =>
        Deno.readFile(`${dataDir}/concepts/${created.id}.${extension}`).catch(
          (error) => {
            if (error instanceof Deno.errors.NotFound) return null;
            throw error;
          },
        )
      ),
    );
    assert.deepEqual(filesAfterReview, filesBeforeReview);

    const visible = await read(viewer);
    assert.deepEqual(visible.owner, { id: ownerId, name: "Owner" });
    assert.equal(visible.draft, null);
    assert.deepEqual(visible.freshness, marked.freshness);
    assert.ok(
      !JSON.stringify(visible).includes("governance-editor@example.com"),
    );
    const listed = await expectJson<Concept[]>(
      await viewer.request("/api/concepts"),
    );
    assert.deepEqual(
      listed.find((item) => item.id === created.id)?.freshness,
      marked.freshness,
    );
    const action = await expectJson<{ result: Concept }>(
      await viewer.request("/api/v1/actions/documents.get", {
        method: "POST",
        body: JSON.stringify({ id: created.id }),
      }),
    );
    assert.deepEqual(action.result.freshness, marked.freshness);
    let result = (await search()).results.find((item) =>
      item.id === created.id
    )!;
    assert.equal(result.owner, "Owner");
    assert.equal(result.trust, "current");
    assert.deepEqual(result.freshness, marked.freshness);
    assert.equal(result.reviewer?.id, editorId);
    assert.equal(
      (await search("attention=unreviewed")).results.some((item) =>
        item.id === created.id
      ),
      false,
    );
    await expectJson(await putGovernance({ reviewDueDate: today }));
    result = (await search()).results.find((item) => item.id === created.id)!;
    assert.equal(result.freshness?.status, "due");
    assert.equal(result.trust, "current");
    assert.equal((await search("attention=overdue")).results.length, 0);
    await expectJson(await putGovernance({ reviewDueDate: past }));
    assert.equal((await read(viewer)).freshness.status, "overdue");
    result = (await search("attention=overdue")).results.find((item) =>
      item.id === created.id
    )!;
    // Review deadlines are advisory; only sources and dependencies change trust.
    assert.equal(result.freshness?.status, "overdue");
    assert.equal(result.trust, "current");
    await expectJson(
      await review({ publishedRevision: 1, reviewDueDate: null }),
    );
    assert.equal((await read()).reviewDueDate, null);
    assert.equal((await read()).freshness.status, "current");

    // Independent patches must not overwrite each other's fields after authorization awaits.
    const patchedTogether = await Promise.all([
      putGovernance({ ownerUserId: editorId }),
      putGovernance({ reviewDueDate: future }),
    ]);
    for (const response of patchedTogether) await expectJson(response);
    assert.equal((await read()).ownerUserId, editorId);
    assert.equal((await read()).reviewDueDate, future);
    assert.deepEqual(contentBasis(await read()), basis);
    await expectJson(await putGovernance({}));
    await expectJson(await putGovernance({ ownerUserId: null }));
    assert.equal(
      (await search("attention=unowned")).results.find((item) =>
        item.id === created.id
      )?.owner,
      "",
    );
    await expectJson(await putGovernance({ ownerUserId: editorId }));

    assert.equal(
      (await editor.request(path, {
        method: "PUT",
        body: "# Private replacement draft\n",
      })).status,
      204,
    );
    const draftEdited = await read();
    assert.equal(draftEdited.hasUnpublishedChanges, true);
    assert.equal((await read(viewer)).freshness.status, "current");
    assert.equal((await read(viewer)).published, published.published);
    const editorDraftResult = (await search("", editor)).results.find((item) =>
      item.id === created.id
    )!;
    const readerPublishedResult = (await search()).results.find((item) =>
      item.id === created.id
    )!;
    assert.equal(editorDraftResult.hasUnpublishedChanges, true);
    assert.equal(editorDraftResult.freshness?.status, "current");
    assert.equal(readerPublishedResult.freshness?.status, "current");
    assert.equal(
      Object.hasOwn(readerPublishedResult, "hasUnpublishedChanges"),
      false,
    );
    const readerSearchAction = await expectJson<{ result: SearchResponse }>(
      await viewer.request("/api/v1/actions/knowledge.search", {
        method: "POST",
        body: JSON.stringify({ query: "Governed" }),
      }),
    );
    assert.equal(
      Object.hasOwn(
        readerSearchAction.result.results.find((item) =>
          item.id === created.id
        )!,
        "hasUnpublishedChanges",
      ),
      false,
    );
    const second = await publish("# Revised public guide\n");
    assert.equal(second.publishedRevision, 2);
    assert.equal(
      (await search("", editor)).results.find((item) => item.id === created.id)
        ?.hasUnpublishedChanges,
      false,
    );
    assert.deepEqual(second.freshness, {
      status: "unreviewed",
      reason: "revision_changed",
    });
    assert.equal(
      (await search("attention=unreviewed")).results.some((item) =>
        item.id === created.id
      ),
      true,
    );
    assert.equal((await review({ publishedRevision: 1 })).status, 409);
    await expectJson(await putGovernance({ reviewDueDate: today }));
    result = (await search()).results.find((item) => item.id === created.id)!;
    assert.equal(result.freshness?.status, "due");
    assert.equal(result.trust, "current");
    await expectJson(await putGovernance({ reviewDueDate: future }));

    // Pause review authorization while another editor publishes a new revision.
    let enteredCheck = () => {};
    const entered = new Promise<void>((resolve) => {
      enteredCheck = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      releaseCheck = resolve;
    });
    let intercepted = false;
    fga.interceptChecks(async (tuple) => {
      if (
        !intercepted && tuple.user === `user:${editorId}` &&
        tuple.relation === "edit" && tuple.object === `concept:${created.id}`
      ) {
        intercepted = true;
        enteredCheck();
        await gate;
      }
    });
    const racingReview = review({ publishedRevision: 2 });
    await entered;
    const third = await expectJson<Concept>(
      await owner.request(`${path}/publish`, {
        method: "POST",
        body: JSON.stringify({ markdown: "# Third published version\n" }),
      }),
    );
    assert.equal(third.publishedRevision, 3);
    releaseCheck();
    assert.equal((await racingReview).status, 409);
    fga.interceptChecks();
    assert.equal((await read()).reviewedRevision, 1);
    const thirdReview = await expectJson<Concept>(
      await review({ publishedRevision: 3, reviewDueDate: null }),
    );
    assert.equal(thirdReview.freshness.status, "current");
    const restored = await expectJson<Concept>(
      await editor.request(`${path}/revisions/1/restore`, { method: "POST" }),
    );
    assert.equal(restored.publishedRevision, 3);
    assert.equal(restored.reviewedRevision, 3);
    assert.equal(restored.freshness.status, "current");
    assert.equal(restored.hasUnpublishedChanges, true);
    assert.equal((await read(viewer)).published, third.published);
    const audit = thirdReview.activity.find((event) =>
      event.action === "concept.reviewed" &&
      event.target === `concept:${created.id}:revision:3`
    );
    assert.equal(audit?.actorUserId, editorId);

    // Relationship badges come from the same permission-filtered review summary.
    const linkDoc = await expectJson<Concept>(
      await editor.request("/api/concepts", {
        method: "POST",
        body: JSON.stringify({
          title: "Link guide",
          type: "Guide",
          spaceId: "policies",
        }),
      }),
      201,
    );
    await expectJson(
      await editor.request(`/api/concepts/${linkDoc.id}/publish`, {
        method: "POST",
        body: JSON.stringify({
          markdown: `[Governed](/knowledge/${created.id})\n`,
        }),
      }),
    );
    const relationships = (await search()).results.find((item) =>
      item.id === linkDoc.id
    )?.links;
    assert.equal(
      relationships?.find((item) => item.id === created.id)?.freshness?.status,
      "current",
    );
    assert.equal(
      (await search("attention=unreviewed")).results.some((item) =>
        item.id === linkDoc.id
      ),
      true,
    );
    const queryAction = await expectJson<{ result: SearchResponse }>(
      await viewer.request("/api/v1/actions/knowledge.search", {
        method: "POST",
        body: JSON.stringify({ attention: "unreviewed" }),
      }),
    );
    assert.equal(
      queryAction.result.results.some((item) => item.id === linkDoc.id),
      true,
    );
    assert.equal(
      (await viewer.request("/api/search?attention=unsupported")).status,
      400,
    );
    assert.equal(
      (await viewer.request("/api/v1/actions/knowledge.search", {
        method: "POST",
        body: JSON.stringify({ attention: "unsupported" }),
      })).status,
      400,
    );

    // A lost document permission or departed member no longer counts as an active owner.
    fga.denied.add(`user:${editorId}:concept:${created.id}`);
    assert.equal((await read(viewer)).owner, null);
    const filteredChoices = await expectJson<{ id: string; name: string }[]>(
      await owner.request(`${path}/owners`),
    );
    assert.equal(filteredChoices.some((item) => item.id === editorId), false);
    assert.equal(
      (await putGovernance({ ownerUserId: editorId }, owner)).status,
      400,
    );
    fga.denied.delete(`user:${editorId}:concept:${created.id}`);
    db.prepare("DELETE FROM member WHERE userId = ? AND organizationId != ?")
      .run(editorId, "other-workspace");
    const departed = await read(viewer);
    assert.equal(departed.owner, null);
    assert.deepEqual(departed.reviewer, {
      id: editorId,
      name: "Former member",
    });
    assert.equal(
      (await search("attention=unowned")).results.some((item) =>
        item.id === created.id
      ),
      true,
    );
    await expectJson(await putGovernance({ ownerUserId: ownerId }, owner));
    assert.equal((await read(viewer)).reviewer?.name, "Former member");

    fga.denied.add(`user:${viewerId}:concept:${created.id}`);
    assert.equal((await viewer.request(path)).status, 404);
    assert.equal(
      (await search()).results.some((item) => item.id === created.id),
      false,
    );
    assert.equal(
      (await search()).results.find((item) => item.id === linkDoc.id)?.links
        .length,
      0,
    );
    fga.denied.delete(`user:${viewerId}:concept:${created.id}`);
    await expectJson(
      await owner.request(`${path}/metadata`, {
        method: "PUT",
        body: JSON.stringify({ intent: "ephemeral" }),
      }),
    );
    const intentDraft = await read(owner);
    assert.equal(intentDraft.intent, "ephemeral");
    assert.equal(intentDraft.publishedMetadata?.intent, "canonical");
    assert.equal(intentDraft.hasUnpublishedChanges, true);
    assert.equal((await read(viewer)).intent, "canonical");
    const intentPublished = await expectJson<Concept>(
      await owner.request(`${path}/publish`, {
        method: "POST",
        body: JSON.stringify({ markdown: third.published }),
      }),
    );
    assert.equal(intentPublished.publishedRevision, 4);
    assert.equal(intentPublished.publishedMetadata?.intent, "ephemeral");
    assert.equal(intentPublished.hasUnpublishedChanges, false);
    assert.equal((await read(viewer)).intent, "ephemeral");
    // Search attention deliberately remains exhaustive across published document intents.
    assert.equal(
      (await search("attention=unreviewed")).results.some((item) =>
        item.id === created.id
      ),
      true,
    );
    await expectJson(
      await owner.request(`${path}/archive`, { method: "POST" }),
    );
    assert.equal((await review({ publishedRevision: 4 }, owner)).status, 409);
    assert.equal(
      (await putGovernance({ reviewDueDate: future }, owner)).status,
      409,
    );
    assert.equal((await viewer.request(path)).status, 404);
    await owner.request(`/api/concepts/${linkDoc.id}/archive`, {
      method: "POST",
    });
    for (const attention of ["unowned", "unreviewed", "overdue"]) {
      assert.equal(
        (await search(`attention=${attention}&includeArchived=true`, owner))
          .results.length,
        0,
      );
    }
  } finally {
    releaseCheck();
    if (collaboration && collaboration.readyState !== WebSocket.CLOSED) {
      const closed = new Promise<void>((resolve) =>
        collaboration!.addEventListener("close", () => resolve(), {
          once: true,
        })
      );
      collaboration.close();
      await closed;
    }
    await server.shutdown();
    await app.close();
    db.close();
    await fga.server.shutdown();
    await Deno.remove(dataDir, { recursive: true });
  }
});
