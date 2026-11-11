/// <reference lib="deno.ns" />

import assert from "node:assert/strict";
import { createCollabApp } from "./main.ts";
import { imageReferences, sniffImage } from "./document-images.ts";

const PNG = new Uint8Array([
  0x89,
  0x50,
  0x4e,
  0x47,
  0x0d,
  0x0a,
  0x1a,
  0x0a,
  1,
  2,
  3,
]);

Deno.test("sniffs allowed image types by magic bytes only", () => {
  const ascii = (text: string) => new TextEncoder().encode(text);
  assert.equal(sniffImage(PNG), "png");
  assert.equal(sniffImage(new Uint8Array([0xff, 0xd8, 0xff, 0xe0])), "jpg");
  assert.equal(sniffImage(ascii("GIF89a...")), "gif");
  assert.equal(sniffImage(ascii("RIFF\0\0\0\0WEBPVP8 ")), "webp");
  assert.equal(
    sniffImage(ascii('<svg xmlns="http://www.w3.org/2000/svg">')),
    null,
  );
  assert.equal(sniffImage(ascii("<html><script>")), null);
  assert.equal(sniffImage(ascii("RIFF\0\0\0\0WAVE")), null);
  assert.deepEqual(
    imageReferences(`![a](/api/concepts/doc-1/images/${"a".repeat(64)}.png)`),
    [{
      url: `/api/concepts/doc-1/images/${"a".repeat(64)}.png`,
      conceptId: "doc-1",
      name: `${"a".repeat(64)}.png`,
    }],
  );
});

// Minimal OpenFGA: owners and editors reach everything; viewers reach the
// spaces their group views, and documents through their parent space.
function fakeOpenFga() {
  const tuples: { user: string; relation: string; object: string }[] = [];
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
        tuples.push(...(body.writes?.tuple_keys ?? []));
        return new Response(null, { status: 204 });
      }
      if (url.pathname.endsWith("/check")) {
        const { user, relation, object } = body.tuple_key;
        const subjects = [
          user,
          ...tuples.filter((t) => t.user === user && t.relation === "member")
            .map((t) => `${t.object}#member`),
        ];
        const granted = (name: string, target: string) =>
          tuples.some((t) =>
            t.relation === name && t.object === target &&
            subjects.includes(t.user)
          );
        const space = object.startsWith("space:")
          ? object
          : tuples.find((t) => t.relation === "parent" && t.object === object)
            ?.user;
        return Response.json({
          allowed: granted("owner", "source:company") ||
            granted("editor", "source:company") ||
            (relation === "view" && Boolean(space) &&
              granted("viewer", space!)),
        });
      }
      return new Response("Not found", { status: 404 });
    },
  );
  const revokeViewers = (object: string) => {
    for (let i = tuples.length - 1; i >= 0; i--) {
      if (tuples[i].relation === "viewer" && tuples[i].object === object) {
        tuples.splice(i, 1);
      }
    }
  };
  return { server, revokeViewers };
}

async function archiveEntries(response: Response) {
  const raw = new Uint8Array(await response.arrayBuffer());
  const view = new DataView(raw.buffer);
  const entries = new Map<string, Uint8Array>();
  for (let offset = 0; view.getUint32(offset, true) === 0x04034b50;) {
    const size = view.getUint32(offset + 18, true);
    const nameLength = view.getUint16(offset + 26, true);
    const start = offset + 30 + nameLength + view.getUint16(offset + 28, true);
    entries.set(
      new TextDecoder().decode(
        raw.subarray(offset + 30, offset + 30 + nameLength),
      ),
      new Uint8Array(
        await new Response(
          new Blob([raw.slice(start, start + size)]).stream().pipeThrough(
            new DecompressionStream("deflate-raw"),
          ),
        ).arrayBuffer(),
      ),
    );
    offset = start + size;
  }
  return entries;
}

class Client {
  cookie = "";
  constructor(readonly base: string) {}
  async request(path: string, init: RequestInit = {}) {
    const headers = new Headers(init.headers);
    if (this.cookie) headers.set("cookie", this.cookie);
    if (typeof init.body === "string") {
      headers.set("content-type", "application/json");
    }
    const response = await fetch(`${this.base}${path}`, { ...init, headers });
    const cookie = response.headers.get("set-cookie")?.match(
      /better-auth\.session_token=[^;]+/,
    )?.[0];
    if (cookie) this.cookie = cookie;
    return response;
  }
}

Deno.test("uploads, dedupes, serves and exports document images with document permissions", async () => {
  const dataDir = await Deno.makeTempDir();
  const fga = fakeOpenFga();
  const objects = new Map<string, string>();
  const app = await createCollabApp({
    dataDir,
    authSecret: "a-secure-test-secret-with-at-least-32-characters",
    openfgaURL: `http://127.0.0.1:${(fga.server.addr as Deno.NetAddr).port}`,
    objectStore: {
      put: (key, markdown) => Promise.resolve(void objects.set(key, markdown)),
      get: (key) =>
        objects.has(key)
          ? Promise.resolve(objects.get(key)!)
          : Promise.reject(new Error("Object not found")),
      remove: (key) => Promise.resolve(void objects.delete(key)),
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
  try {
    const signUp = async (
      client: Client,
      name: string,
      invitationId?: string,
    ) => {
      const response = await client.request("/api/auth/sign-up/email", {
        method: "POST",
        body: JSON.stringify({
          name,
          email: `${name}@images.example`,
          password: "password123",
          invitationId,
        }),
      });
      assert.equal(response.status, 200, await response.text());
    };
    await signUp(owner, "owner");
    assert.equal(
      (await owner.request("/api/setup", {
        method: "POST",
        body: JSON.stringify({ name: "Images" }),
      })).status,
      200,
    );
    const invitation = await owner.request("/api/invitations", {
      method: "POST",
      body: JSON.stringify({
        email: "viewer@images.example",
        access: "viewer",
      }),
    });
    const invitationId = (await invitation.json()).id;
    await signUp(viewer, "viewer", invitationId);
    assert.equal(
      (await viewer.request("/api/invitations/accept", {
        method: "POST",
        body: JSON.stringify({ invitationId }),
      })).status,
      200,
    );
    const spaceResponse = await owner.request("/api/spaces", {
      method: "POST",
      body: JSON.stringify({ name: "Secret" }),
    });
    assert.equal(spaceResponse.status, 201, await spaceResponse.clone().text());
    const secretSpace = await spaceResponse.json();
    // The viewer may read Policies but not this space.
    fga.revokeViewers(`space:${secretSpace.id}`);
    const create = async (title: string, spaceId: string) => {
      const response = await owner.request("/api/concepts", {
        method: "POST",
        body: JSON.stringify({ title, type: "Guide", spaceId }),
      });
      assert.equal(response.status, 201, await response.clone().text());
      return (await response.json()).id as string;
    };
    const docId = await create("Diagram guide", "policies");
    const secretId = await create("Secret guide", secretSpace.id);
    const upload = (client: Client, id: string, body: Uint8Array) =>
      client.request(`/api/concepts/${id}/images`, {
        method: "POST",
        body: body as BodyInit,
        headers: { "content-type": "image/png" },
      });

    const first = await upload(owner, docId, PNG);
    assert.equal(first.status, 201, await first.clone().text());
    const { url } = await first.json();
    assert.match(
      url,
      new RegExp(`^/api/concepts/${docId}/images/[0-9a-f]{64}\\.png$`),
    );
    const again = await (await upload(owner, docId, PNG)).json();
    assert.equal(again.url, url);
    assert.equal(
      Array.from(Deno.readDirSync(`${dataDir}/images/${docId}`)).length,
      1,
    );

    const svg = await upload(
      owner,
      docId,
      new TextEncoder().encode("<svg onload=alert(1)></svg>"),
    );
    assert.equal(svg.status, 415);
    assert.match((await svg.json()).error, /PNG, JPEG, GIF or WebP/);
    const huge = new Uint8Array(10 * 1024 * 1024 + 1);
    huge.set(PNG);
    const tooLarge = await upload(owner, docId, huge);
    assert.equal(tooLarge.status, 413);
    assert.match((await tooLarge.json()).error, /10 MiB/);
    const denied = await upload(viewer, docId, PNG);
    assert.equal(denied.status, 403);
    await denied.body?.cancel();
    const anonymous = await new Client(base).request(url);
    assert.equal(anonymous.status, 401);
    await anonymous.body?.cancel();

    const served = await viewer.request(url);
    assert.equal(served.status, 200);
    assert.equal(served.headers.get("content-type"), "image/png");
    assert.equal(served.headers.get("x-content-type-options"), "nosniff");
    assert.match(served.headers.get("cache-control") ?? "", /immutable/);
    assert.match(served.headers.get("cache-control") ?? "", /private/);
    assert.match(
      served.headers.get("content-security-policy") ?? "",
      /default-src 'none'; sandbox/,
    );
    assert.deepEqual(new Uint8Array(await served.arrayBuffer()), PNG);
    const missing = await viewer.request(
      url.replace(/[0-9a-f]{64}/, "b".repeat(64)),
    );
    assert.equal(missing.status, 404);
    await missing.body?.cancel();

    // Agents: API key upload through the action, then raw read with the key.
    const keyFor = async (scopes: string[]) => {
      const response = await owner.request("/api/developer/keys", {
        method: "POST",
        body: JSON.stringify({ name: scopes.join(" "), scopes }),
      });
      assert.equal(response.status, 201, await response.clone().text());
      return { authorization: `Bearer ${(await response.json()).token}` };
    };
    const agent = await keyFor(["documents.images.upload", "documents.get"]);
    const action = await fetch(
      `${base}/api/v1/actions/documents.images.upload`,
      {
        method: "POST",
        headers: { ...agent, "content-type": "application/json" },
        body: JSON.stringify({
          id: docId,
          alt: "Flow [v2]",
          base64: `data:image/png;base64,${btoa(String.fromCharCode(...PNG))}`,
        }),
      },
    );
    assert.equal(action.status, 200, await action.clone().text());
    const uploaded = (await action.json()).result;
    assert.equal(uploaded.url, url);
    assert.equal(uploaded.markdown, `![Flow  v2](${url})`);
    const viaKey = await fetch(`${base}${url}`, { headers: agent });
    assert.deepEqual(new Uint8Array(await viaKey.arrayBuffer()), PNG);
    const readOnly = await keyFor(["documents.list"]);
    const scoped = await fetch(`${base}${url}`, { headers: readOnly });
    assert.equal(scoped.status, 403);
    await scoped.body?.cancel();
    const badBase64 = await fetch(
      `${base}/api/v1/actions/documents.images.upload`,
      {
        method: "POST",
        headers: { ...agent, "content-type": "application/json" },
        body: JSON.stringify({ id: docId, base64: "!!!" }),
      },
    );
    assert.equal(badBase64.status, 400);
    await badBase64.body?.cancel();

    const secret = await (await upload(owner, secretId, PNG)).json();
    const blocked = await viewer.request(secret.url);
    assert.equal(blocked.status, 404);
    await blocked.body?.cancel();

    const saved = await owner.request(`/api/concepts/${docId}`, {
      method: "PUT",
      body: `# Diagram guide\n\n![Flow diagram](${url})\n`,
    });
    assert.equal(saved.status, 204, await saved.text());
    const archive = await owner.request("/api/exports/workspace");
    assert.equal(archive.status, 200);
    const entries = await archiveEntries(archive);
    const imagePath = `images/${docId}/${url.split("/").pop()}`;
    assert.deepEqual(entries.get(imagePath), PNG);
    assert.ok(
      ![...entries.keys()].some((path) => path.includes(secretId + "/")),
    );
    const exported = [...entries].find(([path]) =>
      path.startsWith("okf/") && path.endsWith("/Diagram guide.md")
    );
    assert.ok(exported, [...entries.keys()].join(", "));
    assert.ok(
      new TextDecoder().decode(exported[1]).includes(
        `![Flow diagram](${
          "../".repeat(exported[0].split("/").length - 1)
        }${imagePath})`,
      ),
    );
  } finally {
    await server.shutdown();
    await fga.server.shutdown();
    await app.close();
    await Deno.remove(dataDir, { recursive: true });
  }
});
