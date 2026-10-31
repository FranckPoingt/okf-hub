/// <reference lib="deno.ns" />

import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { bootstrapOwner, runAdmin } from "./admin.ts";
import { createCollabApp } from "./main.ts";

type Tuple = { user: string; relation: string; object: string };

// Owners hold source:company; everyone else is allowed through group tuples.
function fakeOpenFga() {
  const tuples: Tuple[] = [];
  const server = Deno.serve(
    { hostname: "127.0.0.1", port: 0, onListen() {} },
    async (request) => {
      const url = new URL(request.url);
      const body = request.body ? await request.json() : {};
      if (url.pathname === "/stores") return Response.json({ id: "store" });
      if (url.pathname.endsWith("/authorization-models")) {
        return Response.json({ authorization_model_id: "model" });
      }
      if (url.pathname.endsWith("/write")) {
        for (const deleted of body.deletes?.tuple_keys ?? []) {
          const index = tuples.findIndex((tuple) =>
            tuple.user === deleted.user &&
            tuple.relation === deleted.relation &&
            tuple.object === deleted.object
          );
          if (index < 0) return new Response("missing", { status: 400 });
          tuples.splice(index, 1);
        }
        for (const written of body.writes?.tuple_keys ?? []) {
          if (
            tuples.some((tuple) =>
              tuple.user === written.user &&
              tuple.relation === written.relation &&
              tuple.object === written.object
            )
          ) return new Response("duplicate", { status: 400 });
          tuples.push(written);
        }
        return new Response(null, { status: 204 });
      }
      const { user } = body.tuple_key;
      return Response.json({
        allowed: tuples.some((tuple) => tuple.user === user) ||
          tuples.some((tuple) =>
            tuple.relation === "member" && tuple.user === user
          ),
      });
    },
  );
  return { server, tuples };
}

class Client {
  cookie = "";
  constructor(readonly base: string) {}

  async request(path: string, init: RequestInit = {}) {
    const headers = new Headers(init.headers);
    if (this.cookie) headers.set("cookie", this.cookie);
    if (init.body) headers.set("content-type", "application/json");
    // Browsers send this; Better Auth rejects cookie-authenticated POSTs without it.
    headers.set("origin", "http://localhost:3000");
    const response = await fetch(`${this.base}${path}`, {
      redirect: "manual",
      ...init,
      headers,
    });
    const cookie = response.headers.get("set-cookie")?.match(
      /better-auth\.session_token=[^;]+/,
    )?.[0];
    if (cookie) this.cookie = cookie;
    return response;
  }

  post(path: string, body: unknown, method = "POST") {
    return this.request(path, { method, body: JSON.stringify(body) });
  }

  async me() {
    const result = await (await this.request("/api/bootstrap")).json();
    return result as {
      user: { id: string; email: string } | null;
      access?: string;
      signupAllowed?: boolean;
      setupTokenRequired?: boolean;
      passwordChangeRequired?: boolean;
      members?: { id: string; email: string; access: string }[];
    };
  }
}

async function start() {
  const dataDir = await Deno.makeTempDir();
  const fga = fakeOpenFga();
  const app = await createCollabApp({
    dataDir,
    authSecret: "a-secure-test-secret-with-at-least-32-characters",
    openfgaURL: `http://127.0.0.1:${(fga.server.addr as Deno.NetAddr).port}`,
    automationIntervalMs: 0,
    requireSetupToken: true,
  });
  const server = Deno.serve(
    { hostname: "127.0.0.1", port: 0, onListen() {} },
    app.fetch,
  );
  const base = `http://127.0.0.1:${(server.addr as Deno.NetAddr).port}`;
  const output: string[] = [];
  return {
    app,
    base,
    fga,
    dataDir,
    output,
    admin: async (...args: string[]) => {
      output.length = 0;
      await runAdmin(app.security, args, (line) => output.push(line));
      return output.join("\n");
    },
    async stop() {
      await server.shutdown();
      await fga.server.shutdown();
      await app.close();
      await Deno.remove(dataDir, { recursive: true });
    },
  };
}

const signUp = (client: Client, email: string, extra = {}) =>
  client.post("/api/auth/sign-up/email", {
    name: email.split("@")[0],
    email,
    password: "password123",
    ...extra,
  });

Deno.test("the first account needs the one-time setup token", async () => {
  const hub = await start();
  try {
    const visitor = new Client(hub.base);
    const anonymous = await visitor.me();
    assert.equal(anonymous.signupAllowed, true);
    assert.equal(anonymous.setupTokenRequired, true);
    assert.equal((await signUp(visitor, "agent@example.com")).status, 403);
    assert.equal(
      (await signUp(visitor, "agent@example.com", { setupToken: "guess" }))
        .status,
      403,
    );

    const setup = await hub.admin("setup-url");
    const token = new URL(setup.split(" ").at(-1)!).searchParams.get("setup");
    assert.ok(token && token.length >= 32);
    const human = new Client(hub.base);
    const created = await signUp(human, "human@example.com", {
      setupToken: token,
    });
    assert.equal(created.status, 200, await created.text());
    assert.equal(
      (await signUp(new Client(hub.base), "late@example.com", {
        setupToken: token,
      })).status,
      403,
    );
    assert.equal(await hub.admin("setup-url"), "");
    assert.equal((await new Client(hub.base).me()).signupAllowed, false);
  } finally {
    await hub.stop();
  }
});

Deno.test("host operators recover access without wiping data", async () => {
  const hub = await start();
  try {
    const token = new URL((await hub.admin("setup-url")).split(" ").at(-1)!)
      .searchParams.get("setup");
    // An agent claims the instance with credentials nobody else knows.
    const agent = new Client(hub.base);
    await signUp(agent, "agent@example.com", { setupToken: token });
    assert.equal(
      (await agent.post("/api/setup", { name: "Acme" })).status,
      200,
    );
    const agentId = (await agent.me()).user!.id;

    // None of the operator operations are reachable over HTTP.
    const outsider = new Client(hub.base);
    assert.equal(
      (await outsider.post("/api/auth/sign-in/magic-link", {
        email: "agent@example.com",
      })).status,
      404,
    );
    assert.equal(
      (await signUp(outsider, "outsider@example.com", {
        setupToken: token,
      })).status,
      403,
    );
    for (const path of ["/api/admin/users", "/api/admin/make-owner"]) {
      assert.notEqual((await outsider.post(path, {})).status, 200);
    }

    // create-owner works although signup is invitation-only.
    const created = await hub.admin(
      "create-owner",
      "human@example.com",
      "--name",
      "Human",
    );
    const password = created.split("\n").at(-1)!;
    assert.ok(password.length >= 32);
    const human = new Client(hub.base);
    const humanSignIn = await human.post("/api/auth/sign-in/email", {
      email: "human@example.com",
      password,
    });
    assert.equal(humanSignIn.status, 200, await humanSignIn.text());
    const me = await human.me();
    assert.equal(me.access, "owner");
    assert.equal(me.passwordChangeRequired, true);
    const changed = await human.post("/api/auth/change-password", {
      currentPassword: password,
      newPassword: "human-password",
      revokeOtherSessions: true,
    });
    assert.equal(changed.status, 200, await changed.text());
    assert.equal((await human.me()).passwordChangeRequired, false);

    // reset-password revokes the agent's sessions.
    assert.equal((await agent.me()).user?.id, agentId);
    const reset = (await hub.admin("reset-password", "agent@example.com"))
      .split("\n").at(-1)!;
    assert.equal((await agent.me()).user, null);
    assert.equal(
      (await agent.post("/api/auth/sign-in/email", {
        email: "agent@example.com",
        password: "password123",
      })).status,
      401,
    );
    assert.equal(
      (await agent.post("/api/auth/sign-in/email", {
        email: "agent@example.com",
        password: reset,
      })).status,
      200,
    );

    // A login link signs in once and expires after use.
    const link = (await hub.admin("login-link", "human@example.com"))
      .split("\n").at(-1)!;
    const local = new URL(link);
    const browser = new Client(hub.base);
    const signedIn = await browser.request(`${local.pathname}${local.search}`);
    assert.equal(signedIn.status, 302);
    assert.equal((await browser.me()).user?.email, "human@example.com");
    const reused = new Client(hub.base);
    await reused.request(`${local.pathname}${local.search}`);
    assert.equal((await reused.me()).user, null);

    // make-owner is idempotent and writes one OpenFGA owner tuple.
    const invite = await human.post("/api/invitations", {
      email: "editor@example.com",
      access: "editor",
    });
    const { id: invitationId } = await invite.json();
    const editor = new Client(hub.base);
    await signUp(editor, "editor@example.com", { invitationId });
    await editor.post("/api/invitations/accept", { invitationId });
    const editorId = (await editor.me()).user!.id;
    assert.match(
      await hub.admin("make-owner", "editor@example.com"),
      /now a workspace owner/,
    );
    assert.match(
      await hub.admin("make-owner", "editor@example.com"),
      /already a workspace owner/,
    );
    assert.equal(
      hub.fga.tuples.filter((tuple) =>
        tuple.user === `user:${editorId}` && tuple.relation === "owner"
      ).length,
      1,
    );
    assert.equal((await editor.me()).access, "owner");

    // Owners promote and demote others, never themselves or the last owner.
    assert.equal(
      (await editor.post(
        `/api/members/${agentId}/owner`,
        { owner: false },
        "PUT",
      ))
        .status,
      200,
    );
    assert.equal((await agent.me()).access, "editor");
    assert.equal(
      (await agent.post(
        `/api/members/${editorId}/owner`,
        { owner: false },
        "PUT",
      ))
        .status,
      403,
    );
    assert.equal(
      (await editor.post(
        `/api/members/${editorId}/owner`,
        { owner: false },
        "PUT",
      ))
        .status,
      400,
    );
    const humanId = (await human.me()).user!.id;
    assert.equal(
      (await editor.post(
        `/api/members/${humanId}/owner`,
        { owner: false },
        "PUT",
      ))
        .status,
      200,
    );
    await assert.rejects(
      () => hub.app.security.setOwner(editorId, false),
      /at least one owner/,
    );

    // The bootstrap owner is ensured idempotently and never demotes anyone.
    const log: string[] = [];
    assert.equal(
      await bootstrapOwner(
        hub.app.security,
        "boss@example.com",
        (line) => log.push(line),
      ),
      true,
    );
    assert.match(log[0], /magic-link\/verify/);
    assert.equal(
      await bootstrapOwner(hub.app.security, "boss@example.com", () => {}),
      false,
    );
    assert.equal(
      await bootstrapOwner(hub.app.security, "editor@example.com", () => {}),
      false,
    );
    const owners = (await editor.me()).members!.filter((member) =>
      member.access === "owner"
    ).map((member) => member.email).sort();
    assert.deepEqual(owners, ["boss@example.com", "editor@example.com"]);

    assert.match(await hub.admin("users"), /boss@example\.com\tboss\towner/);
    const db = new DatabaseSync(`${hub.dataDir}/hub.db`);
    const actions = (db.prepare(
      "SELECT action FROM okf_audit WHERE actorUserId = 'host-operator' ORDER BY id",
    ).all() as { action: string }[]).map((row) => row.action);
    db.close();
    assert.deepEqual(actions, [
      "account.created",
      "owner.granted",
      "password.reset",
      "login_link.created",
      "owner.granted",
      "account.bootstrapped",
      "owner.granted",
    ]);
  } finally {
    await hub.stop();
  }
});

Deno.test("bootstrap owner before setup claims the fresh instance", async () => {
  const hub = await start();
  try {
    assert.ok(await hub.admin("setup-url"));
    assert.equal(
      await bootstrapOwner(hub.app.security, "boss@example.com", () => {}),
      true,
    );
    assert.equal(await hub.admin("setup-url"), "");
    assert.equal(
      (await signUp(new Client(hub.base), "agent@example.com")).status,
      403,
    );
    assert.match(
      await hub.admin("make-owner", "boss@example.com"),
      /No workspace exists yet/,
    );
  } finally {
    await hub.stop();
  }
});
