/// <reference lib="deno.ns" />

import assert from "node:assert/strict";
import { createCollabApp } from "./main.ts";

type Tuple = { user: string; relation: string; object: string };

function templatePermissions() {
  const tuples: Tuple[] = [];
  return Deno.serve(
    { hostname: "127.0.0.1", port: 0, onListen() {} },
    async (request) => {
      const path = new URL(request.url).pathname;
      const body = request.body ? await request.json() : {};
      if (path === "/stores") return Response.json({ id: "store" });
      if (path.endsWith("/authorization-models")) {
        return Response.json({
          authorization_model_id: "model",
        });
      }
      if (path.endsWith("/write")) {
        for (const removed of body.deletes?.tuple_keys ?? []) {
          const index = tuples.findIndex((item) =>
            item.user === removed.user && item.relation === removed.relation &&
            item.object === removed.object
          );
          if (index >= 0) tuples.splice(index, 1);
        }
        tuples.push(...(body.writes?.tuple_keys ?? []));
        return new Response(null, { status: 204 });
      }
      if (path.endsWith("/check")) {
        const { user, relation } = body.tuple_key;
        const member = (group: string) =>
          tuples.some((item) =>
            item.user === user && item.relation === "member" &&
            item.object === group.replace(/#member$/, "")
          );
        const access = (role: string) =>
          tuples.some((item) =>
            item.object === "source:company" && item.relation === role &&
            (item.user === user || member(item.user))
          );
        return Response.json({
          allowed: access("owner") || access("editor") ||
            (relation === "view" && access("viewer")),
        });
      }
      return new Response(null, { status: 404 });
    },
  );
}

class Client {
  cookie = "";
  constructor(readonly base: string) {}
  async send(path: string, data?: unknown, method = "GET") {
    const response = await fetch(`${this.base}${path}`, {
      method,
      headers: {
        "content-type": "application/json",
        ...(this.cookie ? { cookie: this.cookie } : {}),
      },
      ...(data === undefined ? {} : { body: JSON.stringify(data) }),
    });
    this.cookie = response.headers.get("set-cookie")?.match(
      /better-auth\.session_token=[^;]+/,
    )?.[0] ?? this.cookie;
    return {
      status: response.status,
      body: await response.json().catch(() => null),
    };
  }
  async signUp(email: string, invitationId?: string) {
    const result = await this.send("/api/auth/sign-up/email", {
      name: email,
      email,
      password: "password123",
      invitationId,
    }, "POST");
    assert.equal(result.status, 200, JSON.stringify(result.body));
  }
}

Deno.test("template editing authorizes editors, protects built-ins, and changes only future documents", async () => {
  const dataDir = await Deno.makeTempDir();
  const fga = templatePermissions();
  const objects = new Map<string, string>();
  const app = await createCollabApp({
    dataDir,
    authSecret: "a-secure-test-secret-with-at-least-32-characters",
    openfgaURL: `http://127.0.0.1:${(fga.addr as Deno.NetAddr).port}`,
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
    app.fetch,
  );
  const base = `http://127.0.0.1:${(server.addr as Deno.NetAddr).port}`;
  const owner = new Client(base);
  const editor = new Client(base);
  const viewer = new Client(base);
  const anonymous = new Client(base);
  try {
    await owner.signUp("template-owner@example.com");
    assert.equal(
      (await owner.send("/api/setup", { name: "Templates test" }, "POST"))
        .status,
      200,
    );
    for (
      const [client, role] of [[editor, "editor"], [viewer, "viewer"]] as const
    ) {
      const email = `template-${role}@example.com`;
      const invitation = await owner.send("/api/invitations", {
        email,
        access: role,
      }, "POST");
      assert.equal(invitation.status, 200, JSON.stringify(invitation.body));
      await client.signUp(email, invitation.body.id);
      assert.equal(
        (await client.send("/api/invitations/accept", {
          invitationId: invitation.body.id,
        }, "POST")).status,
        200,
      );
    }
    const fields = {
      name: "Team welcome",
      description: "Start here",
      body: "## Welcome {{ team }}\n\nOwned by {{owner}}.",
    };
    const created = await owner.send("/api/templates", fields, "POST");
    assert.equal(created.status, 201, JSON.stringify(created.body));
    assert.deepEqual(created.body.variables, ["team", "owner"]);
    const path = `/api/templates/${created.body.id}`;
    const before = await editor.send("/api/concepts", {
      title: "Before template edit",
      spaceId: "policies",
      type: "Guide",
      templateId: created.body.id,
      variables: { team: "Support", owner: "Sam" },
    }, "POST");
    assert.equal(before.status, 201, JSON.stringify(before.body));
    assert.equal((await anonymous.send(path, fields, "PUT")).status, 401);
    assert.equal((await viewer.send(path, fields, "PUT")).status, 403);
    assert.equal(
      (await editor.send("/api/templates/understanding-brief", fields, "PUT"))
        .status,
      400,
    );
    assert.equal(
      (await editor.send("/api/templates/missing-template", fields, "PUT"))
        .status,
      404,
    );

    for (
      const invalid of [
        null,
        [],
        { ...fields, name: 2 },
        { ...fields, name: " " },
        { ...fields, name: "n".repeat(81) },
        { ...fields, description: 2 },
        { ...fields, description: "d".repeat(241) },
        { ...fields, body: " " },
        { ...fields, body: "a".repeat(512 * 1024 + 1) },
      ]
    ) {
      const result = await editor.send(path, invalid, "PUT");
      assert.equal(result.status, 400, JSON.stringify(result.body));
    }
    assert.equal(
      (await editor.send(
        path,
        { ...fields, name: " understanding BRIEF " },
        "PUT",
      )).status,
      409,
    );
    const other = await editor.send("/api/templates", {
      ...fields,
      name: "Other template",
    }, "POST");
    assert.equal(other.status, 201, JSON.stringify(other.body));
    assert.equal(
      (await editor.send(path, { ...fields, name: "OTHER TEMPLATE" }, "PUT"))
        .status,
      409,
    );

    const updated = await editor.send(path, {
      ...fields,
      name: " Team welcome ",
      body: "## Next {{team}}\n\nContact {{ new_owner }}.",
    }, "PUT");
    assert.equal(updated.status, 200, JSON.stringify(updated.body));
    assert.equal(updated.body.id, created.body.id);
    assert.equal(updated.body.name, "Team welcome");
    assert.equal(updated.body.createdBy, created.body.createdBy);
    assert.equal(updated.body.createdAt, created.body.createdAt);
    assert.deepEqual(updated.body.variables, ["team", "new_owner"]);
    const savedBefore = await editor.send(`/api/concepts/${before.body.id}`);
    assert.equal(
      savedBefore.body.draft,
      "## Welcome Support\n\nOwned by Sam.\n",
    );
    const blankVariable = await editor.send("/api/concepts", {
      title: "Missing value",
      spaceId: "policies",
      type: "Guide",
      templateId: created.body.id,
      variables: { team: " ", new_owner: "Kim" },
    }, "POST");
    assert.equal(blankVariable.status, 400);
    const after = await editor.send("/api/concepts", {
      title: "After template edit",
      spaceId: "policies",
      type: "Guide",
      templateId: created.body.id,
      variables: { team: "Platform", new_owner: "Kim" },
    }, "POST");
    assert.equal(after.status, 201, JSON.stringify(after.body));
    assert.equal(after.body.draft, "## Next Platform\n\nContact Kim.\n");
    const listed = await owner.send("/api/templates");
    const builtIn = listed.body.find((item: { builtIn: boolean }) =>
      item.builtIn
    );
    const copy = await editor.send("/api/templates", {
      name: "Understanding brief copy",
      description: builtIn.description,
      body: builtIn.body,
    }, "POST");
    assert.equal(copy.status, 201, JSON.stringify(copy.body));
    assert.equal(copy.body.builtIn, false);
    assert.notEqual(copy.body.id, builtIn.id);
    assert.equal(
      (await editor.send(
        "/api/templates/understanding-brief",
        undefined,
        "DELETE",
      )).status,
      400,
    );
  } finally {
    await server.shutdown();
    await app.close();
    await fga.shutdown();
    await Deno.remove(dataDir, { recursive: true });
  }
});
