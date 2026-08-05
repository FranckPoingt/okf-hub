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

Deno.test("enforces owner, editor, viewer, outsider, listing, and audit access", async () => {
  const dataDir = await Deno.makeTempDir();
  const staticDir = `${dataDir}/dist`;
  await Deno.mkdir(staticDir);
  await Deno.writeTextFile(
    `${staticDir}/index.html`,
    "<!doctype html><title>OKF Hub</title>",
  );
  const fga = fakeOpenFga();
  const fgaPort = (fga.server.addr as Deno.NetAddr).port;
  const app = await createCollabApp({
    dataDir,
    staticDir,
    authSecret: "a-secure-test-secret-with-at-least-32-characters",
    openfgaURL: `http://127.0.0.1:${fgaPort}`,
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
      await (await owner.request("/api/concepts/incident-communication"))
        .text(),
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
    assert.equal(
      (await editor.request("/api/concepts/incident-communication", {
        method: "PUT",
        body: "# Edited\n",
      })).status,
      204,
    );
    assert.equal(
      (await viewer.request("/api/concepts/incident-communication")).status,
      200,
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
