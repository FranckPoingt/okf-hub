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
  } finally {
    db.close();
  }
});
