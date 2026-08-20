/// <reference lib="deno.ns" />

import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { ArtifactInputError, createArtifactStore } from "./artifact-store.ts";

Deno.test("versions reviewed artifacts and enforces the rendering contract", () => {
  const db = new DatabaseSync(":memory:");
  const store = createArtifactStore(db, ["apps.example.com"]);
  try {
    const created = store.create({
      conceptId: "policy",
      title: "Cost calculator",
      type: "inline_html",
      content:
        "<button onclick=\"document.body.dataset.clicked='yes'\">Run</button><script>document.body.dataset.ready='yes'</script>",
      actorUserId: "editor",
    })!;
    assert.equal(created.status, "draft");
    assert.deepEqual(store.list("policy", false), []);
    assert.match(created.document ?? "", /connect-src 'none'/);
    assert.match(created.document ?? "", /frame-src 'none'/);
    assert.match(created.document ?? "", /form-action 'none'/);
    assert.match(created.document ?? "", /window\.okf=/);
    assert.deepEqual(created.grants, ["app.data.*"]);

    const saved = store.data.set(
      created.id,
      "editor",
      "notes",
      "first",
      { text: "Hi" },
    );
    assert.deepEqual(saved.value, { text: "Hi" });
    assert.match(saved.updatedAt, /^\d{4}-/);
    assert.deepEqual(
      store.data.get(created.id, "editor", "notes", "first")?.value,
      {
        text: "Hi",
      },
    );
    assert.deepEqual(store.data.list(created.id, "viewer", "notes"), []);

    const live = store.publish(created.id, "owner")!;
    assert.equal(live.status, "live");
    assert.equal(live.versions[0].approvedBy, "owner");
    const viewerV1 = store.list("policy", false)[0]!;
    assert.equal(viewerV1.version, 1);
    assert.equal(viewerV1.content, undefined);

    const revised = store.revise(
      created.id,
      "<p>Version two</p>",
      "editor",
    )!;
    assert.equal(revised.status, "changes_pending");
    assert.equal(revised.versions.length, 2);
    assert.equal(store.list("policy", false)[0]!.version, 1);
    assert.match(
      store.publish(created.id, "owner")!.document ?? "",
      /Version two/,
    );

    assert.throws(
      () =>
        store.create({
          conceptId: "policy",
          title: "Unsafe URL",
          type: "https_url",
          content: "https://not-allowed.example/app",
          actorUserId: "editor",
        }),
      ArtifactInputError,
    );
    const url = store.create({
      conceptId: "policy",
      title: "Status dashboard",
      type: "https_url",
      content: "https://apps.example.com/status",
      actorUserId: "editor",
    })!;
    assert.equal(url.url, "https://apps.example.com/status");

    const bundleContent = `okf-bundle-v1:${
      JSON.stringify({
        entry: "index.html",
        files: [
          {
            path: "index.html",
            type: "text/html",
            data: `data:text/html;base64,${
              btoa('<h1>Bundle app</h1><script src="app.js"></script>')
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
    const bundle = store.create({
      conceptId: "policy",
      title: "Bundle app",
      type: "inline_html",
      content: bundleContent,
      actorUserId: "editor",
    })!;
    assert.deepEqual(bundle.bundle, {
      entry: "index.html",
      files: ["index.html", "app.js"],
    });
    assert.equal(bundle.document, undefined);
    assert.equal(store.file(bundle.id, "", false), null);
    store.publish(bundle.id, "owner");
    const entry = store.file(bundle.id, "", false)!;
    assert.equal(entry.type, "text/html; charset=utf-8");
    const entryText = new TextDecoder().decode(entry.body);
    assert.match(entryText, /Bundle app/);
    assert.match(entryText, /connect-src 'none'/);
    assert.match(entryText, /window\.okf=/);
    assert.equal(
      new TextDecoder().decode(store.file(bundle.id, "app.js", false)!.body),
      "document.body.dataset.ready='yes'",
    );
  } finally {
    db.close();
  }
});
