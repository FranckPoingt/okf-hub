/// <reference lib="deno.ns" />

import assert from "node:assert/strict";
import type { AIRequest } from "./ai.ts";
import { createCollabApp } from "./main.ts";
import { syncRepository } from "./repository-source.ts";

type Tuple = { user: string; relation: string; object: string };
type Rewrite = {
  this?: unknown;
  computedUserset?: { relation: string };
  tupleToUserset?: {
    tupleset: { relation: string };
    computedUserset: { relation: string };
  };
  union?: { child: Rewrite[] };
};

// Evaluates the authorization model the hub actually uploads, so these
// assertions exercise the real relations instead of a hand-written shortcut.
function modelOpenFga() {
  const tuples: Tuple[] = [];
  let types: { type: string; relations?: Record<string, Rewrite> }[] = [];
  let writes = 0;
  const allowed = (
    user: string,
    relation: string,
    object: string,
    depth = 0,
  ): boolean => {
    const rewrite = types.find((item) => item.type === object.split(":")[0])
      ?.relations?.[relation];
    return depth < 12 && Boolean(rewrite) &&
      evaluate(rewrite!, user, relation, object, depth + 1);
  };
  const evaluate = (
    rewrite: Rewrite,
    user: string,
    relation: string,
    object: string,
    depth: number,
  ): boolean => {
    if (rewrite.union) {
      return rewrite.union.child.some((child) =>
        evaluate(child, user, relation, object, depth)
      );
    }
    if (rewrite.computedUserset) {
      return allowed(user, rewrite.computedUserset.relation, object, depth);
    }
    if (rewrite.tupleToUserset) {
      const { tupleset, computedUserset } = rewrite.tupleToUserset;
      return tuples.some((tuple) =>
        tuple.object === object && tuple.relation === tupleset.relation &&
        allowed(user, computedUserset.relation, tuple.user, depth)
      );
    }
    return tuples.some((tuple) => {
      if (tuple.object !== object || tuple.relation !== relation) return false;
      if (tuple.user === user) return true;
      const [set, setRelation] = tuple.user.split("#");
      return Boolean(setRelation) && allowed(user, setRelation, set, depth);
    });
  };
  const key = (tuple: Tuple) =>
    `${tuple.user} ${tuple.relation} ${tuple.object}`;
  const server = Deno.serve(
    { hostname: "127.0.0.1", port: 0, onListen() {} },
    async (request) => {
      const url = new URL(request.url);
      const body = request.body ? await request.json() : {};
      if (url.pathname === "/stores") return Response.json({ id: "store" });
      if (url.pathname.endsWith("/authorization-models")) {
        types = body.type_definitions;
        return Response.json({ authorization_model_id: "model" });
      }
      if (url.pathname.endsWith("/write")) {
        writes++;
        // Like OpenFGA, reject the whole write on a duplicate or missing tuple.
        const deleted = (body.deletes?.tuple_keys ?? []).map(key);
        const written = (body.writes?.tuple_keys ?? []) as Tuple[];
        const existing = new Set(tuples.map(key));
        if (
          deleted.some((item: string) => !existing.has(item)) ||
          written.some((tuple) => existing.has(key(tuple)))
        ) return Response.json({ code: "write_failed" }, { status: 400 });
        for (const item of deleted) {
          tuples.splice(tuples.findIndex((tuple) => key(tuple) === item), 1);
        }
        tuples.push(...written);
        return Response.json({});
      }
      if (url.pathname.endsWith("/check")) {
        const { user, relation, object } = body.tuple_key;
        return Response.json({ allowed: allowed(user, relation, object) });
      }
      return new Response("Not found", { status: 404 });
    },
  );
  return { server, tuples, writes: () => writes };
}

async function git(cwd: string, ...args: string[]) {
  const result = await new Deno.Command("git", {
    cwd,
    args,
    stderr: "piped",
  }).output();
  assert.equal(result.success, true, new TextDecoder().decode(result.stderr));
}

class Client {
  cookie = "";
  token = "";
  id = "";
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

  async json(path: string, body?: unknown, method = "POST") {
    const response = await this.request(
      path,
      body === undefined ? {} : { method, body: JSON.stringify(body) },
    );
    assert.ok(response.ok, `${path}: ${await response.clone().text()}`);
    return await response.json();
  }

  async mcp(name: string, args: Record<string, unknown>) {
    const response = await fetch(`${this.base}/api/mcp`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.token}`,
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
    return (await response.json()).result;
  }
}

Deno.test("restricts a source to selected members and groups through OpenFGA alone", async () => {
  const root = await Deno.makeTempDir();
  const origin = `${root}/origin`;
  const fga = modelOpenFga();
  const objects = new Map<string, string>();
  const aiRequests: AIRequest[] = [];
  const app = await createCollabApp({
    dataDir: `${root}/data`,
    authSecret: "source-access-test-secret-with-at-least-32-characters",
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
    repositorySync: (checkout, _url, folder) =>
      syncRepository(checkout, origin, folder),
    aiProvider: "ollama",
    aiModel: "test-model",
    aiResponder(request) {
      aiRequests.push(request);
      return Promise.resolve("Stub answer");
    },
  });
  const server = Deno.serve(
    { hostname: "127.0.0.1", port: 0, onListen() {} },
    app.fetch,
  );
  const base = `http://127.0.0.1:${(server.addr as Deno.NetAddr).port}`;
  const owner = new Client(base);
  const outsider = new Client(base);
  const workspaceEditor = new Client(base);
  const member = new Client(base);
  const groupMember = new Client(base);
  const commit = async (path: string, text: string) => {
    await Deno.mkdir(`${origin}/${path.split("/").slice(0, -1).join("/")}`, {
      recursive: true,
    });
    await Deno.writeTextFile(`${origin}/${path}`, text);
    await git(origin, "add", ".");
    await git(origin, "commit", "-m", `change ${path}`);
  };
  const join = async (
    client: Client,
    email: string,
    invite: Record<string, string>,
  ) => {
    const invitation = await owner.json("/api/invitations", {
      email,
      ...invite,
    });
    const signUp = await client.request("/api/auth/sign-up/email", {
      method: "POST",
      body: JSON.stringify({
        name: email.split("@")[0],
        email,
        password: "password123",
        invitationId: invitation.id,
      }),
    });
    assert.equal(signUp.status, 200, await signUp.text());
    await client.json("/api/invitations/accept", {
      invitationId: invitation.id,
    });
    client.id = (await client.json("/api/auth/get-session")).user.id;
    client.token = (await client.json("/api/developer/keys", {
      name: "MCP",
      scopes: ["*"],
    })).token;
  };
  const secret = "repository/secret";
  // Every discovery surface a reader can reach, reduced to what leaks.
  const surfaces = async (client: Client) => {
    const search = await client.json("/api/search?q=zebracorn");
    const policy = (await client.json("/api/search")).results.find((
      item: { id: string },
    ) => item.id === "public-policy");
    const artifact = (await client.json("/api/search")).results.find((
      item: { id: string },
    ) => item.id === "vault-calculator");
    const [card] = (await client.json("/api/artifact-gallery")).artifacts;
    const imported = await client.request(
      "/api/imported?source=repository&path=secret.md",
    );
    await imported.body?.cancel();
    const mcpGet = await client.mcp("documents.get", { id: secret });
    const mcpSearch = await client.mcp("knowledge.search", {
      query: "zebracorn",
    });
    const ask = await client.json("/api/ai/chat", {
      scope: "workspace",
      messages: [{ role: "user", content: "zebracorn" }],
    });
    const exported = await (await client.request(
      "/api/concepts/vault-calculator/export",
    )).text();
    const sources = await client.json("/api/sources");
    return {
      search: search.results.some((item: { id: string }) => item.id === secret),
      backlink: policy.backlinks.some((item: { id: string }) =>
        item.id === secret
      ),
      link: Boolean(policy.linkTargets["okf://repository/secret.md"]),
      stale: artifact.trust === "stale" &&
        /secret\.md/.test(artifact.trustReason),
      gallery: card.trust === "stale",
      imported: imported.status === 200,
      mcpGet: !mcpGet.isError,
      mcpSearch: JSON.parse(mcpSearch.content[0].text).results.some((
        item: { id: string },
      ) => item.id === secret),
      // The last request is the answer; a search-terms request precedes it.
      ask: aiRequests.at(-1)!.document.markdown.includes("zebracorn") &&
        ask.citations.some((item: { documentId: string }) =>
          item.documentId === secret
        ),
      export: exported.includes("zebracorn"),
      source: sources.repositories.length === 1,
    };
  };
  const visible = {
    search: true,
    backlink: true,
    link: true,
    stale: true,
    gallery: true,
    imported: true,
    mcpGet: true,
    mcpSearch: true,
    ask: true,
    export: false, // Hub exports never inline imported content.
    source: true,
  };
  const hidden = Object.fromEntries(
    Object.keys(visible).map((name) => [name, false]),
  );
  const access = (body: unknown) =>
    owner.json("/api/sources/repository/access", body, "PUT");
  try {
    await Deno.mkdir(origin);
    await git(origin, "init", "--initial-branch=main");
    await git(origin, "config", "user.email", "test@example.com");
    await git(origin, "config", "user.name", "Test");
    await commit("src/vault/key.ts", "export const key = 1;\n");
    await commit(
      "okf/secret.md",
      "---\ntype: Guide\ntitle: Vault runbook\ndescribes: [src/vault/**]\n---\n\nRotate the zebracorn key. See [policy](okf://hub/public-policy).\n",
    );

    await owner.json("/api/auth/sign-up/email", {
      name: "Access owner",
      email: "access-owner@example.com",
      password: "password123",
    });
    await owner.json("/api/setup", { name: "Access", tagline: "Private" });
    owner.token = (await owner.json("/api/developer/keys", {
      name: "MCP",
      scopes: ["*"],
    })).token;
    const group = await owner.json("/api/groups", {
      name: "Vault readers",
      access: "viewer",
    });
    await join(outsider, "outsider@example.com", { access: "viewer" });
    await join(workspaceEditor, "editor@example.com", { access: "editor" });
    await join(member, "member@example.com", { access: "viewer" });
    await join(groupMember, "group@example.com", { teamId: group.id });

    await owner.json("/api/concepts", {
      title: "Public policy",
      type: "Policy",
      spaceId: "policies",
    });
    await owner.json("/api/concepts/public-policy/publish", {
      markdown: "Read the [runbook](okf://repository/secret.md).",
    });
    await owner.json("/api/sources/repositories", {
      repositoryUrl: "https://example.com/company/vault.git",
      folder: "okf",
    });
    await owner.json("/api/concepts", {
      title: "Vault calculator",
      type: "Artifact",
      spaceId: "policies",
    });
    await owner.json("/api/v1/actions/documents.update-draft", {
      id: "vault-calculator",
      markdown:
        "---\ntype: Artifact\nsources:\n  - id: vault\n    resource: secret.md\n---\n\n# Calculator\n",
    });
    await owner.json("/api/concepts/vault-calculator/publish", {});
    await commit("src/vault/key.ts", "export const key = 2;\n");
    await owner.json("/api/sources/repositories/repository/refresh", {});

    // Existing sources stay open to every workspace member.
    assert.deepEqual(await owner.json("/api/sources/repository/access"), {
      mode: "workspace",
      grants: [],
    });
    assert.deepEqual(await surfaces(outsider), visible);

    const viewerAccess = await outsider.request(
      "/api/sources/repository/access",
    );
    assert.equal(viewerAccess.status, 403);
    await viewerAccess.body?.cancel();
    const unknown = await owner.request("/api/sources/repository/access", {
      method: "PUT",
      body: JSON.stringify({
        mode: "restricted",
        grants: [{ type: "user", id: "nobody", role: "viewer" }],
      }),
    });
    assert.equal(unknown.status, 400);
    await unknown.body?.cancel();

    const restricted = {
      mode: "restricted",
      grants: [
        { type: "user", id: member.id, role: "editor" },
        { type: "group", id: group.id, role: "viewer" },
      ],
    };
    await access(restricted);
    const space = "space:imported-repository";
    assert.equal(
      fga.tuples.some((tuple) =>
        tuple.object === space && tuple.relation === "viewer" &&
        tuple.user.endsWith("#member") &&
        tuple.user !== `group:${group.id}#member`
      ),
      false,
      "restricting removes the workspace viewer team",
    );
    assert.deepEqual(await surfaces(outsider), hidden);
    assert.deepEqual(await surfaces(workspaceEditor), hidden);
    assert.deepEqual(await surfaces(member), visible);
    assert.deepEqual(await surfaces(groupMember), visible);
    assert.deepEqual(await surfaces(owner), visible);

    // Source editors may draft OKF and suggest changes; viewers may not.
    const draft = async (client: Client) => {
      const response = await client.request(
        "/api/sources/repositories/repository/okf-draft",
      );
      await response.body?.cancel();
      return response.status;
    };
    assert.equal(await draft(member), 200);
    assert.equal(await draft(groupMember), 403);
    assert.equal(await draft(workspaceEditor), 403);

    const writes = fga.writes();
    const events = (await owner.json("/api/audit")).length;
    await access(restricted);
    assert.equal(fga.writes(), writes, "repeating access writes nothing");
    assert.equal((await owner.json("/api/audit")).length, events);

    await access({ mode: "workspace", grants: [] });
    assert.deepEqual(await surfaces(outsider), visible);
    assert.equal(
      fga.tuples.some((tuple) =>
        tuple.object === space && tuple.user === `user:${member.id}`
      ),
      false,
    );
    await access({ mode: "workspace", grants: [] });
    assert.deepEqual(await owner.json("/api/sources/repository/access"), {
      mode: "workspace",
      grants: [],
    });
    const actions = (await owner.json("/api/audit")).map((
      item: { action: string; target: string },
    ) => `${item.action} ${item.target}`);
    for (
      const expected of [
        "source.access_restricted source:repository",
        `source.access_granted source:repository:user:${member.id}:editor`,
        `source.access_granted source:repository:group:${group.id}:viewer`,
        "source.access_opened source:repository",
        `source.access_revoked source:repository:user:${member.id}:editor`,
      ]
    ) assert.ok(actions.includes(expected), expected);
  } finally {
    await server.shutdown();
    await app.close();
    await fga.server.shutdown();
    await Deno.remove(root, { recursive: true });
  }
});
