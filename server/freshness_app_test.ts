/// <reference lib="deno.ns" />

import assert from "node:assert/strict";
import { createCollabApp } from "./main.ts";
import { syncRepository } from "./repository-source.ts";

async function git(cwd: string, ...args: string[]) {
  const result = await new Deno.Command("git", {
    cwd,
    args,
    stderr: "piped",
  }).output();
  assert.equal(result.success, true, new TextDecoder().decode(result.stderr));
}

Deno.test("cascades stale imported knowledge to dependent artifacts, never on failed syncs", async () => {
  const root = await Deno.makeTempDir();
  const origin = `${root}/origin`;
  // A single owner is allowed everything, so this OpenFGA stub only answers yes.
  const fga = Deno.serve(
    { hostname: "127.0.0.1", port: 0, onListen() {} },
    async (request) => {
      await request.body?.cancel();
      const path = new URL(request.url).pathname;
      return path === "/stores"
        ? Response.json({ id: "store" })
        : path.endsWith("/authorization-models")
        ? Response.json({ authorization_model_id: "model" })
        : path.endsWith("/check")
        ? Response.json({ allowed: true })
        : new Response(null, { status: 204 });
    },
  );
  let failSync = false;
  const objects = new Map<string, string>();
  const app = await createCollabApp({
    dataDir: `${root}/data`,
    authSecret: "freshness-test-secret-with-at-least-32-characters",
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
    automationIntervalMs: 0,
    repositorySync: (checkout, _url, folder) =>
      failSync
        ? Promise.reject(new Error("Network unavailable"))
        : syncRepository(checkout, origin, folder),
  });
  const server = Deno.serve(
    { hostname: "127.0.0.1", port: 0, onListen() {} },
    app.fetch,
  );
  const base = `http://127.0.0.1:${(server.addr as Deno.NetAddr).port}`;
  let cookie = "";
  const request = async (path: string, body?: unknown) => {
    const response = await fetch(`${base}${path}`, {
      method: body ? "POST" : "GET",
      headers: {
        ...cookie ? { cookie } : {},
        "content-type": "application/json",
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    cookie = response.headers.get("set-cookie")?.match(
      /better-auth\.session_token=[^;]+/,
    )?.[0] ?? cookie;
    return response;
  };
  const json = async (path: string, body?: unknown) => {
    const response = await request(path, body);
    assert.ok(response.ok, await response.clone().text());
    return await response.json();
  };
  const commit = async (path: string, text: string) => {
    await Deno.mkdir(`${origin}/${path.split("/").slice(0, -1).join("/")}`, {
      recursive: true,
    });
    await Deno.writeTextFile(`${origin}/${path}`, text);
    await git(origin, "add", ".");
    await git(origin, "commit", "-m", `change ${path}`);
  };
  const billing = () => json("/api/imported?source=repository&path=billing.md");
  try {
    await Deno.mkdir(origin);
    await git(origin, "init", "--initial-branch=main");
    await git(origin, "config", "user.email", "test@example.com");
    await git(origin, "config", "user.name", "Test");
    await commit("CODEOWNERS", "/okf/ @org/docs\n/src/billing/ @org/billing\n");
    await commit("src/billing/tax.ts", "export const rate = 1;\n");
    await commit(
      "okf/billing.md",
      "---\ntype: Guide\ntitle: Billing rules\ndescribes: [src/billing/**]\n---\n\n# Billing\n",
    );

    await json("/api/auth/sign-up/email", {
      name: "Fresh owner",
      email: "fresh-owner@example.com",
      password: "password123",
    });
    await json("/api/setup", { name: "Freshness", tagline: "Current" });
    await json("/api/sources/repositories", {
      repositoryUrl: "https://example.com/company/knowledge.git",
      folder: "okf",
    });
    const imported = await billing();
    assert.equal(imported.owner, "@org/docs");
    assert.deepEqual(imported.describedOwners, ["@org/billing"]);
    assert.equal(imported.stale, null);

    const artifact = await json("/api/concepts", {
      title: "Billing calculator",
      type: "Artifact",
    });
    await json("/api/v1/actions/documents.update-draft", {
      id: artifact.id,
      markdown:
        "---\ntype: Artifact\nsources:\n  - id: billing\n    resource: billing.md\n---\n\n# Calculator\n",
    });
    // A reviewed publication must still surface dependency staleness.
    await json(`/api/concepts/${artifact.id}/publish`, {});
    await json(`/api/concepts/${artifact.id}/review`, { publishedRevision: 1 });

    await commit("src/billing/tax.ts", "export const rate = 2;\n");
    failSync = true;
    const failed = await request(
      "/api/sources/repositories/repository/refresh",
      {},
    );
    assert.equal(failed.ok, false);
    await failed.body?.cancel();
    assert.equal((await billing()).stale, null);

    failSync = false;
    await json("/api/sources/repositories/repository/refresh", {});
    const stale = await billing();
    assert.deepEqual(stale.stale.paths, ["src/billing/tax.ts"]);

    const search = await json("/api/search?q=billing");
    const result = (id: string) =>
      search.results.find((item: { id: string }) => item.id === id);
    assert.equal(result(stale.id).trust, "stale");
    assert.match(result(stale.id).trustReason, /src\/billing\/tax\.ts/);
    assert.equal(result(artifact.id).trust, "stale");
    assert.match(result(artifact.id).trustReason, /^Depends on billing\.md: /);
    assert.equal(result(artifact.id).freshness.status, "current");
    // Home "Needs attention" reads dependency staleness from the concept list.
    const listed = (await json("/api/concepts")).find((item: { id: string }) =>
      item.id === artifact.id
    );
    assert.equal(listed.trust, "stale");
    assert.match(listed.trustReason, /^Depends on billing\.md: /);
    assert.equal(listed.freshness.status, "current");
    const [card] = (await json("/api/artifact-gallery")).artifacts;
    assert.equal(card.id, artifact.id);
    assert.equal(card.trust, "stale");
    assert.match(card.trustReason, /^Depends on billing\.md: /);
    assert.equal(card.freshness.status, "current");

    const document = (await json("/api/v1/actions/documents.get", {
      id: artifact.id,
    })).result;
    assert.equal(document.trust, "stale");
    assert.equal(document.owner, "Fresh owner");
    assert.equal(
      (await json("/api/v1/actions/documents.get", { id: stale.id })).result
        .trust,
      "stale",
    );

    const metadata = async (sources: string[]) => {
      const response = await fetch(
        `${base}/api/concepts/${artifact.id}/metadata`,
        {
          method: "PUT",
          headers: { cookie, "content-type": "application/json" },
          body: JSON.stringify({
            title: artifact.title,
            type: artifact.type,
            spaceId: artifact.spaceId,
            sources,
          }),
        },
      );
      assert.equal(response.status, 200);
      await response.body?.cancel();
    };
    await metadata([]);
    assert.equal((await json(`/api/concepts/${artifact.id}`)).trust, "current");
    await metadata(["billing.md"]);
    assert.equal((await json(`/api/concepts/${artifact.id}`)).trust, "stale");
    await commit(
      "okf/billing.md",
      "---\ntype: Guide\ntitle: Billing rules\ndescribes: [src/billing/**]\n---\n\n# Billing v2\n",
    );
    await json("/api/sources/repositories/repository/refresh", {});
    assert.equal((await billing()).stale, null);
    assert.equal(
      (await json(`/api/concepts/${artifact.id}`)).trust,
      "current",
    );
  } finally {
    await server.shutdown();
    await app.close();
    await fga.shutdown();
    await Deno.remove(root, { recursive: true });
  }
});
